use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;

use super::{database_guard, RunContext, RuntimeNode};

/// Durable record of how a node pattern (role/model/effort) has behaved in
/// past runs. Drives inline self-improvement and is exposed to the editor and
/// workflow chat for longer-loop learning.
#[derive(Debug, Clone)]
pub(super) struct NodeExperience {
    pub(super) node_id: String,
    pub(super) workflow_id: String,
    pub(super) role: String,
    pub(super) model: String,
    pub(super) effort: String,
    pub(super) failure_class: Option<String>,
    pub(super) stop_reason: Option<String>,
    pub(super) outcome: String,
    pub(super) attempt_count: u32,
    pub(super) total_tokens: u64,
    pub(super) latency_ms: u64,
}

/// Record a durable experience row for a node. Returns an error so the caller
/// can decide whether to fail the run or emit a warning and continue.
pub(super) fn record_node_experience(
    context: &RunContext,
    row: &NodeExperience,
) -> Result<(), String> {
    let connection = database_guard(context);
    connection
        .execute(
            "INSERT INTO node_experience(node_id,workflow_id,role,model,effort,failure_class,stop_reason,outcome,attempt_count,total_tokens,latency_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                row.node_id,
                row.workflow_id,
                row.role,
                row.model,
                row.effort,
                row.failure_class,
                row.stop_reason,
                row.outcome,
                row.attempt_count as i64,
                row.total_tokens as i64,
                row.latency_ms as i64,
            ],
        )
        .map_err(|error| format!("failed to record node experience: {error}"))?;
    Ok(())
}

/// Load recent experience rows for a node pattern directly from a connection.
/// Returns them newest-first, with `id` as a tie-breaker so ordering is stable
/// even when many rows share a one-second `observed_at` timestamp.
pub(super) fn get_node_experience(
    connection: &rusqlite::Connection,
    workflow_id: &str,
    node_id: &str,
    role: &str,
    model: &str,
    effort: &str,
) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT failure_class,stop_reason,outcome,attempt_count,total_tokens,latency_ms,observed_at
             FROM node_experience
             WHERE workflow_id=?1 AND node_id=?2 AND role=?3 AND model=?4 AND effort=?5
             ORDER BY observed_at DESC, id DESC LIMIT 20",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![workflow_id, node_id, role, model, effort], |row| {
            Ok(json!({
                "failureClass": row.get::<_, Option<String>>(0)?,
                "stopReason": row.get::<_, Option<String>>(1)?,
                "outcome": row.get::<_, String>(2)?,
                "attemptCount": row.get::<_, i64>(3)?,
                "totalTokens": row.get::<_, i64>(4)?,
                "latencyMs": row.get::<_, i64>(5)?,
                "observedAt": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// Load recent experience rows for the same node pattern within the current run.
pub(super) fn load_node_experience(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<Vec<Value>, String> {
    let connection = database_guard(context);
    get_node_experience(
        &connection,
        &context.workflow_id,
        &node.id,
        &node.data.role,
        &node.data.model,
        &node.data.effort,
    )
}

/// Derive a guidance note from prior experience for this node pattern.
/// The note is prepended to the specialist's extra instructions when the most
/// recent attempts (up to three) share a recurring non-success failure class.
/// The guidance is grounded in the actual stored records — it names the dominant
/// failure class and the most common stop reason observed — rather than
/// emitting a one-size-fits-all string. A recent success suppresses guidance
/// so the runtime does not pollute a prompt that is already working.
pub(super) fn experience_guidance(records: &[Value]) -> Option<String> {
    if records.len() < 2 {
        return None;
    }
    let recent: Vec<_> = records.iter().take(3).collect();
    // A recent success suppresses guidance so the runtime does not pollute a
    // prompt that is already working. Only the newest record counts as "recent".
    if recent
        .first()
        .and_then(|record| record.get("outcome").and_then(Value::as_str))
        == Some("success")
    {
        return None;
    }

    let mut class_counts: HashMap<String, usize> = HashMap::new();
    let mut stop_reason_counts: HashMap<String, usize> = HashMap::new();
    let mut attempt_total: i64 = 0;

    for record in &recent {
        if let Some(class) = record
            .get("failureClass")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            *class_counts.entry(class.to_string()).or_default() += 1;
        }
        if let Some(reason) = record
            .get("stopReason")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            *stop_reason_counts.entry(reason.to_string()).or_default() += 1;
        }
        attempt_total += record
            .get("attemptCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    }

    let (dominant_class, class_count) = class_counts.iter().max_by_key(|(_, count)| *count)?;
    if *class_count < 2 {
        return None;
    }

    let avg_attempts = attempt_total / recent.len().max(1) as i64;
    let stop_reason = stop_reason_counts
        .iter()
        .max_by_key(|(_, count)| *count)
        .map(|(reason, _)| reason.as_str())
        .unwrap_or("the same failure");

    let core = match dominant_class.as_str() {
        "contract" => format!(
            "Recent attempts failed with contract/output mismatch ({}). Return strictly valid structured JSON matching the required schema; do not wrap it in markdown fences or omit required fields.",
            stop_reason
        ),
        "transient" => format!(
            "Recent attempts hit transient errors ({}). If this happens again, wait briefly and retry; do not change the requested output over a temporary failure.",
            stop_reason
        ),
        "capability" => format!(
            "Recent attempts failed because a required capability was missing ({}). Use only the tools and skills you have; if the task truly needs something unavailable, report the gap clearly instead of attempting it.",
            stop_reason
        ),
        "specification" => format!(
            "Recent attempts did not follow the instructions ({}). Re-read the prompt, output contract, and constraints before producing output; ask for clarification if criteria are ambiguous.",
            stop_reason
        ),
        "verification" => format!(
            "Recent attempts failed host verification ({}). Provide explicit, checkable evidence for every claim and do not self-attest.",
            stop_reason
        ),
        "plateau" => format!(
            "Recent attempts plateaued on the same failure ({}). If your first approach does not succeed, deliberately vary the strategy rather than repeating the same steps.",
            stop_reason
        ),
        other => format!(
            "Recent attempts failed repeatedly with class '{}' ({}). Review the prompt and output contract, then adjust your approach.",
            other, stop_reason
        ),
    };

    Some(format!(
        "[Experience note: ~{} attempt(s) per recent run, recurring '{}' failure.] {}",
        avg_attempts, dominant_class, core
    ))
}

pub(crate) fn initialize_database(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS node_experience (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL,
                role TEXT,
                model TEXT,
                effort TEXT,
                failure_class TEXT,
                stop_reason TEXT,
                outcome TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                latency_ms INTEGER,
                observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_node_experience_lookup ON node_experience(workflow_id, node_id, role, model, effort);"
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn delete_node_experience_for_workflow(
    connection: &rusqlite::Connection,
    workflow_id: &str,
) -> Result<usize, String> {
    connection
        .execute(
            "DELETE FROM node_experience WHERE workflow_id=?1",
            params![workflow_id],
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn prune_node_experience(
    connection: &rusqlite::Connection,
    days: u32,
) -> Result<usize, String> {
    if days == 0 {
        return Ok(0);
    }
    let table_exists: bool = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_experience'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !table_exists {
        return Ok(0);
    }
    let age = format!("-{} days", days);
    connection
        .execute(
            "DELETE FROM node_experience WHERE observed_at < datetime('now', ?1)",
            params![age],
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(outcome: &str, class: Option<&str>, stop: Option<&str>) -> Value {
        json!({
            "outcome": outcome,
            "failureClass": class,
            "stopReason": stop,
            "attemptCount": 3,
            "totalTokens": 1000,
            "latencyMs": 5000,
            "observedAt": "2026-08-01T00:00:00Z",
        })
    }

    #[test]
    fn experience_guidance_returns_none_for_fewer_than_two_records() {
        assert!(experience_guidance(&[record("failed", Some("contract"), None)]).is_none());
        assert!(experience_guidance(&[]).is_none());
    }

    #[test]
    fn experience_guidance_returns_none_when_recent_is_success() {
        let records = vec![
            record("success", None, None),
            record("failed", Some("contract"), Some("bad json")),
        ];
        assert!(experience_guidance(&records).is_none());
    }

    #[test]
    fn experience_guidance_returns_none_when_no_dominant_class() {
        let records = vec![
            record("failed", Some("contract"), None),
            record("failed", Some("transient"), None),
        ];
        assert!(experience_guidance(&records).is_none());
    }

    #[test]
    fn experience_guidance_returns_note_for_recurring_contract_failure() {
        let records = vec![
            record("failed", Some("contract"), Some("bad json")),
            record("failed", Some("contract"), Some("bad json")),
            record("failed", Some("contract"), Some("bad json")),
        ];
        let guidance = experience_guidance(&records).unwrap();
        assert!(guidance.contains("contract"));
        assert!(guidance.contains("bad json"));
        assert!(guidance.contains("valid structured JSON"));
    }

    #[test]
    fn experience_guidance_returns_note_for_recurring_transient_failure() {
        let records = vec![
            record("failed", Some("transient"), Some("timeout")),
            record("failed", Some("transient"), Some("timeout")),
        ];
        let guidance = experience_guidance(&records).unwrap();
        assert!(guidance.contains("transient"));
        assert!(guidance.contains("timeout"));
        assert!(guidance.contains("retry"));
    }

    #[test]
    fn experience_guidance_returns_note_for_recurring_capability_failure() {
        let records = vec![
            record("failed", Some("capability"), Some("no tool")),
            record("failed", Some("capability"), Some("no tool")),
        ];
        let guidance = experience_guidance(&records).unwrap();
        assert!(guidance.contains("capability"));
        assert!(guidance.contains("missing"));
    }

    #[test]
    fn experience_guidance_returns_note_for_plateau() {
        let records = vec![
            record("failed", Some("plateau"), Some("stuck")),
            record("failed", Some("plateau"), Some("stuck")),
        ];
        let guidance = experience_guidance(&records).unwrap();
        assert!(guidance.contains("plateau"));
        assert!(guidance.contains("vary the strategy"));
    }

    #[test]
    fn experience_guidance_handles_unknown_class() {
        let records = vec![
            record("failed", Some("custom_class"), Some("reason")),
            record("failed", Some("custom_class"), Some("reason")),
        ];
        let guidance = experience_guidance(&records).unwrap();
        assert!(guidance.contains("custom_class"));
        assert!(guidance.contains("adjust your approach"));
    }
}
