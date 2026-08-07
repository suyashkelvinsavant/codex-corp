use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::Manager;

use crate::Database;

const MAX_CHAT_STORE_BYTES: usize = 12 * 1024 * 1024;

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_stores (
                workflow_id TEXT PRIMARY KEY,
                store_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .map_err(|error| error.to_string())
}

fn validate_store(workflow_id: &str, store_json: &str) -> Result<(), String> {
    if workflow_id.trim().is_empty() {
        return Err("chat store requires a workflow id".into());
    }
    if store_json.len() > MAX_CHAT_STORE_BYTES {
        return Err("chat store exceeds the 12 MB limit".into());
    }
    let parsed: Value = serde_json::from_str(store_json)
        .map_err(|error| format!("chat store is not valid JSON: {error}"))?;
    if !parsed.is_object() || !parsed.get("sessions").is_some_and(Value::is_array) {
        return Err("chat store must contain a sessions array".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_chat_store(
    workflow_id: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let database = app.state::<Database>();
    let connection = crate::workflow_runtime::database_guard_for(&database);
    connection
        .query_row(
            "SELECT store_json FROM chat_stores WHERE workflow_id=?1",
            params![workflow_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn save_chat_store(
    workflow_id: String,
    store_json: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    validate_store(&workflow_id, &store_json)?;
    let database = app.state::<Database>();
    let connection = crate::workflow_runtime::database_guard_for(&database);
    connection
        .execute(
            "INSERT INTO chat_stores(workflow_id,store_json,updated_at)
             VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(workflow_id) DO UPDATE SET
             store_json=excluded.store_json,updated_at=CURRENT_TIMESTAMP",
            params![workflow_id, store_json],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_store;

    #[test]
    fn validates_chat_store_shape() {
        assert!(validate_store("workflow", r#"{"sessions":[],"activeSessionId":null}"#).is_ok());
        assert!(validate_store("", r#"{"sessions":[]}"#).is_err());
        assert!(validate_store("workflow", r#"{"messages":[]}"#).is_err());
    }
}
