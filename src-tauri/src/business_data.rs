use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::Database;

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS finance_entries (
                id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('revenue','expense')),
                source TEXT NOT NULL,
                amount REAL NOT NULL CHECK(amount >= 0),
                currency TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS dashboard_feedback (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                operator_message TEXT NOT NULL,
                architect_digest TEXT NOT NULL,
                workflow_id TEXT
            );",
        )
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinanceEntry {
    id: String,
    workflow_id: String,
    kind: String,
    source: String,
    amount: f64,
    currency: String,
    at: String,
    note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardFeedback {
    id: String,
    created_at: String,
    operator_message: String,
    architect_digest: String,
    workflow_id: Option<String>,
}

fn validate_finance_entry(entry: &FinanceEntry) -> Result<(), String> {
    if entry.id.trim().is_empty() || entry.workflow_id.trim().is_empty() {
        return Err("finance entry requires id and workflowId".into());
    }
    if entry.kind != "revenue" && entry.kind != "expense" {
        return Err("finance kind must be revenue or expense".into());
    }
    if !entry.amount.is_finite() || entry.amount < 0.0 {
        return Err("finance amount must be a finite non-negative number".into());
    }
    if entry.currency.trim().is_empty() || entry.at.trim().is_empty() {
        return Err("finance entry requires currency and timestamp".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_finance_entries(app: tauri::AppHandle) -> Result<Vec<FinanceEntry>, String> {
    let database = app.state::<Database>();
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id,workflow_id,kind,source,amount,currency,occurred_at,note
             FROM finance_entries ORDER BY occurred_at,id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(FinanceEntry {
                id: row.get(0)?,
                workflow_id: row.get(1)?,
                kind: row.get(2)?,
                source: row.get(3)?,
                amount: row.get(4)?,
                currency: row.get(5)?,
                at: row.get(6)?,
                note: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn save_finance_entry(entry: FinanceEntry, app: tauri::AppHandle) -> Result<(), String> {
    validate_finance_entry(&entry)?;
    let database = app.state::<Database>();
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    connection
        .execute(
            "INSERT INTO finance_entries(id,workflow_id,kind,source,amount,currency,occurred_at,note)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET workflow_id=excluded.workflow_id,kind=excluded.kind,
             source=excluded.source,amount=excluded.amount,currency=excluded.currency,
             occurred_at=excluded.occurred_at,note=excluded.note",
            params![
                entry.id,
                entry.workflow_id,
                entry.kind,
                entry.source,
                entry.amount,
                entry.currency,
                entry.at,
                entry.note
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn delete_finance_entry(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let database = app.state::<Database>();
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    connection
        .execute("DELETE FROM finance_entries WHERE id=?1", params![id])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn list_dashboard_feedback(
    app: tauri::AppHandle,
) -> Result<Vec<DashboardFeedback>, String> {
    let database = app.state::<Database>();
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id,created_at,operator_message,architect_digest,workflow_id
             FROM dashboard_feedback ORDER BY created_at DESC,id DESC LIMIT 50",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(DashboardFeedback {
                id: row.get(0)?,
                created_at: row.get(1)?,
                operator_message: row.get(2)?,
                architect_digest: row.get(3)?,
                workflow_id: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn save_dashboard_feedback(
    item: DashboardFeedback,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if item.id.trim().is_empty()
        || item.created_at.trim().is_empty()
        || item.operator_message.trim().is_empty()
        || item.architect_digest.trim().is_empty()
    {
        return Err("dashboard feedback is incomplete".into());
    }
    let database = app.state::<Database>();
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    connection
        .execute(
            "INSERT INTO dashboard_feedback(id,created_at,operator_message,architect_digest,workflow_id)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,
             operator_message=excluded.operator_message,architect_digest=excluded.architect_digest,
             workflow_id=excluded.workflow_id",
            params![
                item.id,
                item.created_at,
                item.operator_message,
                item.architect_digest,
                item.workflow_id
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finance_validation_rejects_invalid_backend_records() {
        let mut entry = FinanceEntry {
            id: "f1".into(),
            workflow_id: "wf".into(),
            kind: "revenue".into(),
            source: "manual".into(),
            amount: 10.0,
            currency: "USD".into(),
            at: "2026-07-17T00:00:00Z".into(),
            note: String::new(),
        };
        assert!(validate_finance_entry(&entry).is_ok());
        entry.amount = -1.0;
        assert!(validate_finance_entry(&entry).is_err());
        entry.amount = 1.0;
        entry.kind = "unknown".into();
        assert!(validate_finance_entry(&entry).is_err());
    }
}
