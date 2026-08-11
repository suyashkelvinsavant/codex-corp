use chrono::{Datelike, Timelike, Utc};
use chrono_tz::Tz;
use rusqlite::params;
use serde_json::json;
use std::time::Duration;
use tauri::{Emitter, Manager};

use super::{
    database_guard_for, poison_aware_lock, start_run, RunApprovalBroker, RuntimeGraph,
    WorkflowRuntime,
};
use crate::{ApprovalBroker, Database, ProcessBroker, TurnStdinBroker};

#[derive(Debug, Clone)]
pub(super) struct DueSchedule {
    pub(super) workflow_id: String,
    pub(super) node_id: String,
    pub(super) minute_key: String,
    pub(super) workspace_path: Option<String>,
}

fn cron_field_matches(value: u32, field: &str, min: u32, max: u32) -> bool {
    field.split(',').any(|part| {
        let mut stepped = part.split('/');
        let base = stepped.next().unwrap_or_default();
        let step = stepped
            .next()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(1);
        if step == 0 || stepped.next().is_some() {
            return false;
        }
        let (start, end) = if base == "*" {
            (min, max)
        } else {
            let mut range = base.split('-');
            let Some(start) = range.next().and_then(|raw| raw.parse::<u32>().ok()) else {
                return false;
            };
            let end = match range.next() {
                Some(raw) => match raw.parse::<u32>() {
                    Ok(value) => value,
                    Err(_) => return false,
                },
                None => start,
            };
            if range.next().is_some() {
                return false;
            }
            (start, end)
        };
        start >= min
            && end <= max
            && start <= end
            && value >= start
            && value <= end
            && (value - start).is_multiple_of(step)
    })
}

pub(super) fn cron_matches_at(
    expression: &str,
    timezone: &str,
    now: chrono::DateTime<Utc>,
) -> Option<String> {
    let timezone: Tz = timezone.parse().ok()?;
    let local = now.with_timezone(&timezone);
    let fields: Vec<_> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return None;
    }
    let values = [
        local.minute(),
        local.hour(),
        local.day(),
        local.month(),
        local.weekday().num_days_from_sunday(),
    ];
    let limits = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
    fields
        .iter()
        .enumerate()
        .all(|(index, field)| {
            let (min, max) = limits[index];
            cron_field_matches(values[index], field, min, max)
        })
        .then(|| local.format("%Y-%m-%dT%H:%M%:z").to_string())
}

pub(super) fn due_schedules(app: &tauri::AppHandle) -> Result<Vec<DueSchedule>, String> {
    let workflows = {
        let database = app.state::<Database>();
        let connection = database_guard_for(&database);
        let mut statement = connection
            .prepare("SELECT id,graph_json,workspace_path FROM workflows ORDER BY id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let now = Utc::now();
    let mut due = Vec::new();
    for (workflow_id, graph_json, workspace_path) in workflows {
        let Ok(graph) = serde_json::from_str::<RuntimeGraph>(&graph_json) else {
            continue;
        };
        for node in graph
            .nodes
            .iter()
            .filter(|node| node.data.kind == "cron" && node.data.cron_enabled)
        {
            let expression = node.data.cron_expression.as_deref().unwrap_or_default();
            let timezone = node.data.cron_timezone.as_deref().unwrap_or("UTC");
            if let Some(minute_key) = cron_matches_at(expression, timezone, now) {
                due.push(DueSchedule {
                    workflow_id: workflow_id.clone(),
                    node_id: node.id.clone(),
                    minute_key,
                    workspace_path: workspace_path.clone(),
                });
            }
        }
    }
    Ok(due)
}

pub(super) fn reserve_schedule_firing(
    app: &tauri::AppHandle,
    schedule: &DueSchedule,
) -> Result<bool, String> {
    let database = app.state::<Database>();
    let connection = database_guard_for(&database);
    connection
        .execute(
            "INSERT OR IGNORE INTO schedule_firings(workflow_id,node_id,minute_key) VALUES(?1,?2,?3)",
            params![schedule.workflow_id, schedule.node_id, schedule.minute_key],
        )
        .map(|changed| changed == 1)
        .map_err(|error| error.to_string())
}

pub(super) fn release_schedule_firing(app: &tauri::AppHandle, schedule: &DueSchedule) {
    let database = app.state::<Database>();
    let connection = database_guard_for(&database);
    let _ = connection.execute(
        "DELETE FROM schedule_firings WHERE workflow_id=?1 AND node_id=?2 AND minute_key=?3",
        params![schedule.workflow_id, schedule.node_id, schedule.minute_key],
    );
}

pub(super) fn workflow_is_active(app: &tauri::AppHandle, workflow_id: &str) -> bool {
    let runtime = app.state::<WorkflowRuntime>();
    let active = poison_aware_lock(&runtime.active, "runtime active", None);
    active.values().any(|run| run.workflow_id == workflow_id)
}

pub(super) fn scheduler_tick(app: &tauri::AppHandle) {
    let Ok(schedules) = due_schedules(app) else {
        return;
    };
    for schedule in schedules {
        if workflow_is_active(app, &schedule.workflow_id) {
            continue;
        }
        if !reserve_schedule_firing(app, &schedule).unwrap_or(false) {
            continue;
        }
        let result = tauri::async_runtime::block_on(start_run(
            schedule.workflow_id.clone(),
            Some(schedule.node_id.clone()),
            schedule.workspace_path.clone(),
            app.clone(),
            app.state::<WorkflowRuntime>(),
            app.state::<RunApprovalBroker>(),
            app.state::<ApprovalBroker>(),
            app.state::<ProcessBroker>(),
            app.state::<TurnStdinBroker>(),
            app.state::<Database>(),
        ));
        if let Err(error) = result {
            release_schedule_firing(app, &schedule);
            let _ = app.emit(
                "workflow-schedule-error",
                json!({
                    "workflowId": schedule.workflow_id,
                    "nodeId": schedule.node_id,
                    "message": error,
                }),
            );
        }
    }
}

pub(super) fn start_scheduler(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("codex-corp-scheduler".into())
        .spawn(move || loop {
            scheduler_tick(&app);
            std::thread::sleep(Duration::from_secs(15));
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn cron_field_matches_wildcard() {
        assert!(cron_field_matches(30, "*", 0, 59));
    }

    #[test]
    fn cron_field_matches_exact_value() {
        assert!(cron_field_matches(5, "5", 0, 59));
        assert!(!cron_field_matches(6, "5", 0, 59));
    }

    #[test]
    fn cron_field_matches_range() {
        assert!(cron_field_matches(10, "5-15", 0, 59));
        assert!(!cron_field_matches(16, "5-15", 0, 59));
    }

    #[test]
    fn cron_field_matches_step() {
        assert!(cron_field_matches(0, "*/15", 0, 59));
        assert!(cron_field_matches(15, "*/15", 0, 59));
        assert!(cron_field_matches(30, "*/15", 0, 59));
        assert!(cron_field_matches(45, "*/15", 0, 59));
        assert!(!cron_field_matches(7, "*/15", 0, 59));
    }

    #[test]
    fn cron_field_matches_list() {
        assert!(cron_field_matches(5, "5,10,15", 0, 59));
        assert!(cron_field_matches(10, "5,10,15", 0, 59));
        assert!(!cron_field_matches(7, "5,10,15", 0, 59));
    }

    #[test]
    fn cron_field_matches_rejects_zero_step() {
        assert!(!cron_field_matches(5, "*/0", 0, 59));
    }

    #[test]
    fn cron_field_matches_rejects_out_of_range() {
        assert!(!cron_field_matches(25, "0-5", 0, 59));
    }

    #[test]
    fn cron_matches_at_honors_timezone() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 4, 30, 0).unwrap();
        assert_eq!(
            cron_matches_at("0 10 * * 5", "Asia/Kolkata", now),
            Some("2026-07-17T10:00+05:30".into())
        );
    }

    #[test]
    fn cron_matches_at_rejects_bad_timezone() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 4, 30, 0).unwrap();
        assert!(cron_matches_at("0 10 * * 5", "Not/A_Timezone", now).is_none());
    }

    #[test]
    fn cron_matches_at_rejects_wrong_field_count() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 4, 30, 0).unwrap();
        assert!(cron_matches_at("0 10 * *", "UTC", now).is_none());
        assert!(cron_matches_at("0 10 * * 5 0", "UTC", now).is_none());
    }

    #[test]
    fn cron_matches_at_supports_lists_ranges_and_steps() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 10, 30, 0).unwrap();
        assert!(cron_matches_at("*/15 9-17 * * 1-5", "UTC", now).is_some());
        assert!(cron_matches_at("0,30 9-17 * * 1-5", "UTC", now).is_some());
        assert!(cron_matches_at("*/20 9-17 * * 1-5", "UTC", now).is_none());
    }
}
