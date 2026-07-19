//! Single tool catalog for MCP clients and hosted Byte dynamic tools.
//!
//! Schemas and dispatch live here so MCP `tools/list`, Codex `dynamicTools`,
//! and `execute_hosted_tool` cannot drift.

use serde_json::{json, Value};

use super::host::McpHost;

/// Which client surfaces expose a tool.
#[derive(Debug, Clone, Copy)]
pub struct ToolSurfaces {
    pub mcp: bool,
    pub company_dynamic: bool,
    pub architect_dynamic: bool,
}

const MCP_ONLY: ToolSurfaces = ToolSurfaces {
    mcp: true,
    company_dynamic: false,
    architect_dynamic: false,
};

const MCP_AND_COMPANY: ToolSurfaces = ToolSurfaces {
    mcp: true,
    company_dynamic: true,
    architect_dynamic: false,
};

const ALL_CATALOG: ToolSurfaces = ToolSurfaces {
    mcp: true,
    company_dynamic: true,
    architect_dynamic: true,
};

#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub surfaces: ToolSurfaces,
}

impl ToolDefinition {
    pub fn to_mcp_json(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        })
    }

    pub fn to_codex_function_json(&self) -> Value {
        json!({
            "type": "function",
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        })
    }
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

/// Canonical tool catalog (one source of truth for schemas + surfaces).
pub fn all_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "byte_workflow_chat",
            description:
                "Chat with Byte (company workflow companion). Uses Live Codex via app-server with hosted company tools (status, run, list workflows).",
            input_schema: object_schema(
                json!({
                    "message": { "type": "string", "description": "Operator message" },
                    "model": { "type": "string", "description": "Codex model id from model/list" },
                    "workflowId": { "type": "string", "description": "Optional workflow context id" },
                    "workspacePath": { "type": "string", "description": "Optional cwd for the Codex thread" }
                }),
                &["message"],
            ),
            surfaces: MCP_ONLY,
        },
        ToolDefinition {
            name: "byte_architect_chat",
            description:
                "Chat with Byte Workflow Architect (catalog companion). Designs and inspects multi-agent graphs via Live Codex.",
            input_schema: object_schema(
                json!({
                    "message": { "type": "string" },
                    "model": { "type": "string" },
                    "workspacePath": { "type": "string" }
                }),
                &["message"],
            ),
            surfaces: MCP_ONLY,
        },
        ToolDefinition {
            name: "workflow_list",
            description: "List every saved workflow and graph size.",
            input_schema: object_schema(json!({}), &[]),
            surfaces: ALL_CATALOG,
        },
        ToolDefinition {
            name: "workflow_get",
            description: "Get a workflow record including graph JSON.",
            input_schema: object_schema(json!({ "id": { "type": "string" } }), &["id"]),
            surfaces: ALL_CATALOG,
        },
        ToolDefinition {
            name: "company_status",
            description:
                "Active runs, recent runs, pending approvals, and Codex CLI probe for a company (optional workflowId).",
            input_schema: object_schema(
                json!({ "workflowId": { "type": "string" } }),
                &[],
            ),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "company_run",
            description: "Start a native company workflow run (shared workflow runtime).",
            input_schema: object_schema(
                json!({
                    "workflowId": { "type": "string" },
                    "startNodeId": { "type": "string" },
                    "workspacePath": { "type": "string" }
                }),
                &["workflowId"],
            ),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "company_stop",
            description: "Stop an active company run.",
            input_schema: object_schema(
                json!({ "runId": { "type": "string" } }),
                &["runId"],
            ),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "list_pending_run_approvals",
            description:
                "List pending human approval-gate requestIds (runId::nodeId::approval…) waiting in this process. Use before respond_run_approval in headless mode.",
            input_schema: object_schema(json!({}), &[]),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "respond_run_approval",
            description:
                "Approve or decline a pending human approval gate for a run (required in headless mode where no desktop UI is available). Discover requestId via list_pending_run_approvals.",
            input_schema: object_schema(
                json!({
                    "runId": { "type": "string" },
                    "requestId": { "type": "string", "description": "Full request id (runId::nodeId::approval…)" },
                    "decision": { "type": "boolean", "description": "true = approve, false = decline" }
                }),
                &["runId", "requestId", "decision"],
            ),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "list_pending_codex_approvals",
            description:
                "List pending Live Codex requestApproval broker keys (process_key::id) waiting in this process. Use with CODEX_CORP_HEADLESS_APPROVAL=wait when you cannot read headless stderr.",
            input_schema: object_schema(json!({}), &[]),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "respond_codex_approval",
            description:
                "Accept or decline a pending Live Codex requestApproval (broker key process_key::id). Needed when CODEX_CORP_HEADLESS_APPROVAL=wait; default headless policy is auto_decline. Discover keys via list_pending_codex_approvals or headless stderr.",
            input_schema: object_schema(
                json!({
                    "requestId": { "type": "string", "description": "Broker key (process_key::approval id)" },
                    "decision": { "type": "string", "description": "accept or decline" }
                }),
                &["requestId", "decision"],
            ),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "list_runs",
            description: "List recent runs (optionally filtered by workflowId).",
            input_schema: object_schema(
                json!({ "workflowId": { "type": "string" } }),
                &[],
            ),
            surfaces: ALL_CATALOG,
        },
        ToolDefinition {
            name: "get_run",
            description: "Get a single run record (includes pendingApprovals when waiting).",
            input_schema: object_schema(
                json!({
                    "runId": { "type": "string" },
                    "id": { "type": "string", "description": "Alias for runId" }
                }),
                &[],
            ),
            surfaces: MCP_AND_COMPANY,
        },
        ToolDefinition {
            name: "list_active_runs",
            description: "List in-process active runs.",
            input_schema: object_schema(
                json!({ "workflowId": { "type": "string" } }),
                &[],
            ),
            surfaces: MCP_ONLY,
        },
        ToolDefinition {
            name: "discover_codex",
            description: "Discover local Codex CLI / app-server availability.",
            input_schema: object_schema(json!({}), &[]),
            surfaces: ALL_CATALOG,
        },
        ToolDefinition {
            name: "mcp_server_status",
            description: "Return this MCP server's listen endpoint and process mode.",
            input_schema: object_schema(json!({}), &[]),
            surfaces: MCP_ONLY,
        },
    ]
}

/// Canonical tool list exposed to MCP clients.
pub fn list_tool_definitions() -> Vec<ToolDefinition> {
    all_tool_definitions()
        .into_iter()
        .filter(|tool| tool.surfaces.mcp)
        .collect()
}

/// Codex dynamic tools for Byte workflow (company) chat turns.
pub fn company_dynamic_tools() -> Value {
    Value::Array(
        all_tool_definitions()
            .into_iter()
            .filter(|tool| tool.surfaces.company_dynamic)
            .map(|tool| tool.to_codex_function_json())
            .collect(),
    )
}

/// Codex dynamic tools for Byte architect chat turns.
pub fn architect_dynamic_tools() -> Value {
    Value::Array(
        all_tool_definitions()
            .into_iter()
            .filter(|tool| tool.surfaces.architect_dynamic)
            .map(|tool| tool.to_codex_function_json())
            .collect(),
    )
}

/// Normalize legacy / alias tool names to the catalog name.
pub fn normalize_tool_name(name: &str) -> &str {
    match name {
        "company_list_nodes" | "workflow_list" => "workflow_list",
        "company_list_runs" | "list_runs" => "list_runs",
        "company_respond_approval" | "respond_run_approval" => "respond_run_approval",
        other => other,
    }
}

pub fn dispatch(host: &McpHost, name: &str, arguments: Value) -> Result<Value, String> {
    match normalize_tool_name(name) {
        "byte_workflow_chat" => host.byte_workflow_chat(arguments),
        "byte_architect_chat" => host.byte_architect_chat(arguments),
        "workflow_list" => host.list_workflows(),
        "workflow_get" => {
            let id = required_str(&arguments, "id")?;
            host.get_workflow(&id)
        }
        "company_status" => host.company_status(optional_str(&arguments, "workflowId")),
        "company_run" => {
            let workflow_id = required_str(&arguments, "workflowId")?;
            host.start_run(
                &workflow_id,
                optional_str(&arguments, "startNodeId").map(str::to_string),
                optional_str(&arguments, "workspacePath").map(str::to_string),
            )
        }
        "company_stop" => {
            let run_id = required_str(&arguments, "runId")?;
            host.stop_run(&run_id)
        }
        "list_pending_run_approvals" => host.list_pending_run_approvals(),
        "respond_run_approval" => {
            let run_id = required_str(&arguments, "runId")?;
            let request_id = required_str(&arguments, "requestId")?;
            let decision = arguments
                .get("decision")
                .and_then(Value::as_bool)
                .ok_or_else(|| "decision (boolean) is required".to_string())?;
            host.respond_run_approval(&run_id, &request_id, decision)
        }
        "list_pending_codex_approvals" => host.list_pending_codex_approvals(),
        "respond_codex_approval" => {
            let request_id = required_str(&arguments, "requestId")?;
            let decision = required_str(&arguments, "decision")?;
            host.respond_codex_approval(&request_id, &decision)
        }
        "list_runs" => host.list_runs(optional_str(&arguments, "workflowId")),
        "get_run" => {
            let run_id = optional_str(&arguments, "runId")
                .or_else(|| optional_str(&arguments, "id"))
                .ok_or_else(|| "runId is required".to_string())?;
            host.get_run(run_id)
        }
        "list_active_runs" => host.list_active_runs(optional_str(&arguments, "workflowId")),
        "discover_codex" => host.discover_codex_json(),
        "mcp_server_status" => Ok(redacted_status_value(super::lifecycle::status_embedded())),
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn redacted_status_value(mut status: super::lifecycle::ServerStatus) -> Value {
    let fingerprint = super::lifecycle::token_fingerprint(&status.auth_token);
    status.auth_token.clear();
    let mut value = serde_json::to_value(status).unwrap_or(json!({ "running": false }));
    if !fingerprint.is_empty() {
        value["tokenFingerprint"] = json!(fingerprint);
    }
    value
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

fn optional_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_tool_value_never_exposes_the_bearer_token() {
        let value = redacted_status_value(super::super::lifecycle::ServerStatus {
            running: true,
            endpoint: "http://127.0.0.1:8742/mcp".into(),
            transport: "streamable-http".into(),
            host: "127.0.0.1".into(),
            port: 8742,
            pid: 42,
            mode: "headless".into(),
            owner_id: "owner-1".into(),
            auth_token: "super-secret-token".into(),
            message: String::new(),
        });
        assert!(value.get("authToken").is_none());
        assert_eq!(value["tokenFingerprint"].as_str().map(str::len), Some(8));
        assert!(!value.to_string().contains("super-secret-token"));
    }

    #[test]
    fn registry_includes_byte_tools() {
        let names: Vec<_> = list_tool_definitions()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(names.contains(&"byte_workflow_chat"));
        assert!(names.contains(&"byte_architect_chat"));
        assert!(names.contains(&"company_run"));
        assert!(names.contains(&"discover_codex"));
        assert!(names.contains(&"respond_run_approval"));
        assert!(names.contains(&"respond_codex_approval"));
        assert!(names.contains(&"list_pending_codex_approvals"));
        assert!(names.contains(&"list_pending_run_approvals"));
    }

    #[test]
    fn company_run_schema_includes_start_node_id() {
        let company_run = all_tool_definitions()
            .into_iter()
            .find(|t| t.name == "company_run")
            .expect("company_run");
        assert!(company_run
            .input_schema
            .get("properties")
            .and_then(|p| p.get("startNodeId"))
            .is_some());
        // Same schema on company dynamic surface.
        let dyn_tools = company_dynamic_tools();
        let arr = dyn_tools.as_array().expect("array");
        let run = arr
            .iter()
            .find(|t| t.get("name").and_then(Value::as_str) == Some("company_run"))
            .expect("company_run dynamic");
        assert!(run
            .get("inputSchema")
            .and_then(|s| s.get("properties"))
            .and_then(|p| p.get("startNodeId"))
            .is_some());
    }

    #[test]
    fn company_dynamic_includes_list_pending_tools() {
        let dyn_tools = company_dynamic_tools();
        let names: Vec<_> = dyn_tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();
        assert!(names.contains(&"list_pending_codex_approvals"));
        assert!(names.contains(&"list_pending_run_approvals"));
        assert!(names.contains(&"respond_run_approval"));
        assert!(!names.contains(&"byte_workflow_chat"));
    }

    #[test]
    fn unknown_tool_errors() {
        let tools = list_tool_definitions();
        assert!(tools.len() >= 8);
        for tool in tools {
            assert!(!tool.name.is_empty());
            assert!(tool.input_schema.get("type").is_some());
        }
    }

    #[test]
    fn required_str_validation() {
        let args = json!({ "message": "  hi  " });
        assert_eq!(required_str(&args, "message").unwrap(), "hi");
        assert!(required_str(&args, "missing").is_err());
    }

    #[test]
    fn alias_normalization() {
        assert_eq!(normalize_tool_name("company_list_runs"), "list_runs");
        assert_eq!(normalize_tool_name("company_list_nodes"), "workflow_list");
        assert_eq!(
            normalize_tool_name("company_respond_approval"),
            "respond_run_approval"
        );
    }
}
