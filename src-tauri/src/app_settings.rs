use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Manager;

use crate::{app_data_dir, Database};
const SETTINGS_KEY: &str = "runtime";

fn default_cost_rate() -> f64 {
    0.01
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    pub retention_mode: String,
    pub retention_days: u32,
    pub max_detailed_runs: u32,
    pub max_concurrent_codex_processes: u32,
    #[serde(default = "default_cost_rate")]
    pub cost_per_1k_tokens_usd: f64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            retention_mode: "bounded".into(),
            retention_days: 30,
            max_detailed_runs: 100,
            max_concurrent_codex_processes: 8,
            cost_per_1k_tokens_usd: 0.01,
        }
    }
}

impl AppSettings {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.retention_mode != "bounded" && self.retention_mode != "forever" {
            return Err("retentionMode must be bounded or forever".into());
        }
        if !(1..=3650).contains(&self.retention_days) {
            return Err("retentionDays must be between 1 and 3650".into());
        }
        if !(10..=10_000).contains(&self.max_detailed_runs) {
            return Err("maxDetailedRuns must be between 10 and 10000".into());
        }
        if !(1..=16).contains(&self.max_concurrent_codex_processes) {
            return Err("maxConcurrentCodexProcesses must be between 1 and 16".into());
        }
        if self.cost_per_1k_tokens_usd < 0.0 || self.cost_per_1k_tokens_usd > 10.0 {
            return Err("costPer1kTokensUsd must be between 0.0 and 10.0".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionPreview {
    pub affected_run_ids: Vec<String>,
    pub affected_runs: usize,
    pub detailed_bytes: u64,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageInfo {
    pub detailed_bytes: u64,
    pub database_bytes: u64,
    pub database_path: String,
    pub data_directory: String,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS run_checkpoints (
                run_id TEXT PRIMARY KEY,
                checkpoint_json TEXT NOT NULL,
                resumable INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS node_attempts (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                thread_id TEXT,
                turn_id TEXT,
                diagnostics_json TEXT NOT NULL DEFAULT '{}',
                started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
            CREATE INDEX IF NOT EXISTS idx_node_attempts_run_id ON node_attempts(run_id);",
        )
        .map_err(|error| error.to_string())?;
    for statement in [
        "ALTER TABLE runs ADD COLUMN terminal_reason TEXT",
        "ALTER TABLE runs ADD COLUMN runtime_version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE runs ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN resumable INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE run_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE run_events ADD COLUMN level TEXT NOT NULL DEFAULT 'info'",
        "ALTER TABLE run_events ADD COLUMN attempt_id TEXT",
    ] {
        let _ = connection.execute(statement, []);
    }
    let defaults = serde_json::to_string(&AppSettings::default()).map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO app_settings (key,value_json) VALUES (?1,?2)",
            params![SETTINGS_KEY, defaults],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn load(connection: &Connection) -> Result<AppSettings, String> {
    let raw: String = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key=?1",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let settings: AppSettings = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    settings.validate()?;
    Ok(settings)
}

fn affected_run_ids(
    connection: &Connection,
    settings: &AppSettings,
) -> Result<Vec<String>, String> {
    settings.validate()?;
    if settings.retention_mode == "forever" {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "WITH ranked AS (
                SELECT id, created_at,
                       ROW_NUMBER() OVER (ORDER BY datetime(created_at) DESC, id DESC) AS rank
                FROM runs
                WHERE pinned=0 AND (
                    EXISTS(SELECT 1 FROM run_events WHERE run_id=runs.id)
                    OR EXISTS(SELECT 1 FROM node_attempts WHERE run_id=runs.id)
                    OR EXISTS(SELECT 1 FROM run_checkpoints WHERE run_id=runs.id)
                )
            )
            SELECT id FROM ranked
            WHERE datetime(created_at) < datetime('now', ?1)
               OR rank > ?2
            ORDER BY datetime(created_at) ASC",
        )
        .map_err(|error| error.to_string())?;
    let age = format!("-{} days", settings.retention_days);
    let rows = statement
        .query_map(params![age, settings.max_detailed_runs], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn detailed_bytes(connection: &Connection) -> Result<u64, String> {
    let sql = "SELECT
        COALESCE((SELECT SUM(LENGTH(payload_json)) FROM run_events),0) +
        COALESCE((SELECT SUM(LENGTH(diagnostics_json)) FROM node_attempts),0) +
        COALESCE((SELECT SUM(LENGTH(checkpoint_json)) FROM run_checkpoints),0)";
    let bytes: i64 = connection
        .query_row(sql, [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(bytes.max(0) as u64)
}

pub(crate) fn preview(
    connection: &Connection,
    settings: AppSettings,
) -> Result<RetentionPreview, String> {
    let ids = affected_run_ids(connection, &settings)?;
    Ok(RetentionPreview {
        affected_runs: ids.len(),
        affected_run_ids: ids,
        detailed_bytes: detailed_bytes(connection)?,
        settings,
    })
}

pub(crate) fn cleanup(
    connection: &mut Connection,
    settings: &AppSettings,
) -> Result<usize, String> {
    let ids = affected_run_ids(connection, settings)?;
    if ids.is_empty() {
        return Ok(0);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for run_id in &ids {
        transaction
            .execute("DELETE FROM run_events WHERE run_id=?1", params![run_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM node_attempts WHERE run_id=?1", params![run_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM run_checkpoints WHERE run_id=?1",
                params![run_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ids.len())
}

#[tauri::command]
pub(crate) fn get_app_settings(
    database: tauri::State<'_, Database>,
) -> Result<AppSettings, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    load(&connection)
}

#[tauri::command]
pub(crate) fn preview_retention(
    settings: AppSettings,
    database: tauri::State<'_, Database>,
) -> Result<RetentionPreview, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    preview(&connection, settings)
}

#[tauri::command]
pub(crate) fn save_app_settings(
    settings: AppSettings,
    confirm_cleanup: bool,
    database: tauri::State<'_, Database>,
) -> Result<RetentionPreview, String> {
    settings.validate()?;
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let result = preview(&connection, settings.clone())?;
    if result.affected_runs > 0 && !confirm_cleanup {
        return Err(format!(
            "RETENTION_CONFIRMATION_REQUIRED:{}",
            serde_json::to_string(&result).map_err(|error| error.to_string())?
        ));
    }
    let encoded = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP",
            params![SETTINGS_KEY, encoded],
        )
        .map_err(|error| error.to_string())?;
    if confirm_cleanup {
        cleanup(&mut connection, &settings)?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn cleanup_detailed_logs(database: tauri::State<'_, Database>) -> Result<usize, String> {
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let settings = load(&connection)?;
    cleanup(&mut connection, &settings)
}

#[tauri::command]
pub(crate) fn get_storage_info(
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> Result<StorageInfo, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let data = app_data_dir();
    let database_path = data.join("codex-corp.sqlite");
    let database_bytes = std::fs::metadata(&database_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let _ = app.path().app_local_data_dir();
    Ok(StorageInfo {
        detailed_bytes: detailed_bytes(&connection)?,
        database_bytes,
        database_path: database_path.display().to_string(),
        data_directory: data.display().to_string(),
    })
}

#[tauri::command]
pub(crate) fn pin_run(
    run_id: String,
    pinned: bool,
    database: tauri::State<'_, Database>,
) -> Result<(), String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let changed = connection
        .execute(
            "UPDATE runs SET pinned=?2 WHERE id=?1",
            params![run_id, pinned as i32],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("run not found".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn export_detailed_logs(database: tauri::State<'_, Database>) -> Result<String, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let mut runs_statement = connection
        .prepare("SELECT id,workflow_id,status,created_at,pinned,terminal_reason FROM runs ORDER BY datetime(created_at) DESC")
        .map_err(|error| error.to_string())?;
    let runs = runs_statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "workflowId": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "createdAt": row.get::<_, String>(3)?,
                "pinned": row.get::<_, i64>(4)? != 0,
                "terminalReason": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut events_statement = connection
        .prepare("SELECT run_id,node_id,event_type,level,sequence,payload_json,created_at FROM run_events ORDER BY run_id,sequence,id")
        .map_err(|error| error.to_string())?;
    let events = events_statement
        .query_map([], |row| {
            let payload: String = row.get(5)?;
            Ok(serde_json::json!({
                "runId": row.get::<_, String>(0)?,
                "nodeId": row.get::<_, Option<String>>(1)?,
                "type": row.get::<_, String>(2)?,
                "level": row.get::<_, String>(3)?,
                "sequence": row.get::<_, i64>(4)?,
                "payload": serde_json::from_str::<serde_json::Value>(&payload).unwrap_or(serde_json::Value::Null),
                "createdAt": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    serde_json::to_string_pretty(&serde_json::json!({
        "schemaVersion": "codex-corp.logs.v1",
        "exportedAtUnix": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "runs": runs,
        "events": events,
    }))
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn clear_all_company_data(database: tauri::State<'_, Database>) -> Result<(), String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    connection
        .execute_batch(
            "DELETE FROM artifacts;
             DELETE FROM approvals;
             DELETE FROM node_executions;
             DELETE FROM node_attempts;
             DELETE FROM run_checkpoints;
             DELETE FROM run_events;
             DELETE FROM schedule_firings;
             DELETE FROM runs;
             DELETE FROM chat_stores;
             DELETE FROM dashboard_feedback;
             DELETE FROM finance_entries;
             DELETE FROM workflows;",
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    clear_directory(&app_data_dir().join("workspaces"))?;
    Ok(())
}

pub(crate) fn clear_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retention_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE runs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE run_events(id INTEGER PRIMARY KEY,run_id TEXT,node_id TEXT,event_type TEXT,payload_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);",
            )
            .unwrap();
        initialize(&connection).unwrap();
        connection
    }

    #[test]
    fn settings_defaults_and_validation_are_bounded() {
        let defaults = AppSettings::default();
        assert_eq!(defaults.retention_days, 30);
        assert_eq!(defaults.max_detailed_runs, 100);
        assert_eq!(defaults.max_concurrent_codex_processes, 8);
        assert!(defaults.validate().is_ok());
        let mut invalid = defaults;
        invalid.max_concurrent_codex_processes = 17;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn forever_mode_never_selects_runs() {
        let connection = Connection::open_in_memory().unwrap();
        crate::initialize_database(&connection).unwrap();
        connection.execute("INSERT INTO runs(id,workflow_id,status,events_json,created_at) VALUES('old','w','completed','[]','2000-01-01')", []).unwrap();
        let settings = AppSettings {
            retention_mode: "forever".into(),
            ..AppSettings::default()
        };
        assert!(affected_run_ids(&connection, &settings).unwrap().is_empty());
    }

    #[test]
    fn bounded_retention_uses_age_or_count_and_exempts_pins() {
        let connection = retention_database();
        for index in 0..12 {
            let run_id = format!("run-{index}");
            connection
                .execute(
                    "INSERT INTO runs(id,created_at,pinned) VALUES(?1,datetime('now',?2),?3)",
                    params![
                        run_id,
                        format!("-{} days", index),
                        if index == 11 { 1 } else { 0 }
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO run_events(run_id,event_type,payload_json) VALUES(?1,'run.completed','{}')",
                    params![run_id],
                )
                .unwrap();
        }
        let settings = AppSettings {
            retention_days: 5,
            max_detailed_runs: 10,
            ..AppSettings::default()
        };
        let affected = affected_run_ids(&connection, &settings).unwrap();
        assert!(affected.contains(&"run-6".to_string()));
        assert!(!affected.contains(&"run-11".to_string()));
        assert!(!affected.contains(&"run-0".to_string()));
    }

    #[test]
    fn cleanup_removes_details_but_preserves_run_summaries() {
        let mut connection = retention_database();
        connection
            .execute(
                "INSERT INTO runs(id,created_at) VALUES('old',datetime('now','-40 days'))",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO run_events(run_id,event_type,payload_json) VALUES('old','node.failed','{}')",[]).unwrap();
        connection.execute("INSERT INTO node_attempts(id,run_id,node_id,attempt,status) VALUES('a','old','n',0,'failed')",[]).unwrap();
        connection
            .execute(
                "INSERT INTO run_checkpoints(run_id,checkpoint_json) VALUES('old','{}')",
                [],
            )
            .unwrap();
        let cleaned = cleanup(&mut connection, &AppSettings::default()).unwrap();
        assert_eq!(cleaned, 1);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM runs WHERE id='old'", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM run_events WHERE run_id='old'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM node_attempts WHERE run_id='old'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(affected_run_ids(&connection, &AppSettings::default())
            .unwrap()
            .is_empty());
    }
}
