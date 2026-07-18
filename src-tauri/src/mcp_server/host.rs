//! Host facade: database + runtime state + Live Codex helpers for MCP tools.
//!
//! Chat turns go through `crate::codex_turn` (shared spawn/turn/tool-callback client).

use std::path::PathBuf;

use rusqlite::params;
use serde_json::{json, Value};
use tauri::Manager;

use super::McpRuntime;
use crate::codex_turn::{run_hosted_codex_turn, CodexTurnRequest};
use crate::workflow_runtime::{RunApprovalBroker, WorkflowRuntime};
use crate::{
    default_chat_workspace_path, discover_codex_info, open_shared_database, ApprovalBroker,
    Database, ProcessBroker, ToolBroker,
};

/// Owns shared state for tool execution. Constructed for desktop or headless.
#[derive(Clone)]
pub struct McpHost {
    pub(crate) runtime: McpRuntime,
}

impl McpHost {
    /// Bootstrap a headless host (own DB connection, brokers, workflow runtime).
    pub fn headless() -> Result<Self, String> {
        let runtime_owner = crate::runtime_ownership::RuntimeOwnershipGuard::acquire("headless")?;
        let database = open_shared_database()?;
        // Apply the same app_settings / chat / business schema helpers used by desktop.
        {
            let connection = database
                .0
                .lock()
                .map_err(|_| "database lock poisoned".to_string())?;
            crate::app_settings::initialize(&connection)?;
            crate::chat_data::initialize(&connection)?;
            crate::business_data::initialize(&connection)?;
        }
        // Same interrupted-run recovery as desktop (no cron scheduler in headless).
        crate::workflow_runtime::recover_interrupted_runs(&database)?;
        Ok(Self {
            runtime: McpRuntime::headless(database, runtime_owner),
        })
    }

    /// Capture Tauri-managed state so MCP tools share the desktop process resources.
    pub fn from_tauri(app: &tauri::AppHandle) -> Self {
        Self {
            runtime: McpRuntime {
                database: app.state::<Database>().inner().clone(),
                process_broker: app.state::<ProcessBroker>().inner().clone(),
                approval_broker: app.state::<ApprovalBroker>().inner().clone(),
                tool_broker: app.state::<ToolBroker>().inner().clone(),
                workflow_runtime: app.state::<WorkflowRuntime>().inner().clone(),
                run_approvals: app.state::<RunApprovalBroker>().inner().clone(),
                app: Some(app.clone()),
                runtime_owner: app
                    .state::<std::sync::Arc<crate::runtime_ownership::RuntimeOwnershipGuard>>()
                    .inner()
                    .clone(),
            },
        }
    }

    pub(crate) fn owner_id(&self) -> &str {
        &self.runtime.runtime_owner.info().owner_id
    }

    pub fn discover_codex_json(&self) -> Result<Value, String> {
        serde_json::to_value(discover_codex_info()).map_err(|error| error.to_string())
    }

    pub fn list_workflows(&self) -> Result<Value, String> {
        let connection = self
            .runtime
            .database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id,name,graph_json,template_json,workspace_path,updated_at FROM workflows ORDER BY updated_at DESC,id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            let (id, name, graph_json, template_json, workspace_path, updated_at) =
                row.map_err(|error| error.to_string())?;
            let (node_count, edge_count) = graph_size(&graph_json);
            items.push(json!({
                "id": id,
                "name": name,
                "nodeCount": node_count,
                "edgeCount": edge_count,
                "workspacePath": workspace_path,
                "updatedAt": updated_at,
                "hasTemplate": template_json.is_some(),
            }));
        }
        Ok(json!({ "workflows": items }))
    }

    pub fn get_workflow(&self, id: &str) -> Result<Value, String> {
        let connection = self
            .runtime
            .database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        connection
            .query_row(
                "SELECT id,name,graph_json,template_json,workspace_path,updated_at FROM workflows WHERE id=?1",
                params![id],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "graphJson": row.get::<_, String>(2)?,
                        "templateJson": row.get::<_, Option<String>>(3)?,
                        "workspacePath": row.get::<_, Option<String>>(4)?,
                        "updatedAt": row.get::<_, String>(5)?,
                    }))
                },
            )
            .map_err(|_| format!("workflow not found: {id}"))
    }

    pub fn list_runs(&self, workflow_id: Option<&str>) -> Result<Value, String> {
        let connection = self
            .runtime
            .database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let mut items = Vec::new();
        if let Some(workflow_id) = workflow_id {
            let mut statement = connection
                .prepare(
                    "SELECT id,workflow_id,status,created_at,terminal_reason,resumable,pinned,last_event_seq FROM runs WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 50",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![workflow_id], map_run_row)
                .map_err(|error| error.to_string())?;
            for row in rows {
                items.push(row.map_err(|error| error.to_string())?);
            }
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT id,workflow_id,status,created_at,terminal_reason,resumable,pinned,last_event_seq FROM runs ORDER BY created_at DESC LIMIT 50",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], map_run_row)
                .map_err(|error| error.to_string())?;
            for row in rows {
                items.push(row.map_err(|error| error.to_string())?);
            }
        }
        Ok(json!({ "runs": items }))
    }

    pub fn get_run(&self, run_id: &str) -> Result<Value, String> {
        let mut record = {
            let connection = self
                .runtime
                .database
                .0
                .lock()
                .map_err(|_| "database lock poisoned".to_string())?;
            connection
                .query_row(
                    "SELECT id,workflow_id,status,created_at,terminal_reason,resumable,pinned,last_event_seq,nodes_json,edges_json FROM runs WHERE id=?1",
                    params![run_id],
                    |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?,
                            "workflowId": row.get::<_, String>(1)?,
                            "status": row.get::<_, String>(2)?,
                            "createdAt": row.get::<_, String>(3)?,
                            "terminalReason": row.get::<_, Option<String>>(4)?,
                            "resumable": row.get::<_, i64>(5)? != 0,
                            "pinned": row.get::<_, i64>(6)? != 0,
                            "lastEventSequence": row.get::<_, i64>(7)?,
                            "nodesJson": row.get::<_, String>(8)?,
                            "edgesJson": row.get::<_, String>(9)?,
                        }))
                    },
                )
                .map_err(|_| format!("run not found: {run_id}"))?
        };
        // Surface pending gate ids for headless operators (same broker as list_pending_run_approvals).
        let pending = self.pending_run_approval_ids_for_run(run_id)?;
        if let Some(obj) = record.as_object_mut() {
            obj.insert("pendingApprovals".into(), json!(pending));
        }
        Ok(record)
    }

    fn pending_run_approval_ids_for_run(&self, run_id: &str) -> Result<Vec<String>, String> {
        let pending = self
            .runtime
            .run_approvals
            .0
            .lock()
            .map_err(|_| "run approval broker lock poisoned".to_string())?;
        let prefix = format!("{run_id}::");
        let mut ids: Vec<String> = pending
            .keys()
            .filter(|id| id.starts_with(&prefix))
            .cloned()
            .collect();
        ids.sort();
        Ok(ids)
    }

    pub fn list_active_runs(&self, workflow_id: Option<&str>) -> Result<Value, String> {
        let active = self.runtime.workflow_runtime.list_active(workflow_id)?;
        Ok(json!({ "activeRuns": active }))
    }

    pub fn company_status(&self, workflow_id: Option<&str>) -> Result<Value, String> {
        let active = self.list_active_runs(workflow_id)?;
        let runs = self.list_runs(workflow_id)?;
        let codex = self.discover_codex_json()?;
        let pending_run = self.list_pending_run_approvals()?;
        let pending_codex = self.list_pending_codex_approvals()?;
        Ok(json!({
            "active": active.get("activeRuns").cloned().unwrap_or(json!([])),
            "recentRuns": runs.get("runs").cloned().unwrap_or(json!([])),
            "pendingRunApprovals": pending_run.get("pending").cloned().unwrap_or(json!([])),
            "pendingCodexApprovals": pending_codex.get("pending").cloned().unwrap_or(json!([])),
            "codex": codex,
            "mode": if self.runtime.app.is_some() { "desktop" } else { "headless" },
        }))
    }

    pub fn stop_run(&self, run_id: &str) -> Result<Value, String> {
        self.runtime
            .workflow_runtime
            .stop_run_internal(run_id, &self.runtime.process_broker)?;
        Ok(json!({ "ok": true, "runId": run_id, "status": "stop_requested" }))
    }

    /// Resolve a pending headless/desktop approval gate without the UI.
    pub fn respond_run_approval(
        &self,
        run_id: &str,
        request_id: &str,
        decision: bool,
    ) -> Result<Value, String> {
        if !request_id.starts_with(&format!("{run_id}::")) {
            return Err("approval does not belong to this run".into());
        }
        let sender = self
            .runtime
            .run_approvals
            .0
            .lock()
            .map_err(|_| "run approval broker lock poisoned".to_string())?
            .remove(request_id)
            .ok_or_else(|| "approval is no longer pending".to_string())?;
        sender.send(decision).map_err(|error| error.to_string())?;
        Ok(json!({
            "ok": true,
            "runId": run_id,
            "requestId": request_id,
            "decision": if decision { "approved" } else { "declined" },
        }))
    }

    /// Resolve a pending Live Codex `requestApproval` via the process ApprovalBroker.
    ///
    /// `request_id` is the broker key (`process_key::id`). `decision` is
    /// `accept` / `decline` (case-insensitive); `true`/`false` and
    /// `approve`/`approved` / `deny` are also accepted.
    pub fn respond_codex_approval(
        &self,
        request_id: &str,
        decision: &str,
    ) -> Result<Value, String> {
        let request_id = request_id.trim();
        if request_id.is_empty() {
            return Err("requestId is required".into());
        }
        let normalized = normalize_codex_approval_decision(decision)?;
        let sender = self
            .runtime
            .approval_broker
            .0
            .lock()
            .map_err(|_| "approval broker lock poisoned".to_string())?
            .remove(request_id)
            .ok_or_else(|| "approval request is no longer pending".to_string())?;
        sender
            .send(normalized.clone())
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "ok": true,
            "requestId": request_id,
            "decision": normalized,
        }))
    }

    /// List broker keys currently waiting on Live Codex `requestApproval`.
    /// Used with `CODEX_CORP_HEADLESS_APPROVAL=wait` when stderr is unavailable.
    pub fn list_pending_codex_approvals(&self) -> Result<Value, String> {
        let pending = self
            .runtime
            .approval_broker
            .0
            .lock()
            .map_err(|_| "approval broker lock poisoned".to_string())?;
        let mut request_ids: Vec<String> = pending.keys().cloned().collect();
        request_ids.sort();
        Ok(json!({
            "pending": request_ids.iter().map(|id| json!({ "requestId": id })).collect::<Vec<_>>(),
            "count": request_ids.len(),
            "hint": "Pass requestId to respond_codex_approval with decision accept|decline. Keys are process_key::approval_id (also logged on the headless stderr when wait mode arms a request)."
        }))
    }

    /// List pending human approval-gate request ids (runId::nodeId::approval…).
    pub fn list_pending_run_approvals(&self) -> Result<Value, String> {
        let pending = self
            .runtime
            .run_approvals
            .0
            .lock()
            .map_err(|_| "run approval broker lock poisoned".to_string())?;
        let mut request_ids: Vec<String> = pending.keys().cloned().collect();
        request_ids.sort();
        Ok(json!({
            "pending": request_ids.iter().map(|id| {
                let run_id = id.split("::").next().unwrap_or("");
                json!({ "requestId": id, "runId": run_id })
            }).collect::<Vec<_>>(),
            "count": request_ids.len(),
            "hint": "Pass requestId and runId to respond_run_approval with decision true|false. Keys are also logged on headless stderr when a gate arms."
        }))
    }

    pub fn start_run(
        &self,
        workflow_id: &str,
        start_node_id: Option<String>,
        workspace_path: Option<String>,
    ) -> Result<Value, String> {
        // Desktop: prefer the existing Tauri command path via block_on when AppHandle is present.
        if let Some(app) = &self.runtime.app {
            let result = tauri::async_runtime::block_on(crate::workflow_runtime::start_run(
                workflow_id.to_string(),
                start_node_id,
                workspace_path,
                app.clone(),
                app.state::<WorkflowRuntime>(),
                app.state::<RunApprovalBroker>(),
                app.state::<ApprovalBroker>(),
                app.state::<ProcessBroker>(),
                app.state::<Database>(),
            ))?;
            return serde_json::to_value(result).map_err(|error| error.to_string());
        }
        // Headless: start without UI emits (AppHandle absent).
        let record = tauri::async_runtime::block_on(crate::workflow_runtime::start_run_headless(
            workflow_id.to_string(),
            start_node_id,
            workspace_path,
            self.runtime.database.clone(),
            self.runtime.workflow_runtime.clone(),
            self.runtime.run_approvals.clone(),
            self.runtime.approval_broker.clone(),
            self.runtime.process_broker.clone(),
        ))?;
        serde_json::to_value(record).map_err(|error| error.to_string())
    }

    /// Byte Workflow (company mediator) chat — Live Codex turn with host-side tools.
    pub fn byte_workflow_chat(&self, args: Value) -> Result<Value, String> {
        let message = args
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("message is required")?;
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-5.4")
            .to_string();
        let workflow_id = args
            .get("workflowId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let workspace = args
            .get("workspacePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_chat_workspace_path);
        let context = self.build_company_context(workflow_id.as_deref())?;
        let system = format!(
            "{}\n\n## Host context (authoritative)\n{}",
            BYTE_WORKFLOW_SYSTEM_PROMPT,
            serde_json::to_string_pretty(&context).unwrap_or_else(|_| "{}".into())
        );
        let tools = super::tools::company_dynamic_tools();
        self.run_codex_chat_turn(&model, &system, message, &workspace, tools, "byte-workflow")
    }

    /// Byte Workflow Architect chat — catalog-oriented companion.
    pub fn byte_architect_chat(&self, args: Value) -> Result<Value, String> {
        let message = args
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("message is required")?;
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-5.4")
            .to_string();
        let workspace = args
            .get("workspacePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_chat_workspace_path);
        let catalog = self.list_workflows()?;
        let system = format!(
            "{}\n\n## Current catalog\n{}",
            BYTE_ARCHITECT_SYSTEM_PROMPT,
            serde_json::to_string_pretty(&catalog).unwrap_or_else(|_| "{}".into())
        );
        let tools = super::tools::architect_dynamic_tools();
        self.run_codex_chat_turn(
            &model,
            &system,
            message,
            &workspace,
            tools,
            "byte-architect",
        )
    }

    fn build_company_context(&self, workflow_id: Option<&str>) -> Result<Value, String> {
        let mut out = json!({
            "mode": if self.runtime.app.is_some() { "desktop" } else { "headless" },
        });
        if let Some(id) = workflow_id {
            if let Ok(workflow) = self.get_workflow(id) {
                out["workflow"] = workflow;
            }
            out["runs"] = self.list_runs(Some(id))?;
            out["activeRuns"] = self.list_active_runs(Some(id))?;
        } else {
            out["workflows"] = self.list_workflows()?;
            out["activeRuns"] = self.list_active_runs(None)?;
        }
        Ok(out)
    }

    /// Run a single Live Codex turn via the shared `codex_turn` client.
    fn run_codex_chat_turn(
        &self,
        model: &str,
        system_prompt: &str,
        user_message: &str,
        workspace: &std::path::Path,
        dynamic_tools: Value,
        process_key_prefix: &str,
    ) -> Result<Value, String> {
        let result = run_hosted_codex_turn(
            CodexTurnRequest {
                model,
                system_prompt,
                user_message,
                workspace,
                dynamic_tools,
                process_key_prefix,
                client_name: "codex-corp-mcp",
                turn_timeout: None,
            },
            &self.runtime.process_broker,
            |tool, arguments| self.execute_hosted_tool(tool, arguments),
        )?;
        Ok(result.to_json())
    }

    /// Host-side dynamic tool execution for chat turns (single catalog dispatch).
    fn execute_hosted_tool(&self, name: &str, arguments: Value) -> (bool, String) {
        let canonical = super::tools::normalize_tool_name(name);
        // Never re-enter chat tools from inside a chat turn.
        if matches!(canonical, "byte_workflow_chat" | "byte_architect_chat") {
            return (
                false,
                json!({"error": format!("tool '{name}' cannot be invoked from inside a chat turn")})
                    .to_string(),
            );
        }
        match super::tools::dispatch(self, name, arguments) {
            Ok(value) => (true, value.to_string()),
            Err(error) => (false, json!({"error": error}).to_string()),
        }
    }
}

fn normalize_codex_approval_decision(decision: &str) -> Result<String, String> {
    match decision.trim().to_ascii_lowercase().as_str() {
        "accept" | "approve" | "approved" | "true" | "yes" => Ok("accept".into()),
        "decline" | "deny" | "denied" | "reject" | "false" | "no" => Ok("decline".into()),
        other => Err(format!(
            "invalid decision '{other}' (expected accept or decline)"
        )),
    }
}

fn map_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "workflowId": row.get::<_, String>(1)?,
        "status": row.get::<_, String>(2)?,
        "createdAt": row.get::<_, String>(3)?,
        "terminalReason": row.get::<_, Option<String>>(4)?,
        "resumable": row.get::<_, i64>(5)? != 0,
        "pinned": row.get::<_, i64>(6)? != 0,
        "lastEventSequence": row.get::<_, i64>(7)?,
    }))
}

fn graph_size(graph_json: &str) -> (usize, usize) {
    let Ok(value) = serde_json::from_str::<Value>(graph_json) else {
        return (0, 0);
    };
    let nodes = value
        .get("nodes")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let edges = value
        .get("edges")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    (nodes, edges)
}

const BYTE_WORKFLOW_SYSTEM_PROMPT: &str = r#"You are Byte for Codex Corp — the human-facing companion for a multi-specialist company graph (not a graph node yourself).

Steer the company with tools and talk to the operator. You do not implement product code.
Use tools for status, runs, and workflow facts. Prefer short accurate markdown.
When a run waits on a human approval gate, call list_pending_run_approvals (or company_status / get_run) to discover requestId, then respond_run_approval with runId, requestId, and decision (true/false) — there may be no desktop UI in headless mode.
When Live Codex waits for requestApproval (CODEX_CORP_HEADLESS_APPROVAL=wait), call list_pending_codex_approvals then respond_codex_approval.
You are running via the Codex Corp MCP server (desktop or headless VM)."#;

const BYTE_ARCHITECT_SYSTEM_PROMPT: &str = r#"You are Byte, the top-level Codex Corp companion. You own the company workflow catalog, not a single company run.

Turn requirements into multi-agent graphs. Use tools for every catalog fact. Do not invent workflow contents.
You are running via the Codex Corp MCP server (desktop or headless VM)."#;
