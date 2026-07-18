//! Codex Corp MCP server — shared by the Tauri desktop shell and headless CLI.
//!
//! Transport: Streamable HTTP-style JSON-RPC on a local TCP port (default
//! `127.0.0.1:8742`, path `/mcp`), plus optional stdio mode for classic MCP
//! clients. The server auto-starts with both app entrypoints.

pub mod host;
pub mod lifecycle;
pub mod protocol;
pub(crate) mod tools;
pub mod transport;

pub use host::McpHost;
pub use lifecycle::{
    start_embedded, start_embedded_with_config, status_embedded, status_file_path, stop_embedded,
    stop_external, token_fingerprint, ServerStatus,
};
pub use protocol::{JsonRpcRequest, JsonRpcResponse};
pub use tools::{list_tool_definitions, ToolDefinition};

/// Read-only Codex availability probe. This deliberately does not open the
/// shared database or acquire runtime ownership.
pub fn discover_codex_json() -> Result<Value, String> {
    serde_json::to_value(crate::discover_codex_info()).map_err(|e| e.to_string())
}

use std::sync::Arc;

use serde_json::Value;

use crate::runtime_ownership::RuntimeOwnershipGuard;
use crate::workflow_runtime::{RunApprovalBroker, WorkflowRuntime};
use crate::Database;
use crate::ProcessBroker;
use crate::{ApprovalBroker, ToolBroker};

/// Format `host:port` for TCP bind / URLs. Bracket bare IPv6 literals.
pub(crate) fn socket_addr(host: &str, port: u16) -> String {
    let h = host.trim();
    if h.contains(':') && !h.starts_with('[') {
        format!("[{h}]:{port}")
    } else {
        format!("{h}:{port}")
    }
}

/// Configuration for the embedded MCP listener.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub host: String,
    pub port: u16,
    /// When true, also accept stdio JSON-RPC on this process (headless `serve --stdio`).
    pub stdio: bool,
    /// Bearer token required on HTTP POST `/mcp`. Generated per process unless set via env.
    pub auth_token: String,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        let port = std::env::var("CODEX_CORP_MCP_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(8742);
        let host = std::env::var("CODEX_CORP_MCP_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let auth_token = std::env::var("CODEX_CORP_MCP_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(generate_auth_token);
        Self {
            host,
            port,
            stdio: false,
            auth_token,
        }
    }
}

impl McpServerConfig {
    pub fn endpoint(&self) -> String {
        format!("http://{}/mcp", socket_addr(&self.host, self.port))
    }

    /// True when host/port/stdio match (auth token may differ and is ignored for bind identity).
    pub fn same_bind(&self, other: &Self) -> bool {
        self.host == other.host && self.port == other.port && self.stdio == other.stdio
    }
}

#[cfg(test)]
mod socket_addr_tests {
    use super::socket_addr;

    #[test]
    fn formats_ipv4_and_names() {
        assert_eq!(socket_addr("127.0.0.1", 8742), "127.0.0.1:8742");
        assert_eq!(socket_addr("localhost", 80), "localhost:80");
    }

    #[test]
    fn brackets_bare_ipv6() {
        assert_eq!(socket_addr("::1", 8742), "[::1]:8742");
        assert_eq!(socket_addr("2001:db8::1", 9), "[2001:db8::1]:9");
    }

    #[test]
    fn keeps_already_bracketed_ipv6() {
        assert_eq!(socket_addr("[::1]", 8742), "[::1]:8742");
    }
}

/// Cryptographically strong random token for loopback MCP CSRF protection.
/// Prefer setting `CODEX_CORP_MCP_TOKEN` to a strong secret when binding non-loopback.
fn generate_auth_token() -> String {
    let mut bytes = [0u8; 24];
    if !fill_os_random(&mut bytes) {
        // Extremely rare fallback: still produce a non-empty token, but log so operators notice.
        eprintln!(
            "[codex-corp-mcp] warning: OS random source unavailable; set CODEX_CORP_MCP_TOKEN explicitly"
        );
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        return format!("cc-fallback-{}-{}", std::process::id(), nanos);
    }
    let mut out = String::with_capacity(3 + bytes.len() * 2);
    out.push_str("cc-");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn fill_os_random(buf: &mut [u8]) -> bool {
    #[cfg(windows)]
    {
        // BCryptGenRandom with BCRYPT_USE_SYSTEM_PREFERRED_RNG (no algorithm handle).
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(
                h_algorithm: *mut std::ffi::c_void,
                pb_buffer: *mut u8,
                cb_buffer: u32,
                dw_flags: u32,
            ) -> i32;
        }
        unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            ) == 0
        }
    }
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(buf))
            .is_ok()
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = buf;
        false
    }
}

/// Hard cap for HTTP/stdio request bodies (4 MiB).
pub const MAX_MCP_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Shared runtime handles used by tool dispatch (crate-internal).
#[derive(Clone)]
pub(crate) struct McpRuntime {
    pub(crate) database: Database,
    pub(crate) process_broker: ProcessBroker,
    pub(crate) approval_broker: ApprovalBroker,
    #[allow(dead_code)] // reserved for future UI-brokered interactive tools
    pub(crate) tool_broker: ToolBroker,
    pub(crate) workflow_runtime: WorkflowRuntime,
    pub(crate) run_approvals: RunApprovalBroker,
    /// Desktop-only: used to emit UI events when runs start from MCP tools.
    pub(crate) app: Option<tauri::AppHandle>,
    pub(crate) runtime_owner: Arc<RuntimeOwnershipGuard>,
}

impl McpRuntime {
    pub(crate) fn headless(database: Database, runtime_owner: Arc<RuntimeOwnershipGuard>) -> Self {
        Self {
            database,
            process_broker: ProcessBroker(Arc::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            ))),
            approval_broker: ApprovalBroker(Arc::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            ))),
            tool_broker: ToolBroker(Arc::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            ))),
            workflow_runtime: WorkflowRuntime::default(),
            run_approvals: RunApprovalBroker::default(),
            app: None,
            runtime_owner,
        }
    }
}

/// Handle a single JSON-RPC message (initialize, tools/list, tools/call, ping).
pub fn handle_rpc(host: &McpHost, request: JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = request.id.clone();
    match request.method.as_str() {
        "initialize" => Some(JsonRpcResponse::result(
            id,
            serde_json::json!({
                "protocolVersion": protocol::PROTOCOL_VERSION,
                "capabilities": {
                    "tools": { "listChanged": false }
                },
                "serverInfo": {
                    "name": "codex-corp",
                    "version": env!("CARGO_PKG_VERSION"),
                    "title": "Codex Corp MCP"
                },
                "instructions": "Codex Corp exposes Byte Workflow chat, Workflow Architect, catalog, run control, and Live Codex probes as MCP tools."
            }),
        )),
        "notifications/initialized" | "initialized" => None,
        "ping" => Some(JsonRpcResponse::result(id, serde_json::json!({}))),
        "tools/list" => {
            let tools: Vec<Value> = list_tool_definitions()
                .into_iter()
                .map(|tool| tool.to_mcp_json())
                .collect();
            Some(JsonRpcResponse::result(
                id,
                serde_json::json!({ "tools": tools }),
            ))
        }
        "tools/call" => {
            let name = request
                .params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let arguments = request
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let result = tools::dispatch(host, &name, arguments);
            match result {
                Ok(value) => Some(JsonRpcResponse::result(
                    id,
                    serde_json::json!({
                        "content": [{
                            "type": "text",
                            "text": value.to_string()
                        }],
                        "structuredContent": value,
                        "isError": false
                    }),
                )),
                Err(error) => Some(JsonRpcResponse::result(
                    id,
                    serde_json::json!({
                        "content": [{
                            "type": "text",
                            "text": error
                        }],
                        "isError": true
                    }),
                )),
            }
        }
        "resources/list" => Some(JsonRpcResponse::result(
            id,
            serde_json::json!({ "resources": [] }),
        )),
        "prompts/list" => Some(JsonRpcResponse::result(
            id,
            serde_json::json!({ "prompts": [] }),
        )),
        other => Some(JsonRpcResponse::error(
            id,
            -32601,
            format!("Method not found: {other}"),
        )),
    }
}
