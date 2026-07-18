//! Shared Live Codex app-server turn client (MCP host path).
//!
//! Owns spawn → initialize → thread/start → turn loop → kill-on-drop.
//! Tool calls are handled via a callback so hosts stay thin.
//!
//! UI mediator/agent paths (`execute_mediator_turn` / `execute_agent_internal`)
//! remain separate for now — they stream events, broker UI tools, and handle
//! requestApproval. Migrate those only when call sites map cleanly (see
//! HEADLESS.md Architecture debt).

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{
    apply_instruction_params, codex_app_server, kill_app_server_child, normalize_model_id,
    parse_app_server_line, send_json_timed, ProcessBroker,
};

static CHAT_PROCESS_SEQ: AtomicU64 = AtomicU64::new(1);

/// Kill a raw `Child` if it never makes it into the broker RAII guard.
struct KillChildOnDrop(Option<Child>);

impl KillChildOnDrop {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }

    fn take(mut self) -> Result<Child, String> {
        self.0
            .take()
            .ok_or_else(|| "KillChildOnDrop already taken".into())
    }
}

impl Drop for KillChildOnDrop {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

/// Always kills the app-server child and removes its broker entry on drop.
struct ChatProcessGuard {
    key: String,
    broker: ProcessBroker,
    child: Arc<Mutex<Child>>,
}

impl Drop for ChatProcessGuard {
    fn drop(&mut self) {
        kill_app_server_child(&self.child);
        if let Ok(mut processes) = self.broker.0.lock() {
            processes.remove(&self.key);
        }
    }
}

fn unique_process_key(prefix: &str) -> String {
    let seq = CHAT_PROCESS_SEQ.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos}-{seq}")
}

/// Idle gap between app-server lines before a hosted turn is considered stalled.
/// Matches company-mediator loop parity in `lib.rs` (stricter than specialist `TURN_IDLE_SECS=75`).
pub const HOSTED_TURN_IDLE: Duration = Duration::from_secs(45);

/// Default wall-clock budget for a full hosted turn (start → completed).
pub const HOSTED_TURN_WALL: Duration = Duration::from_secs(180);

/// Inputs for a single hosted Codex chat turn.
pub struct CodexTurnRequest<'a> {
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub user_message: &'a str,
    pub workspace: &'a Path,
    pub dynamic_tools: Value,
    pub process_key_prefix: &'a str,
    /// JSON-RPC clientInfo name (e.g. `codex-corp-mcp`).
    pub client_name: &'a str,
    /// Overall wall-clock turn wait (default [`HOSTED_TURN_WALL`] when `None`).
    /// Idle gap between lines is always [`HOSTED_TURN_IDLE`].
    pub turn_timeout: Option<Duration>,
}

/// Successful turn output.
#[derive(Debug, Clone)]
pub struct CodexTurnResult {
    pub summary: String,
    pub thread_id: String,
    pub turn_id: String,
    pub model: String,
}

impl CodexTurnResult {
    pub fn to_json(&self) -> Value {
        json!({
            "summary": self.summary,
            "threadId": self.thread_id,
            "turnId": self.turn_id,
            "model": self.model,
        })
    }
}

/// Run one Live Codex turn with local dynamic-tool hosting.
///
/// `on_tool(name, arguments) -> (success, content_text)` handles `item/tool/call`.
/// Process is registered on `process_broker` and killed on drop / error paths.
pub fn run_hosted_codex_turn<F>(
    request: CodexTurnRequest<'_>,
    process_broker: &ProcessBroker,
    mut on_tool: F,
) -> Result<CodexTurnResult, String>
where
    F: FnMut(&str, Value) -> (bool, String),
{
    std::fs::create_dir_all(request.workspace).map_err(|error| error.to_string())?;
    let model = normalize_model_id(request.model);
    if model.is_empty() {
        return Err("model is required".into());
    }

    // Kill-on-drop covers the window before ChatProcessGuard is installed
    // (stdin/stdout take failures, broker lock poison).
    let mut child = KillChildOnDrop::new(codex_app_server()?);
    let stdin_raw = child
        .0
        .as_mut()
        .and_then(|c| c.stdin.take())
        .ok_or("Codex app-server stdin unavailable")?;
    let stdout = child
        .0
        .as_mut()
        .and_then(|c| c.stdout.take())
        .ok_or("Codex app-server stdout unavailable")?;
    let stdin: Arc<Mutex<ChildStdin>> = Arc::new(Mutex::new(stdin_raw));
    let (line_tx, line_rx) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if line_tx.send(Ok(line)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = line_tx.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });
    let process_key = unique_process_key(request.process_key_prefix);
    let child = Arc::new(Mutex::new(child.take()?));
    // Install kill+deregister guard before any further fallible work so a
    // poisoned broker lock still kills the child via Drop.
    let _process_guard = ChatProcessGuard {
        key: process_key.clone(),
        broker: process_broker.clone(),
        child: child.clone(),
    };
    process_broker
        .0
        .lock()
        .map_err(|_| "process broker lock poisoned".to_string())?
        .insert(process_key, child.clone());

    let read_response = |expected_id: i64| -> Result<Value, String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "Codex app-server timed out waiting for response id={expected_id}"
                ));
            }
            match line_rx.recv_timeout(remaining) {
                Ok(Ok(line)) => {
                    let value = parse_app_server_line(&line)?;
                    if value.get("id").and_then(|id| id.as_i64()) == Some(expected_id)
                        || value.get("id").and_then(|id| id.as_u64()) == Some(expected_id as u64)
                    {
                        if let Some(err) = value.get("error") {
                            return Err(format!("Codex app-server error: {err}"));
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Codex app-server closed".into());
                }
            }
        }
    };

    send_json_timed(
        &stdin,
        json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{
                "clientInfo":{
                    "name": request.client_name,
                    "title":"Codex Corp MCP",
                    "version":env!("CARGO_PKG_VERSION")
                },
                "capabilities":{"experimentalApi":true,"requestAttestation":false}
            }
        }),
        Duration::from_secs(10),
    )?;
    let _ = read_response(1)?;
    send_json_timed(
        &stdin,
        json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        Duration::from_secs(10),
    )?;

    let mut start_params = json!({
        "model": model,
        "cwd": request.workspace,
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "ephemeral": true,
        "dynamicTools": request.dynamic_tools
    });
    apply_instruction_params(&mut start_params, "", request.system_prompt);
    send_json_timed(
        &stdin,
        json!({
            "jsonrpc":"2.0","id":2,"method":"thread/start",
            "params": start_params
        }),
        Duration::from_secs(15),
    )?;
    let thread_result = read_response(2)?;
    let thread_id = thread_result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .or_else(|| thread_result.get("id").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    if thread_id.is_empty() {
        return Err("Codex thread/start returned no thread id".into());
    }

    send_json_timed(
        &stdin,
        json!({
            "jsonrpc":"2.0","id":3,"method":"turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type":"text","text": request.user_message}]
            }
        }),
        Duration::from_secs(15),
    )?;
    let turn_result = read_response(3)?;
    let turn_id = turn_result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .or_else(|| turn_result.get("id").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    if turn_id.is_empty() {
        return Err("Codex turn/start returned no turn id".into());
    }

    let turn_timeout = request.turn_timeout.unwrap_or(HOSTED_TURN_WALL);
    let mut message = String::new();
    let mut turn_completed = false;
    let mut turn_error: Option<String> = None;
    // Distinguishes idle gap (no line for HOSTED_TURN_IDLE) vs wall budget exhausted.
    let mut timeout_kind: Option<&'static str> = None;
    let deadline = std::time::Instant::now() + turn_timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            timeout_kind = Some("wall");
            break;
        }
        let line = match line_rx.recv_timeout(remaining.min(HOSTED_TURN_IDLE)) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // recv_timeout hit before wall budget only when idle gap elapsed.
                timeout_kind = if remaining <= HOSTED_TURN_IDLE {
                    Some("wall")
                } else {
                    Some("idle")
                };
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !turn_completed {
                    return Err("Codex app-server closed during chat turn".into());
                }
                break;
            }
        };
        let value = parse_app_server_line(&line)?;
        if value.get("id").is_some()
            && value.get("method").and_then(Value::as_str) == Some("item/tool/call")
        {
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let tool = value
                .pointer("/params/tool")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let arguments = value
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(Value::Null);
            let (success, content) = on_tool(&tool, arguments);
            if let Err(error) = send_json_timed(
                &stdin,
                json!({
                    "jsonrpc":"2.0",
                    "id": id,
                    "result": {
                        "contentItems":[{"type":"inputText","text": content}],
                        "success": success
                    }
                }),
                Duration::from_secs(10),
            ) {
                return Err(format!("failed to reply to tool call '{tool}': {error}"));
            }
            continue;
        }
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "item/agentMessage/delta" {
            let delta = value
                .pointer("/params/delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            message.push_str(delta);
        } else if method == "item/completed"
            && value.pointer("/params/item/type").and_then(Value::as_str) == Some("agentMessage")
        {
            if let Some(text) = value.pointer("/params/item/text").and_then(Value::as_str) {
                if !text.is_empty() {
                    message = text.to_string();
                }
            }
        } else if method == "turn/completed" {
            turn_completed = true;
            break;
        } else if method == "error" {
            turn_error = Some(
                value
                    .pointer("/params/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("chat turn error")
                    .to_string(),
            );
            break;
        }
    }

    if let Some(kind) = timeout_kind {
        return Err(match kind {
            "idle" => format!(
                "chat turn idle timeout ({}s with no app-server output)",
                HOSTED_TURN_IDLE.as_secs()
            ),
            _ => format!(
                "chat turn wall timeout ({}s total budget exhausted)",
                turn_timeout.as_secs()
            ),
        });
    }
    if let Some(error) = turn_error {
        return Err(error);
    }
    if message.trim().is_empty() {
        if turn_completed {
            message = "Agent finished without text.".into();
        } else {
            return Err("chat turn ended without a completed turn or message".into());
        }
    }

    Ok(CodexTurnResult {
        summary: message,
        thread_id,
        turn_id,
        model,
    })
}
