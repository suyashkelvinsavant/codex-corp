use futures_util::stream::{FuturesUnordered, StreamExt};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use crate::app_settings;
use crate::{
    execute_agent_internal, AgentRequest, AgentResult, ApprovalBroker, Database, ProcessBroker,
};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);
const RUNTIME_VERSION: i64 = 2;

#[derive(Clone)]
pub(crate) struct WorkflowRuntime {
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    limiter: Arc<ProcessLimiter>,
}

impl Default for WorkflowRuntime {
    fn default() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            limiter: Arc::new(ProcessLimiter::new(8)),
        }
    }
}

#[derive(Clone)]
struct ActiveRun {
    workflow_id: String,
    status: String,
    stop: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct RunApprovalBroker(Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>);

impl Default for RunApprovalBroker {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

struct ProcessLimiter {
    active: Mutex<usize>,
    changed: Condvar,
    limit: AtomicUsize,
    next_ticket: AtomicU64,
    serving_ticket: AtomicU64,
}

impl ProcessLimiter {
    fn new(limit: usize) -> Self {
        Self {
            active: Mutex::new(0),
            changed: Condvar::new(),
            limit: AtomicUsize::new(limit),
            next_ticket: AtomicU64::new(0),
            serving_ticket: AtomicU64::new(0),
        }
    }

    fn set_limit(&self, limit: usize) {
        self.limit.store(limit.clamp(1, 16), Ordering::SeqCst);
        self.changed.notify_all();
    }

    fn acquire(self: &Arc<Self>, stop: &AtomicBool) -> Result<ProcessPermit, String> {
        let ticket = self.next_ticket.fetch_add(1, Ordering::SeqCst);
        let mut active = self
            .active
            .lock()
            .map_err(|_| "process limiter lock poisoned".to_string())?;
        while ticket != self.serving_ticket.load(Ordering::SeqCst)
            || *active >= self.limit.load(Ordering::SeqCst)
        {
            let waited = self
                .changed
                .wait_timeout(active, Duration::from_millis(250))
                .map_err(|_| "process limiter wait poisoned".to_string())?;
            active = waited.0;
        }
        self.serving_ticket.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_all();
        if stop.load(Ordering::SeqCst) {
            return Err("run interrupted while queued for a Codex process".into());
        }
        *active += 1;
        Ok(ProcessPermit(self.clone()))
    }
}

struct ProcessPermit(Arc<ProcessLimiter>);

impl Drop for ProcessPermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.changed.notify_all();
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RuntimeGraph {
    nodes: Vec<RuntimeNode>,
    edges: Vec<RuntimeEdge>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RuntimeNode {
    id: String,
    data: RuntimeNodeData,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeNodeData {
    label: String,
    role: String,
    kind: String,
    #[serde(default)]
    model: String,
    #[serde(default = "default_effort")]
    effort: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    connector_tools: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    active_skill: Option<String>,
    #[serde(default)]
    permission_profile: Option<String>,
    #[serde(default)]
    collaboration_mode: Option<String>,
    #[serde(default)]
    personality: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    completion_criteria: Vec<RuntimeCriterion>,
    #[serde(default = "default_retries")]
    max_retries: u32,
    #[serde(default = "default_approval")]
    approval_policy: String,
    #[serde(default = "default_sandbox")]
    sandbox_profile: String,
    #[serde(default = "default_workspace")]
    workspace_policy: String,
    #[serde(default)]
    output_schema: Option<String>,
    #[serde(default)]
    condition_rule: Option<ConditionRule>,
}

fn default_effort() -> String {
    "low".into()
}
fn default_retries() -> u32 {
    2
}
fn default_approval() -> String {
    "on-request".into()
}
fn default_sandbox() -> String {
    "workspace-write".into()
}
fn default_workspace() -> String {
    "isolated".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCriterion {
    id: String,
    label: String,
    kind: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    platform: bool,
    #[serde(default = "default_required")]
    enforcement: String,
    #[serde(default)]
    instruction: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_required() -> String {
    "required".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RuntimeEdge {
    id: String,
    source: String,
    target: String,
    #[serde(default)]
    data: Option<RuntimeEdgeData>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEdgeData {
    #[serde(default = "default_edge")]
    edge_type: String,
    #[serde(default)]
    condition: Option<String>,
    #[serde(default)]
    max_revisions: Option<u32>,
    #[serde(default)]
    mapping: Option<HashMap<String, String>>,
}

fn default_edge() -> String {
    "standard".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConditionRule {
    #[serde(default)]
    source_node_id: Option<String>,
    path: String,
    operator: String,
    #[serde(default)]
    value: Option<Value>,
    true_branch: String,
    false_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRunEvent {
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt_id: Option<String>,
    sequence: u64,
    event_type: String,
    level: String,
    at: String,
    message: String,
    diagnostics: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRunRecord {
    id: String,
    workflow_id: String,
    status: String,
    created_at: String,
    terminal_reason: Option<String>,
    resumable: bool,
    pinned: bool,
    last_event_sequence: u64,
    nodes_json: String,
    edges_json: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunApprovalEvent {
    run_id: String,
    request_id: String,
    node_id: String,
    title: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOutput {
    status: String,
    summary: String,
    data: Value,
    artifacts: Vec<Value>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunCheckpoint {
    #[serde(default)]
    completed: HashSet<String>,
    #[serde(default)]
    skipped: HashSet<String>,
    #[serde(default)]
    outputs: HashMap<String, RuntimeOutput>,
}

impl From<AgentResult> for RuntimeOutput {
    fn from(result: AgentResult) -> Self {
        Self {
            status: result.status,
            summary: result.summary,
            data: result.data,
            artifacts: result.artifacts,
            thread_id: Some(result.thread_id),
            turn_id: Some(result.turn_id),
        }
    }
}

#[derive(Clone)]
struct RunContext {
    run_id: String,
    app: tauri::AppHandle,
    graph: RuntimeGraph,
    outputs: Arc<Mutex<HashMap<String, RuntimeOutput>>>,
    stop: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
    limiter: Arc<ProcessLimiter>,
    approval_broker: ApprovalBroker,
    process_broker: ProcessBroker,
    run_approvals: RunApprovalBroker,
    target_workspace: Option<PathBuf>,
}

fn new_run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = RUN_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("run-{millis:x}-{counter:x}")
}

fn now_isoish() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn emit_event(
    context: &RunContext,
    event_type: &str,
    level: &str,
    node_id: Option<&str>,
    attempt_id: Option<&str>,
    message: impl Into<String>,
    diagnostics: Value,
) {
    let sequence = context.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let event = WorkflowRunEvent {
        run_id: context.run_id.clone(),
        node_id: node_id.map(str::to_string),
        attempt_id: attempt_id.map(str::to_string),
        sequence,
        event_type: event_type.into(),
        level: level.into(),
        at: now_isoish(),
        message: message.into(),
        diagnostics: crate::redact_sensitive(diagnostics),
    };
    if let Ok(connection) = context.app.state::<Database>().0.lock() {
        let event_json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".into());
        let _ = connection.execute(
            "INSERT INTO run_events(run_id,node_id,attempt_id,event_type,level,sequence,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![event.run_id,event.node_id,event.attempt_id,event.event_type,event.level,event.sequence,event_json],
        );
        let _ = connection.execute(
            "UPDATE runs SET last_event_seq=?2 WHERE id=?1",
            params![context.run_id, sequence],
        );
    }
    let _ = context.app.emit("workflow-run-event", event);
}

fn parse_graph(raw: &str) -> Result<RuntimeGraph, String> {
    let graph: RuntimeGraph = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if graph.nodes.iter().all(|node| node.data.kind != "input") {
        return Err("workflow requires an input node".into());
    }
    if graph.nodes.iter().all(|node| node.data.kind != "output") {
        return Err("workflow requires an output node".into());
    }
    let ids: HashSet<_> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
    for edge in &graph.edges {
        if !ids.contains(edge.source.as_str()) || !ids.contains(edge.target.as_str()) {
            return Err(format!("edge {} references a missing node", edge.id));
        }
    }
    for node in graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "condition")
    {
        validate_condition_rule(node.data.condition_rule.as_ref())?;
        let inbound: Vec<_> = graph
            .edges
            .iter()
            .filter(|edge| {
                edge.target == node.id
                    && edge.data.as_ref().map(|data| data.edge_type.as_str()) != Some("revision")
            })
            .collect();
        if inbound.len() > 1
            && node
                .data
                .condition_rule
                .as_ref()
                .and_then(|rule| rule.source_node_id.as_ref())
                .is_none()
        {
            return Err(format!(
                "condition {} must select an explicit upstream source",
                node.data.label
            ));
        }
        if let Some(source) = node
            .data
            .condition_rule
            .as_ref()
            .and_then(|rule| rule.source_node_id.as_ref())
        {
            if !inbound.iter().any(|edge| &edge.source == source) {
                return Err(format!(
                    "condition {} source must be a direct upstream node",
                    node.data.label
                ));
            }
        }
    }
    Ok(graph)
}

fn validate_condition_rule(rule: Option<&ConditionRule>) -> Result<(), String> {
    let rule = rule.ok_or("legacy static condition must be configured before running")?;
    if !rule.path.starts_with("$.")
        || !rule
            .path
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "$._-".contains(character))
    {
        return Err("condition path is invalid".into());
    }
    if !matches!(
        rule.operator.as_str(),
        "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "exists"
    ) {
        return Err("condition operator is not allowed".into());
    }
    if rule.true_branch.trim().is_empty()
        || rule.false_branch.trim().is_empty()
        || rule.true_branch == rule.false_branch
    {
        return Err("condition branches must be non-empty and distinct".into());
    }
    if rule.operator != "exists" && rule.value.is_none() {
        return Err("condition comparison value is required".into());
    }
    Ok(())
}

fn read_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.strip_prefix("$.")?
        .split('.')
        .try_fold(value, |current, segment| current.get(segment))
}

fn evaluate_condition(rule: &ConditionRule, source: &Value) -> bool {
    let actual = read_path(source, &rule.path);
    match rule.operator.as_str() {
        "exists" => actual.is_some_and(|value| !value.is_null()),
        "==" => actual == rule.value.as_ref(),
        "!=" => actual != rule.value.as_ref(),
        ">" | ">=" | "<" | "<=" => {
            let Some(left) = actual.and_then(Value::as_f64) else {
                return false;
            };
            let Some(right) = rule.value.as_ref().and_then(Value::as_f64) else {
                return false;
            };
            match rule.operator.as_str() {
                ">" => left > right,
                ">=" => left >= right,
                "<" => left < right,
                _ => left <= right,
            }
        }
        "contains" => match (actual, rule.value.as_ref()) {
            (Some(Value::String(text)), Some(Value::String(needle))) => text.contains(needle),
            (Some(Value::Array(items)), Some(needle)) => items.contains(needle),
            _ => false,
        },
        _ => false,
    }
}

fn criteria_instructions(criteria: &[RuntimeCriterion]) -> String {
    let rows: Vec<_> = criteria
        .iter()
        .filter(|criterion| criterion.platform || criterion.enabled)
        .map(|criterion| {
            format!(
                "- [{}] {}{}",
                if criterion.platform || criterion.enforcement == "required" {
                    "REQUIRED"
                } else {
                    "ADVISORY"
                },
                criterion.label,
                criterion
                    .instruction
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(" — {value}"))
                    .unwrap_or_default()
            )
        })
        .collect();
    if rows.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nCOMPLETION CRITERIA:\n{}\nFor every criterion, return a data.criteria entry with its exact id, passed boolean, and concise evidence. Never claim passed without evidence.",
            rows.join("\n")
        )
    }
}

fn required_criteria_failure(
    criteria: &[RuntimeCriterion],
    output: &RuntimeOutput,
) -> Option<String> {
    for criterion in criteria {
        let required = criterion.platform || criterion.enforcement == "required";
        if !required || (!criterion.enabled && !criterion.platform) {
            continue;
        }
        if criterion_failed(criterion, output) {
            return Some(format!(
                "required completion criterion failed: {}",
                criterion.label
            ));
        }
    }
    None
}

fn criterion_failed(criterion: &RuntimeCriterion, output: &RuntimeOutput) -> bool {
    let lower = format!("{}\n{}", output.summary, output.data).to_ascii_lowercase();
    match criterion.kind.as_str() {
        "structured_json" => output.summary.trim().is_empty(),
        "concise_summary" => {
            let words = output.summary.split_whitespace().count();
            !(3..=600).contains(&words)
        }
        "no_hidden_reasoning" => [
            "chain-of-thought",
            "chain of thought",
            "internal monologue",
            "hidden reasoning",
            "scratchpad:",
        ]
        .iter()
        .any(|marker| lower.contains(marker)),
        "custom" => {
            output
                .data
                .get("criteria")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id").and_then(Value::as_str) == Some(criterion.id.as_str())
                    })
                })
                .and_then(|item| item.get("passed"))
                .and_then(Value::as_bool)
                != Some(true)
        }
        _ => false,
    }
}

fn emit_advisory_failures(context: &RunContext, node: &RuntimeNode, output: &RuntimeOutput) {
    for criterion in node.data.completion_criteria.iter().filter(|criterion| {
        criterion.enabled && !criterion.platform && criterion.enforcement == "advisory"
    }) {
        if criterion_failed(criterion, output) {
            emit_event(
                context,
                "criterion.advisory_failed",
                "warning",
                Some(&node.id),
                None,
                format!("Advisory criterion not satisfied: {}", criterion.label),
                json!({"criterionId":criterion.id}),
            );
        }
    }
}

fn tool_policy(node: &RuntimeNode) -> Result<(String, String), String> {
    let write_selected = node
        .data
        .tools
        .iter()
        .any(|tool| tool.to_ascii_lowercase().contains("write"));
    if write_selected
        && node.data.permission_profile.is_none()
        && node.data.sandbox_profile == "read-only"
    {
        return Err(format!(
            "{} selects write capability with a read-only sandbox",
            node.data.label
        ));
    }
    if write_selected
        && node
            .data
            .permission_profile
            .as_deref()
            .is_some_and(|profile| profile.contains("read-only"))
    {
        return Err(format!(
            "{} selects write capability with a read-only permission profile",
            node.data.label
        ));
    }
    let sandbox = if write_selected {
        "workspace-write".to_string()
    } else {
        "read-only".to_string()
    };
    Ok((sandbox, node.data.approval_policy.clone()))
}

fn connector_capability_instructions(node: &RuntimeNode) -> String {
    let mut lines = Vec::new();
    if !node.data.skills.is_empty() {
        lines.push(format!(
            "Selected Codex connector skills: {}.",
            node.data.skills.join(", ")
        ));
        if let Some(primary) = node.data.active_skill.as_deref() {
            lines.push(format!("Primary selected skill: {primary}."));
        }
        lines.push(
            "Use these skills only when applicable and follow their connector-provided instructions."
                .to_string(),
        );
    }
    if !node.data.connector_tools.is_empty() {
        lines.push(format!(
            "Preferred connector tools: {}. Use only tools relevant to this task; connector authentication and the Codex sandbox remain authoritative.",
            node.data.connector_tools.join(", ")
        ));
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", lines.join("\n"))
    }
}

async fn specialist_once(
    context: &RunContext,
    node: &RuntimeNode,
    attempt: u32,
    revision: u32,
    extra_instruction: &str,
) -> Result<RuntimeOutput, String> {
    let (sandbox_profile, approval_policy) = tool_policy(node)?;
    let attempt_id = format!("a{}-r{}", attempt + 1, revision);
    emit_event(
        context,
        "node.attempt.started",
        "info",
        Some(&node.id),
        Some(&attempt_id),
        format!("{} attempt {} started", node.data.label, attempt + 1),
        json!({"attempt":attempt,"revision":revision}),
    );
    let limiter = context.limiter.clone();
    let stop = context.stop.clone();
    let permit = tauri::async_runtime::spawn_blocking(move || limiter.acquire(&stop))
        .await
        .map_err(|error| error.to_string())??;
    if context.stop.load(Ordering::SeqCst) {
        return Err("run interrupted".into());
    }
    let upstream: Vec<Value> = context
        .outputs
        .lock()
        .map_err(|_| "outputs lock poisoned".to_string())?
        .values()
        .map(|output| serde_json::to_value(output).unwrap_or(Value::Null))
        .collect();
    let mission = context
        .graph
        .nodes
        .iter()
        .find(|candidate| candidate.data.kind == "input")
        .and_then(|candidate| candidate.data.output.clone())
        .unwrap_or_default();
    let schema = node
        .data
        .output_schema
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    let request = AgentRequest {
        node_id: node.id.clone(),
        run_id: Some(context.run_id.clone()),
        attempt_id: Some(attempt_id.clone()),
        role: node.data.role.clone(),
        model: node.data.model.clone(),
        effort: node.data.effort.clone(),
        system_prompt: format!(
            "{}{}{}{}",
            node.data.prompt,
            connector_capability_instructions(node),
            criteria_instructions(&node.data.completion_criteria),
            extra_instruction
        ),
        user_input: mission,
        upstream_outputs: upstream,
        approval_policy,
        sandbox_profile,
        permission_profile: node.data.permission_profile.clone(),
        collaboration_mode: node.data.collaboration_mode.clone(),
        personality: node.data.personality.clone(),
        workspace_policy: node.data.workspace_policy.clone(),
        target_workspace: context
            .target_workspace
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        output_schema: schema,
        tools: node.data.tools.clone(),
        tool_boundary: "Tool selections are enforced through the host sandbox and approval policy where supported. CLI-internal tool granularity remains governed by Codex.".into(),
    };
    let started = SystemTime::now();
    let result = execute_agent_internal(
        request,
        context.app.clone(),
        context.approval_broker.clone(),
        context.process_broker.clone(),
    )
    .await;
    drop(permit);
    let elapsed_ms = started
        .elapsed()
        .map(|value| value.as_millis())
        .unwrap_or(0);
    match result {
        Ok(result) => {
            let output: RuntimeOutput = result.into();
            if output.status == "failure" {
                let error = if output.summary.trim().is_empty() {
                    "specialist returned failure without a summary".to_string()
                } else {
                    output.summary.clone()
                };
                emit_event(
                    context,
                    "node.attempt.failed",
                    "error",
                    Some(&node.id),
                    Some(&attempt_id),
                    format!("{} reported failure: {error}", node.data.label),
                    json!({"elapsedMs":elapsed_ms,"status":"failure","threadId":output.thread_id,"turnId":output.turn_id,"attempt":attempt,"revision":revision}),
                );
                if let Ok(connection) = context.app.state::<Database>().0.lock() {
                    let _ = connection.execute(
                        "INSERT OR REPLACE INTO node_attempts(id,run_id,node_id,attempt,revision,status,thread_id,turn_id,diagnostics_json,completed_at) VALUES(?1,?2,?3,?4,?5,'failed',?6,?7,?8,CURRENT_TIMESTAMP)",
                        params![format!("{}:{}:{}",context.run_id,node.id,attempt_id),context.run_id,node.id,attempt,revision,output.thread_id,output.turn_id,json!({"elapsedMs":elapsed_ms,"reportedFailure":true,"summary":error}).to_string()],
                    );
                }
                return Err(error);
            }
            emit_event(
                context,
                "node.attempt.completed",
                "info",
                Some(&node.id),
                Some(&attempt_id),
                format!("{} attempt completed", node.data.label),
                json!({"elapsedMs":elapsed_ms,"status":output.status,"threadId":output.thread_id,"turnId":output.turn_id}),
            );
            if let Ok(connection) = context.app.state::<Database>().0.lock() {
                let _ = connection.execute(
                    "INSERT OR REPLACE INTO node_attempts(id,run_id,node_id,attempt,revision,status,thread_id,turn_id,diagnostics_json,completed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,CURRENT_TIMESTAMP)",
                    params![format!("{}:{}:{}",context.run_id,node.id,attempt_id),context.run_id,node.id,attempt,revision,output.status,output.thread_id,output.turn_id,json!({"elapsedMs":elapsed_ms}).to_string()],
                );
            }
            Ok(output)
        }
        Err(error) => {
            emit_event(
                context,
                "node.attempt.failed",
                "error",
                Some(&node.id),
                Some(&attempt_id),
                format!("{} attempt failed: {error}", node.data.label),
                json!({"elapsedMs":elapsed_ms,"error":error,"attempt":attempt,"revision":revision}),
            );
            Err(error)
        }
    }
}

async fn specialist_with_retries(
    context: &RunContext,
    node: &RuntimeNode,
    revision: u32,
    extra_instruction: &str,
) -> Result<RuntimeOutput, String> {
    let mut last_error = String::new();
    for attempt in 0..=node.data.max_retries {
        match specialist_once(context, node, attempt, revision, extra_instruction).await {
            Ok(output) => return Ok(output),
            Err(error) => {
                last_error = error;
                if context.stop.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
    Err(format!(
        "{} exhausted {} retries: {last_error}",
        node.data.label, node.data.max_retries
    ))
}

async fn execute_specialist_with_revision(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<RuntimeOutput, String> {
    let mut output = specialist_with_retries(context, node, 0, "").await?;
    emit_advisory_failures(context, node, &output);
    let revision_edge = context.graph.edges.iter().find(|edge| {
        edge.source == node.id
            && edge
                .data
                .as_ref()
                .is_some_and(|data| data.edge_type == "revision")
    });
    let mut reason = if output.status == "needs_revision" {
        Some(output.summary.clone())
    } else {
        required_criteria_failure(&node.data.completion_criteria, &output)
    };
    let Some(edge) = revision_edge else {
        if let Some(reason) = reason {
            return Err(format!("{reason}; no revision edge is configured"));
        }
        return Ok(output);
    };
    let max = edge
        .data
        .as_ref()
        .and_then(|data| data.max_revisions)
        .unwrap_or(2);
    let target = context
        .graph
        .nodes
        .iter()
        .find(|candidate| candidate.id == edge.target)
        .ok_or("revision target missing")?;
    for revision in 1..=max {
        let Some(feedback) = reason.take() else {
            return Ok(output);
        };
        emit_event(
            context,
            "revision.routed",
            "warning",
            Some(&target.id),
            None,
            format!("Revision {revision}/{max} routed to {}", target.data.label),
            json!({"reviewerNodeId":node.id,"feedback":feedback}),
        );
        let revised = specialist_with_retries(
            context,
            target,
            revision,
            &format!(
                "\n\nREVISION FEEDBACK FROM {}:\n{feedback}",
                node.data.label
            ),
        )
        .await?;
        // A revision is a new durable result for the target node, not merely
        // transient reviewer context. Persist it before exposing it in memory.
        persist_node_output(context, &target.id, &revised)?;
        context
            .outputs
            .lock()
            .map_err(|_| "outputs lock poisoned".to_string())?
            .insert(target.id.clone(), revised);
        output = specialist_with_retries(
            context,
            node,
            revision,
            "\n\nRe-review the revised upstream work and return success only if all required criteria pass.",
        )
        .await?;
        emit_advisory_failures(context, node, &output);
        reason = if output.status == "needs_revision" {
            Some(output.summary.clone())
        } else {
            required_criteria_failure(&node.data.completion_criteria, &output)
        };
    }
    Err(format!(
        "{} exhausted the revision limit ({max}): {}",
        node.data.label,
        reason.unwrap_or_else(|| "required criteria remain unsatisfied".into())
    ))
}

async fn approval_node(context: &RunContext, node: &RuntimeNode) -> Result<RuntimeOutput, String> {
    let request_id = format!("{}::{}::approval", context.run_id, node.id);
    let (sender, receiver) = mpsc::channel();
    context
        .run_approvals
        .0
        .lock()
        .map_err(|_| "run approval broker lock poisoned".to_string())?
        .insert(request_id.clone(), sender);
    let _ = context.app.emit(
        "workflow-run-approval",
        RunApprovalEvent {
            run_id: context.run_id.clone(),
            request_id: request_id.clone(),
            node_id: node.id.clone(),
            title: node.data.label.clone(),
            detail: "Review the completed required work before releasing delivery.".into(),
        },
    );
    emit_event(
        context,
        "approval.requested",
        "warning",
        Some(&node.id),
        None,
        format!("{} is waiting for operator approval", node.data.label),
        json!({"requestId":request_id}),
    );
    update_run_status(
        &context.app,
        &context.run_id,
        "waiting_approval",
        None,
        true,
    );
    if let Ok(connection) = context.app.state::<Database>().0.lock() {
        let _ = connection.execute(
            "INSERT OR REPLACE INTO approvals(id,run_id,node_id,request_json,decision) VALUES(?1,?2,?3,?4,NULL)",
            params![request_id,context.run_id,node.id,json!({"title":node.data.label,"detail":"Review required work before release"}).to_string()],
        );
    }
    let stop = context.stop.clone();
    let decision_result = tauri::async_runtime::spawn_blocking(move || {
        wait_for_approval(
            &receiver,
            &stop,
            Duration::from_secs(30 * 60),
            Duration::from_millis(250),
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    // Always remove the broker entry, including timeout, cancellation, and
    // sender-disconnect paths. Stale approvals must never be actionable.
    context
        .run_approvals
        .0
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&request_id));
    let decision = decision_result?;
    update_run_status(&context.app, &context.run_id, "running", None, true);
    if !decision {
        if let Ok(connection) = context.app.state::<Database>().0.lock() {
            let _ = connection.execute(
                "UPDATE approvals SET decision='declined' WHERE id=?1",
                params![request_id],
            );
        }
        return Err("operator declined the approval gate".into());
    }
    if let Ok(connection) = context.app.state::<Database>().0.lock() {
        let _ = connection.execute(
            "UPDATE approvals SET decision='approved' WHERE id=?1",
            params![request_id],
        );
    }
    Ok(RuntimeOutput {
        status: "success".into(),
        summary: "Human release approval recorded.".into(),
        data: json!({"decision":"approved","explicitHuman":true}),
        artifacts: Vec::new(),
        thread_id: None,
        turn_id: None,
    })
}

fn wait_for_approval(
    receiver: &mpsc::Receiver<bool>,
    stop: &AtomicBool,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<bool, String> {
    let started = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err("run interrupted while waiting for operator approval".into());
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("operator approval timed out".into());
        }
        match receiver.recv_timeout(remaining.min(poll_interval)) {
            Ok(decision) => return Ok(decision),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("operator approval channel disconnected".into())
            }
        }
    }
}

async fn execute_node(context: &RunContext, node: &RuntimeNode) -> Result<RuntimeOutput, String> {
    if context.stop.load(Ordering::SeqCst) {
        return Err("run interrupted".into());
    }
    match node.data.kind.as_str() {
        "agent" | "creative" => execute_specialist_with_revision(context, node).await,
        "approval" => approval_node(context, node).await,
        "merge" => Ok(RuntimeOutput {
            status: "success".into(),
            summary: "Dependencies joined.".into(),
            data: json!({"control":"merge"}),
            artifacts: Vec::new(),
            thread_id: None,
            turn_id: None,
        }),
        "condition" => {
            let rule = node
                .data
                .condition_rule
                .as_ref()
                .ok_or("condition rule missing")?;
            let source_id = rule.source_node_id.clone().or_else(|| {
                context
                    .graph
                    .edges
                    .iter()
                    .find(|edge| edge.target == node.id)
                    .map(|edge| edge.source.clone())
            });
            let source_id = source_id.ok_or("condition source missing")?;
            let outputs = context
                .outputs
                .lock()
                .map_err(|_| "outputs lock poisoned".to_string())?;
            let source = outputs
                .get(&source_id)
                .ok_or("condition source has no output")?;
            let source_value = serde_json::to_value(source).map_err(|error| error.to_string())?;
            let matched = evaluate_condition(rule, &source_value);
            Ok(RuntimeOutput {
                status: "success".into(),
                summary: format!("Condition evaluated to {matched}."),
                data: json!({"branch":if matched {&rule.true_branch}else{&rule.false_branch},"matched":matched,"sourceNodeId":source_id}),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
            })
        }
        "output" => {
            let outputs = context
                .outputs
                .lock()
                .map_err(|_| "outputs lock poisoned".to_string())?;
            let approved = outputs.values().any(|output| {
                output.data.get("decision").and_then(Value::as_str) == Some("approved")
            });
            if !approved {
                return Err("delivery requires an explicit approved gate".into());
            }
            let handoffs: Vec<Value> = outputs
                .iter()
                .map(|(node_id, output)| {
                    json!({"nodeId":node_id,"status":output.status,"summary":output.summary,"data":output.data,"artifacts":output.artifacts})
                })
                .collect();
            let review = outputs
                .values()
                .find_map(|output| output.data.get("verdict").and_then(Value::as_str))
                .unwrap_or("unknown");
            let bundle = json!({
                "schemaVersion":"codex-corp.delivery.v2",
                "mode":"live",
                "status":"success",
                "review":{"outcome":review},
                "specialistHandoffs":handoffs,
                "safety":{"approval":"explicit-human","chainOfThought":"not-exposed"}
            });
            Ok(RuntimeOutput {
                status: "success".into(),
                summary: "Approved delivery bundle assembled from completed specialist handoffs."
                    .into(),
                data: bundle.clone(),
                artifacts: vec![
                    json!({"id":"delivery-bundle","name":"delivery-bundle.json","kind":"json","content":serde_json::to_string_pretty(&bundle).unwrap_or_default()}),
                ],
                thread_id: None,
                turn_id: None,
            })
        }
        _ => Err(format!("unsupported runtime node kind: {}", node.data.kind)),
    }
}

fn persist_node_output(
    context: &RunContext,
    node_id: &str,
    output: &RuntimeOutput,
) -> Result<(), String> {
    let database = context.app.state::<Database>();
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    persist_node_output_to_connection(&mut connection, &context.run_id, node_id, output)
}

fn persist_node_output_to_connection(
    connection: &mut rusqlite::Connection,
    run_id: &str,
    node_id: &str,
    output: &RuntimeOutput,
) -> Result<(), String> {
    let output_json = serde_json::to_string(output).map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO node_executions(id,run_id,node_id,thread_id,turn_id,status,output_json) VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,turn_id=excluded.turn_id,status=excluded.status,output_json=excluded.output_json",
            params![format!("{run_id}:{node_id}"),run_id,node_id,output.thread_id,output.turn_id,output.status,output_json],
        )
        .map_err(|error| error.to_string())?;
    // Revisions replace the node's artifact set. Removing stale artifacts in
    // the same transaction keeps node output and artifacts atomic.
    transaction
        .execute(
            "DELETE FROM artifacts WHERE run_id=?1 AND node_id=?2",
            params![run_id, node_id],
        )
        .map_err(|error| error.to_string())?;
    for (index, artifact) in output.artifacts.iter().enumerate() {
        let raw_id = artifact
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("artifact");
        transaction
            .execute(
                "INSERT INTO artifacts(id,run_id,node_id,metadata_json) VALUES(?1,?2,?3,?4)",
                params![
                    format!("{run_id}:{node_id}:{index}:{raw_id}"),
                    run_id,
                    node_id,
                    artifact.to_string()
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn dependency_satisfied(
    graph: &RuntimeGraph,
    node_id: &str,
    completed: &HashSet<String>,
    skipped: &HashSet<String>,
) -> bool {
    graph
        .edges
        .iter()
        .filter(|edge| {
            edge.target == node_id
                && edge.data.as_ref().map(|data| data.edge_type.as_str()) != Some("revision")
        })
        .all(|edge| completed.contains(&edge.source) || skipped.contains(&edge.source))
}

fn propagate_skips(
    graph: &RuntimeGraph,
    included: &HashSet<String>,
    completed: &HashSet<String>,
    skipped: &mut HashSet<String>,
) -> Vec<String> {
    let mut newly_skipped = Vec::new();
    let mut changed = true;
    while changed {
        changed = false;
        for node in &graph.nodes {
            if !included.contains(&node.id)
                || node.data.kind == "input"
                || node.data.kind == "cron"
                || node.data.kind == "note"
                || completed.contains(&node.id)
                || skipped.contains(&node.id)
            {
                continue;
            }
            let inbound: Vec<_> = graph
                .edges
                .iter()
                .filter(|edge| {
                    edge.target == node.id
                        && edge.data.as_ref().map(|data| data.edge_type.as_str())
                            != Some("revision")
                })
                .collect();
            if inbound.is_empty() {
                continue;
            }
            let should_skip = if node.data.kind == "merge" {
                inbound.iter().all(|edge| skipped.contains(&edge.source))
            } else {
                inbound.iter().any(|edge| skipped.contains(&edge.source))
            };
            if should_skip {
                skipped.insert(node.id.clone());
                newly_skipped.push(node.id.clone());
                changed = true;
            }
        }
    }
    newly_skipped
}

fn downstream_from(graph: &RuntimeGraph, start: Option<&str>) -> HashSet<String> {
    let Some(start) = start else {
        return graph.nodes.iter().map(|node| node.id.clone()).collect();
    };
    let mut included = HashSet::from([start.to_string()]);
    let mut changed = true;
    while changed {
        changed = false;
        for edge in &graph.edges {
            if edge.data.as_ref().map(|data| data.edge_type.as_str()) == Some("revision") {
                continue;
            }
            if included.contains(&edge.source) && included.insert(edge.target.clone()) {
                changed = true;
            }
        }
    }
    included
}

async fn run_worker(
    context: RunContext,
    workflow_id: String,
    start_node_id: Option<String>,
    resume_checkpoint: Option<RunCheckpoint>,
    runtime: WorkflowRuntime,
) {
    update_run_status(&context.app, &context.run_id, "running", None, false);
    emit_event(
        &context,
        "run.started",
        "info",
        None,
        None,
        "Native workflow runtime started",
        json!({"runtimeVersion":RUNTIME_VERSION}),
    );
    let included = downstream_from(&context.graph, start_node_id.as_deref());
    let mut completed: HashSet<String> = context
        .graph
        .nodes
        .iter()
        .filter(|node| {
            node.data.kind == "input" || node.data.kind == "cron" || !included.contains(&node.id)
        })
        .map(|node| node.id.clone())
        .collect();
    let mut skipped: HashSet<String> = context
        .graph
        .nodes
        .iter()
        .filter(|node| !included.contains(&node.id))
        .map(|node| node.id.clone())
        .collect();
    if let Some(checkpoint) = resume_checkpoint {
        completed.extend(checkpoint.completed);
        skipped.extend(checkpoint.skipped);
        if let Ok(mut outputs) = context.outputs.lock() {
            outputs.extend(checkpoint.outputs);
        }
        emit_event(
            &context,
            "run.checkpoint_restored",
            "info",
            None,
            None,
            "Restored the last safe checkpoint",
            json!({"completed":completed.len(),"skipped":skipped.len()}),
        );
    }
    for input in context
        .graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "input")
    {
        context.outputs.lock().ok().map(|mut outputs| {
            outputs.insert(
                input.id.clone(),
                RuntimeOutput {
                    status: "success".into(),
                    summary: input.data.output.clone().unwrap_or_default(),
                    data: json!({"authorizedMission":true}),
                    artifacts: Vec::new(),
                    thread_id: None,
                    turn_id: None,
                },
            )
        });
    }
    checkpoint(&context, &completed, &skipped);
    let mut terminal_error: Option<String> = None;
    loop {
        if context.stop.load(Ordering::SeqCst) {
            break;
        }
        for node_id in propagate_skips(&context.graph, &included, &completed, &mut skipped) {
            emit_event(
                &context,
                "node.skipped",
                "info",
                Some(&node_id),
                None,
                "Skipped because an upstream branch was excluded",
                json!({"reason":"excluded-upstream"}),
            );
        }
        let ready: Vec<RuntimeNode> = context
            .graph
            .nodes
            .iter()
            .filter(|node| {
                included.contains(&node.id)
                    && node.data.kind != "input"
                    && node.data.kind != "cron"
                    && node.data.kind != "note"
                    && !completed.contains(&node.id)
                    && !skipped.contains(&node.id)
                    && dependency_satisfied(&context.graph, &node.id, &completed, &skipped)
                    && (node.data.kind != "output"
                        || context.graph.nodes.iter().all(|candidate| {
                            candidate.id == node.id
                                || candidate.data.kind == "note"
                                || !included.contains(&candidate.id)
                                || completed.contains(&candidate.id)
                                || skipped.contains(&candidate.id)
                        }))
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            let remaining = context.graph.nodes.iter().any(|node| {
                included.contains(&node.id)
                    && node.data.kind != "note"
                    && !completed.contains(&node.id)
                    && !skipped.contains(&node.id)
            });
            if remaining {
                terminal_error = Some("scheduler reached a dependency deadlock".into());
            }
            break;
        }
        // Observe sibling completion in completion order. Awaiting join
        // handles in insertion order can hide a fast terminal failure behind
        // an unrelated slow node and delay fail-fast cancellation.
        let mut handles = FuturesUnordered::new();
        for node in ready {
            let worker_context = context.clone();
            let node_id = node.id.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let result = execute_node(&worker_context, &node).await;
                (node_id, result)
            }));
        }
        let mut batch_failure: Option<(String, String)> = None;
        while let Some(joined) = handles.next().await {
            match joined {
                Ok((node_id, Ok(output))) => {
                    let branch = output
                        .data
                        .get("branch")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Err(error) = persist_node_output(&context, &node_id, &output) {
                        batch_failure = Some((
                            node_id,
                            format!("failed to persist completed node output: {error}"),
                        ));
                        break;
                    }
                    if let Ok(mut outputs) = context.outputs.lock() {
                        outputs.insert(node_id.clone(), output);
                    }
                    completed.insert(node_id.clone());
                    if let Some(branch) = branch {
                        for edge in context.graph.edges.iter().filter(|edge| {
                            edge.source == node_id
                                && edge.data.as_ref().is_some_and(|data| {
                                    data.edge_type == "conditional"
                                        && data.condition.as_deref() != Some(branch.as_str())
                                })
                        }) {
                            skipped.insert(edge.target.clone());
                            emit_event(
                                &context,
                                "node.skipped",
                                "info",
                                Some(&edge.target),
                                None,
                                format!("Branch {branch} excluded this node"),
                                json!({"conditionNodeId":node_id,"branch":branch}),
                            );
                        }
                    }
                }
                Ok((node_id, Err(error))) => {
                    batch_failure = Some((node_id, error));
                    break;
                }
                Err(error) => {
                    batch_failure = Some(("runtime-worker".into(), error.to_string()));
                    break;
                }
            }
        }
        if let Some((node_id, error)) = batch_failure {
            terminal_error = Some(format!("node {node_id} terminally failed: {error}"));
            context.stop.store(true, Ordering::SeqCst);
            kill_run_processes(&context.process_broker, &context.run_id);
            // Drain sibling workers so no node can publish success after the
            // terminal run event. Their processes have already been stopped.
            while handles.next().await.is_some() {
                // Drain all sibling workers after their processes are killed.
            }
            break;
        }
        checkpoint(&context, &completed, &skipped);
    }
    let (status, reason, resumable) = if let Some(error) = terminal_error {
        ("failed", Some(error), false)
    } else if context.stop.load(Ordering::SeqCst) {
        (
            "interrupted",
            Some("operator or fail-fast interruption".into()),
            true,
        )
    } else {
        ("completed", None, false)
    };
    update_run_status(
        &context.app,
        &context.run_id,
        status,
        reason.as_deref(),
        resumable,
    );
    if status != "completed" {
        if let Ok(connection) = context.app.state::<Database>().0.lock() {
            let _ = connection.execute(
                "DELETE FROM artifacts WHERE run_id=?1 AND json_extract(metadata_json,'$.name')='delivery-bundle.json'",
                params![context.run_id],
            );
            if status == "failed" || status == "cancelled" {
                let _ = connection.execute(
                    "DELETE FROM run_checkpoints WHERE run_id=?1",
                    params![context.run_id],
                );
            }
        }
    }
    emit_event(
        &context,
        &format!("run.{status}"),
        if status == "completed" {
            "info"
        } else {
            "error"
        },
        None,
        None,
        reason.clone().unwrap_or_else(|| format!("Run {status}")),
        json!({"completed":completed,"skipped":skipped,"resumable":resumable}),
    );
    if let Ok(mut active) = runtime.active.lock() {
        active.remove(&context.run_id);
    }
    if let Ok(mut connection) = context.app.state::<Database>().0.lock() {
        if let Ok(settings) = app_settings::load(&connection) {
            let _ = app_settings::cleanup(&mut connection, &settings);
        }
    }
    let _ = workflow_id;
}

fn checkpoint(context: &RunContext, completed: &HashSet<String>, skipped: &HashSet<String>) {
    let outputs = context
        .outputs
        .lock()
        .map(|outputs| outputs.clone())
        .unwrap_or_default();
    let value = serde_json::to_string(&RunCheckpoint {
        completed: completed.clone(),
        skipped: skipped.clone(),
        outputs,
    })
    .unwrap_or_else(|_| "{}".into());
    if let Ok(connection) = context.app.state::<Database>().0.lock() {
        let _ = connection.execute(
            "INSERT INTO run_checkpoints(run_id,checkpoint_json,resumable,updated_at) VALUES(?1,?2,1,CURRENT_TIMESTAMP)
             ON CONFLICT(run_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,resumable=1,updated_at=CURRENT_TIMESTAMP",
            params![context.run_id,value],
        );
    }
}

fn update_run_status(
    app: &tauri::AppHandle,
    run_id: &str,
    status: &str,
    reason: Option<&str>,
    resumable: bool,
) {
    if let Ok(connection) = app.state::<Database>().0.lock() {
        let _ = connection.execute(
            "UPDATE runs SET status=?2,terminal_reason=?3,resumable=?4 WHERE id=?1",
            params![run_id, status, reason, resumable as i32],
        );
    }
}

fn kill_run_processes(process_broker: &ProcessBroker, run_id: &str) {
    let prefix = format!("{run_id}::");
    let children: Vec<_> = process_broker
        .0
        .lock()
        .map(|processes| {
            processes
                .iter()
                .filter(|(key, _)| key.starts_with(&prefix))
                .map(|(_, child)| child.clone())
                .collect()
        })
        .unwrap_or_default();
    for child in children {
        crate::kill_app_server_child(&child);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects command state as individual parameters.
pub(crate) async fn start_run(
    workflow_id: String,
    start_node_id: Option<String>,
    workspace_path: Option<String>,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, WorkflowRuntime>,
    run_approvals: tauri::State<'_, RunApprovalBroker>,
    approval_broker: tauri::State<'_, ApprovalBroker>,
    process_broker: tauri::State<'_, ProcessBroker>,
    database: tauri::State<'_, Database>,
) -> Result<NativeRunRecord, String> {
    let graph_json: String = {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let settings = app_settings::load(&connection)?;
        runtime
            .limiter
            .set_limit(settings.max_concurrent_codex_processes as usize);
        connection
            .query_row(
                "SELECT graph_json FROM workflows WHERE id=?1",
                params![workflow_id],
                |row| row.get(0),
            )
            .map_err(|_| "workflow must be saved before starting a native run".to_string())?
    };
    let graph = parse_graph(&graph_json)?;
    let target_workspace = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(path) = &target_workspace {
        std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
        if !path.is_dir() {
            return Err("Selected app workspace is not a folder".into());
        }
    }
    if let Some(start) = &start_node_id {
        if !graph.nodes.iter().any(|node| &node.id == start) {
            return Err("start node does not exist".into());
        }
    }
    let run_id = new_run_id();
    let nodes_json = serde_json::to_string(&graph.nodes).map_err(|error| error.to_string())?;
    let edges_json = serde_json::to_string(&graph.edges).map_err(|error| error.to_string())?;
    {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO runs(id,workflow_id,status,events_json,nodes_json,edges_json,runtime_version,resumable,workspace_path) VALUES(?1,?2,'queued','[]',?3,?4,?5,1,?6)",
                params![run_id,workflow_id,nodes_json,edges_json,RUNTIME_VERSION,target_workspace.as_ref().map(|path| path.to_string_lossy().into_owned())],
            )
            .map_err(|error| error.to_string())?;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let context = RunContext {
        run_id: run_id.clone(),
        app: app.clone(),
        graph,
        outputs: Arc::new(Mutex::new(HashMap::new())),
        stop: stop.clone(),
        sequence: Arc::new(AtomicU64::new(0)),
        limiter: runtime.limiter.clone(),
        approval_broker: approval_broker.inner().clone(),
        process_broker: process_broker.inner().clone(),
        run_approvals: run_approvals.inner().clone(),
        target_workspace,
    };
    runtime
        .active
        .lock()
        .map_err(|_| "runtime registry lock poisoned".to_string())?
        .insert(
            run_id.clone(),
            ActiveRun {
                workflow_id: workflow_id.clone(),
                status: "running".into(),
                stop,
            },
        );
    let runtime_owned = runtime.inner().clone();
    let workflow_owned = workflow_id.clone();
    tauri::async_runtime::spawn(async move {
        run_worker(context, workflow_owned, start_node_id, None, runtime_owned).await;
    });
    get_run(run_id, database)
}

#[tauri::command]
pub(crate) fn stop_run(
    run_id: String,
    runtime: tauri::State<'_, WorkflowRuntime>,
    process_broker: tauri::State<'_, ProcessBroker>,
) -> Result<(), String> {
    let active = runtime
        .active
        .lock()
        .map_err(|_| "runtime registry lock poisoned".to_string())?
        .get(&run_id)
        .cloned()
        .ok_or("run is not active")?;
    active.stop.store(true, Ordering::SeqCst);
    kill_run_processes(process_broker.inner(), &run_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn respond_run_approval(
    run_id: String,
    request_id: String,
    decision: bool,
    broker: tauri::State<'_, RunApprovalBroker>,
) -> Result<(), String> {
    if !request_id.starts_with(&format!("{run_id}::")) {
        return Err("approval does not belong to this run".into());
    }
    let sender = broker
        .0
        .lock()
        .map_err(|_| "run approval broker lock poisoned".to_string())?
        .remove(&request_id)
        .ok_or("approval is no longer pending")?;
    sender.send(decision).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_run(
    run_id: String,
    database: tauri::State<'_, Database>,
) -> Result<NativeRunRecord, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    connection
        .query_row(
            "SELECT id,workflow_id,status,created_at,terminal_reason,resumable,pinned,last_event_seq,nodes_json,edges_json FROM runs WHERE id=?1",
            params![run_id],
            |row| {
                Ok(NativeRunRecord {
                    id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    status: row.get(2)?,
                    created_at: row.get(3)?,
                    terminal_reason: row.get(4)?,
                    resumable: row.get::<_, i64>(5)? != 0,
                    pinned: row.get::<_, i64>(6)? != 0,
                    last_event_sequence: row.get::<_, i64>(7)? as u64,
                    nodes_json: row.get(8)?,
                    edges_json: row.get(9)?,
                })
            },
        )
        .map_err(|_| "run not found".into())
}

#[tauri::command]
pub(crate) fn list_active_runs(
    workflow_id: Option<String>,
    runtime: tauri::State<'_, WorkflowRuntime>,
) -> Result<Vec<Value>, String> {
    let active = runtime
        .active
        .lock()
        .map_err(|_| "runtime registry lock poisoned".to_string())?;
    Ok(active
        .iter()
        .filter(|(_, run)| workflow_id.as_ref().is_none_or(|id| &run.workflow_id == id))
        .map(|(run_id, run)| json!({"runId":run_id,"workflowId":run.workflow_id,"status":run.status}))
        .collect())
}

#[tauri::command]
pub(crate) async fn resume_run(
    run_id: String,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, WorkflowRuntime>,
    run_approvals: tauri::State<'_, RunApprovalBroker>,
    approval_broker: tauri::State<'_, ApprovalBroker>,
    process_broker: tauri::State<'_, ProcessBroker>,
    database: tauri::State<'_, Database>,
) -> Result<NativeRunRecord, String> {
    let record = get_run(run_id.clone(), database.clone())?;
    if !record.resumable || record.status != "interrupted" {
        return Err("only interrupted resumable runs can be resumed".into());
    }
    let (graph, checkpoint, target_workspace) = {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let checkpoint_json: String = connection
            .query_row(
                "SELECT checkpoint_json FROM run_checkpoints WHERE run_id=?1 AND resumable=1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|_| "run has no safe checkpoint to resume".to_string())?;
        let checkpoint: RunCheckpoint = serde_json::from_str(&checkpoint_json)
            .map_err(|error| format!("run checkpoint is unreadable: {error}"))?;
        let workspace_path: Option<String> = connection
            .query_row(
                "SELECT workspace_path FROM runs WHERE id=?1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        let graph = parse_graph(&json!({"nodes":serde_json::from_str::<Value>(&record.nodes_json).map_err(|e|e.to_string())?,"edges":serde_json::from_str::<Value>(&record.edges_json).map_err(|e|e.to_string())?}).to_string())?;
        (graph, checkpoint, workspace_path.map(PathBuf::from))
    };
    let stop = Arc::new(AtomicBool::new(false));
    let context = RunContext {
        run_id: run_id.clone(),
        app: app.clone(),
        graph,
        outputs: Arc::new(Mutex::new(HashMap::new())),
        stop: stop.clone(),
        sequence: Arc::new(AtomicU64::new(record.last_event_sequence)),
        limiter: runtime.limiter.clone(),
        approval_broker: approval_broker.inner().clone(),
        process_broker: process_broker.inner().clone(),
        run_approvals: run_approvals.inner().clone(),
        target_workspace,
    };
    runtime
        .active
        .lock()
        .map_err(|_| "runtime registry lock poisoned".to_string())?
        .insert(
            run_id.clone(),
            ActiveRun {
                workflow_id: record.workflow_id.clone(),
                status: "running".into(),
                stop,
            },
        );
    let runtime_owned = runtime.inner().clone();
    let workflow_id = record.workflow_id.clone();
    tauri::async_runtime::spawn(async move {
        run_worker(context, workflow_id, None, Some(checkpoint), runtime_owned).await;
    });
    Ok(record)
}

pub(crate) fn initialize(app: &tauri::AppHandle) {
    if let Ok(mut connection) = app.state::<Database>().0.lock() {
        let _ = connection.execute(
            "UPDATE runs SET status='interrupted',resumable=1,terminal_reason='application restarted during run' WHERE status IN ('queued','running','waiting_approval')",
            [],
        );
        let _ = connection.execute(
            "UPDATE node_attempts SET status='interrupted',completed_at=CURRENT_TIMESTAMP WHERE status IN ('queued','running','waiting_approval')",
            [],
        );
        if let Ok(settings) = app_settings::load(&connection) {
            let _ = app_settings::cleanup(&mut connection, &settings);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoints_round_trip_completed_work_and_outputs() {
        let checkpoint = RunCheckpoint {
            completed: HashSet::from(["input".into(), "research".into()]),
            skipped: HashSet::from(["discarded-branch".into()]),
            outputs: HashMap::from([(
                "research".into(),
                RuntimeOutput {
                    status: "success".into(),
                    summary: "evidence".into(),
                    data: json!({"score": 4}),
                    artifacts: Vec::new(),
                    thread_id: Some("thread-1".into()),
                    turn_id: Some("turn-1".into()),
                },
            )]),
        };
        let encoded = serde_json::to_string(&checkpoint).unwrap();
        let restored: RunCheckpoint = serde_json::from_str(&encoded).unwrap();
        assert!(restored.completed.contains("research"));
        assert!(restored.skipped.contains("discarded-branch"));
        assert_eq!(restored.outputs["research"].summary, "evidence");
    }

    #[test]
    fn excluded_condition_branch_skips_descendants_but_not_live_merge() {
        let node = |id: &str, kind: &str| RuntimeNode {
            id: id.into(),
            data: RuntimeNodeData {
                label: id.into(),
                role: id.into(),
                kind: kind.into(),
                model: String::new(),
                effort: default_effort(),
                tools: Vec::new(),
                connector_tools: Vec::new(),
                skills: Vec::new(),
                active_skill: None,
                permission_profile: None,
                collaboration_mode: None,
                personality: None,
                prompt: String::new(),
                output: None,
                completion_criteria: Vec::new(),
                max_retries: 0,
                approval_policy: default_approval(),
                sandbox_profile: default_sandbox(),
                workspace_policy: default_workspace(),
                output_schema: None,
                condition_rule: None,
            },
        };
        let edge = |id: &str, source: &str, target: &str| RuntimeEdge {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            data: None,
        };
        let graph = RuntimeGraph {
            nodes: vec![
                node("chosen", "agent"),
                node("excluded", "agent"),
                node("excluded-child", "agent"),
                node("merge", "merge"),
            ],
            edges: vec![
                edge("a", "chosen", "merge"),
                edge("b", "excluded", "excluded-child"),
                edge("c", "excluded-child", "merge"),
            ],
        };
        let included = graph.nodes.iter().map(|node| node.id.clone()).collect();
        let completed = HashSet::from(["chosen".to_string()]);
        let mut skipped = HashSet::from(["excluded".to_string()]);
        let propagated = propagate_skips(&graph, &included, &completed, &mut skipped);
        assert!(propagated.contains(&"excluded-child".to_string()));
        assert!(!skipped.contains("merge"));
    }

    #[test]
    fn workspace_write_is_valid_with_never_approval() {
        let node = RuntimeNode {
            id: "creative".into(),
            data: RuntimeNodeData {
                label: "Image Studio".into(),
                role: "Creative".into(),
                kind: "creative".into(),
                model: "gpt".into(),
                effort: default_effort(),
                tools: vec!["Workspace write".into()],
                connector_tools: vec!["codex_apps::figma.generate_asset".into()],
                skills: vec!["imagegen".into()],
                active_skill: Some("imagegen".into()),
                permission_profile: Some(":workspace".into()),
                collaboration_mode: Some("default".into()),
                personality: Some("pragmatic".into()),
                prompt: String::new(),
                output: None,
                completion_criteria: Vec::new(),
                max_retries: 0,
                approval_policy: "never".into(),
                // Ignored because the live named profile is authoritative.
                sandbox_profile: "read-only".into(),
                workspace_policy: default_workspace(),
                output_schema: None,
                condition_rule: None,
            },
        };
        assert_eq!(
            tool_policy(&node).unwrap(),
            ("workspace-write".into(), "never".into())
        );
        let prompt = connector_capability_instructions(&node);
        assert!(prompt.contains("imagegen"));
        assert!(prompt.contains("figma.generate_asset"));
    }

    #[test]
    fn safe_condition_rules_evaluate_without_code_execution() {
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.data.score".into(),
            operator: ">=".into(),
            value: Some(json!(80)),
            true_branch: "ship".into(),
            false_branch: "iterate".into(),
        };
        validate_condition_rule(Some(&rule)).unwrap();
        assert!(evaluate_condition(&rule, &json!({"data":{"score":82}})));
        assert!(validate_condition_rule(Some(&ConditionRule {
            path: "window.alert(1)".into(),
            ..rule
        }))
        .is_err());
    }

    #[test]
    fn downstream_scope_excludes_unrelated_ancestors() {
        let graph: RuntimeGraph = serde_json::from_value(json!({
            "nodes":[
                {"id":"input","data":{"label":"Input","role":"Input","kind":"input"}},
                {"id":"a","data":{"label":"A","role":"A","kind":"agent"}},
                {"id":"b","data":{"label":"B","role":"B","kind":"agent"}}
            ],
            "edges":[{"id":"ia","source":"input","target":"a"},{"id":"ab","source":"a","target":"b"}]
        })).unwrap();
        assert_eq!(
            downstream_from(&graph, Some("a")),
            HashSet::from(["a".into(), "b".into()])
        );
    }

    #[test]
    fn approval_wait_observes_cancellation_without_waiting_for_timeout() {
        let (_sender, receiver) = mpsc::channel();
        let stop = AtomicBool::new(true);
        let started = Instant::now();
        let result = wait_for_approval(
            &receiver,
            &stop,
            Duration::from_secs(60),
            Duration::from_millis(10),
        );
        assert!(result.unwrap_err().contains("interrupted"));
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn approval_wait_returns_the_operator_decision() {
        let (sender, receiver) = mpsc::channel();
        sender.send(true).unwrap();
        let stop = AtomicBool::new(false);
        assert!(wait_for_approval(
            &receiver,
            &stop,
            Duration::from_secs(1),
            Duration::from_millis(10),
        )
        .unwrap());
    }

    fn persistence_fixture() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::initialize_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO workflows(id,name,graph_json) VALUES('w','Workflow','{}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runs(id,workflow_id,status,events_json) VALUES('r','w','running','[]')",
                [],
            )
            .unwrap();
        connection
    }

    fn output_with_artifacts(names: &[&str]) -> RuntimeOutput {
        RuntimeOutput {
            status: "success".into(),
            summary: "durable output".into(),
            data: json!({"ok":true}),
            artifacts: names
                .iter()
                .map(|name| json!({"id":name,"name":name,"kind":"text"}))
                .collect(),
            thread_id: Some("thread".into()),
            turn_id: Some("turn".into()),
        }
    }

    #[test]
    fn node_output_and_artifacts_commit_atomically() {
        let mut connection = persistence_fixture();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_artifacts BEFORE INSERT ON artifacts
                 BEGIN SELECT RAISE(ABORT, 'artifact failure'); END;",
            )
            .unwrap();
        let result = persist_node_output_to_connection(
            &mut connection,
            "r",
            "builder",
            &output_with_artifacts(&["app"]),
        );
        assert!(result.is_err());
        let executions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM node_executions WHERE run_id='r'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(executions, 0, "partial node output must roll back");
    }

    #[test]
    fn revised_output_replaces_stale_artifacts() {
        let mut connection = persistence_fixture();
        persist_node_output_to_connection(
            &mut connection,
            "r",
            "builder",
            &output_with_artifacts(&["old-a", "old-b"]),
        )
        .unwrap();
        persist_node_output_to_connection(
            &mut connection,
            "r",
            "builder",
            &output_with_artifacts(&["new"]),
        )
        .unwrap();
        let artifacts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE run_id='r' AND node_id='builder'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(artifacts, 1);
        let metadata: String = connection
            .query_row(
                "SELECT metadata_json FROM artifacts WHERE run_id='r' AND node_id='builder'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(metadata.contains("new"));
        assert!(!metadata.contains("old-a"));
    }
}
