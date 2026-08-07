use chrono::{Datelike, Timelike, Utc};
use chrono_tz::Tz;
use futures_util::stream::{FuturesUnordered, StreamExt};
use parking_lot::{Condvar, Mutex};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use crate::app_settings;
use crate::verifier::{
    architecture_policy_failed, artifact_exists_failed, artifact_hash_set_key, attempt_fingerprint,
    classify_failure, collect_upstream_artifacts, command_failed, delivery_pair_compare,
    freeze_approval_snapshot, is_plateau, materialize_artifacts, ApprovedArtifact,
    DeliveryCompareResult, FailureClass, ProcessCommandRunner,
};
use crate::{
    execute_agent_internal, AgentRequest, AgentResult, ApprovalBroker, Database, ProcessBroker,
    TurnStdinBroker,
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

impl WorkflowRuntime {
    /// Active runs for MCP / headless status tools.
    pub(crate) fn list_active(&self, workflow_id: Option<&str>) -> Result<Vec<Value>, String> {
        let active = self.active.lock();
        Ok(active
            .iter()
            .filter(|(_, run)| workflow_id.map(|id| run.workflow_id == id).unwrap_or(true))
            .map(|(run_id, run)| {
                json!({"runId":run_id,"workflowId":run.workflow_id,"status":run.status})
            })
            .collect())
    }

    pub(crate) fn stop_run_internal(
        &self,
        run_id: &str,
        process_broker: &ProcessBroker,
        turn_stdin_broker: &TurnStdinBroker,
    ) -> Result<(), String> {
        let active = self.active.lock();
        let active_run = active
            .get(run_id)
            .cloned()
            .ok_or_else(|| "run is not active".to_string())?;
        active_run.stop.store(true, Ordering::SeqCst);
        drop(active);
        kill_run_processes(process_broker, turn_stdin_broker, run_id);
        Ok(())
    }
}

#[derive(Clone)]
struct ActiveRun {
    workflow_id: String,
    status: String,
    stop: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct RunApprovalBroker(pub(crate) Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>);

impl Default for RunApprovalBroker {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[derive(Debug)]
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
        let mut active = self.active.lock();
        while ticket != self.serving_ticket.load(Ordering::SeqCst)
            || *active >= self.limit.load(Ordering::SeqCst)
        {
            if stop.load(Ordering::SeqCst) {
                self.serving_ticket.fetch_add(1, Ordering::SeqCst);
                self.changed.notify_all();
                return Err("run interrupted while queued for a Codex process".into());
            }
            let _ = self
                .changed
                .wait_for(&mut active, Duration::from_millis(250));
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

#[derive(Debug)]
struct ProcessPermit(Arc<ProcessLimiter>);

impl Drop for ProcessPermit {
    fn drop(&mut self) {
        let mut active = self.0.active.lock();
        *active = active.saturating_sub(1);
        self.0.changed.notify_all();
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
    /// Authored harness-like base; empty = omit baseInstructions (native opt-in).
    #[serde(default)]
    base_instructions: String,
    /// Role/developer contract. Falls back to legacy `prompt` when empty.
    #[serde(default)]
    developer_instructions: String,
    #[serde(default)]
    output: Option<String>,
    /// Operator observations from a completed local test, routed explicitly to
    /// the next producer invocation.
    #[serde(default)]
    user_test_feedback: Vec<String>,
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
    input_schema: Option<String>,
    #[serde(default)]
    output_schema: Option<String>,
    #[serde(default = "default_timeout_seconds")]
    timeout_seconds: u64,
    #[serde(default)]
    requires_approval: bool,
    #[serde(default)]
    hard_criteria_gate: bool,
    #[serde(default)]
    condition_rule: Option<ConditionRule>,
    #[serde(default)]
    cron_expression: Option<String>,
    #[serde(default)]
    cron_timezone: Option<String>,
    #[serde(default = "default_true")]
    cron_enabled: bool,
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
fn default_timeout_seconds() -> u64 {
    120
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCriterion {
    id: String,
    label: String,
    #[serde(deserialize_with = "deserialize_criterion_kind")]
    kind: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    platform: bool,
    #[serde(default = "default_required")]
    enforcement: String,
    #[serde(default)]
    instruction: Option<String>,
    /// command verifier: allowlisted template id (npm_test, cargo_test, …)
    #[serde(default)]
    template_id: Option<String>,
    /// artifact_exists: expected artifact name (or path fragment)
    #[serde(default)]
    artifact_name: Option<String>,
    /// artifact_exists alternate path field
    #[serde(default)]
    artifact_path: Option<String>,
    /// architecture_policy policy id (default native_runtime_ownership_v1)
    #[serde(default)]
    policy_id: Option<String>,
}

fn deserialize_criterion_kind<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    // Single SSOT with lib::deserialize_graph_criterion_kind (trim + custom→claim).
    Ok(crate::verifier::normalize_kind(&raw))
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
    /// Live Codex total tokens for this node attempt (0 when unknown / non-LLM nodes).
    #[serde(default)]
    tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeExecutionFailure {
    owner_node_id: Option<String>,
    message: String,
}

impl NodeExecutionFailure {
    fn owned(node_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            owner_node_id: Some(node_id.into()),
            message: message.into(),
        }
    }

    fn owner_or<'a>(&'a self, fallback: &'a str) -> &'a str {
        self.owner_node_id.as_deref().unwrap_or(fallback)
    }
}

impl From<String> for NodeExecutionFailure {
    fn from(message: String) -> Self {
        Self {
            owner_node_id: None,
            message,
        }
    }
}

impl From<&str> for NodeExecutionFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
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
            tokens: result.tokens,
        }
    }
}

#[derive(Clone)]
struct RunContext {
    run_id: String,
    workflow_id: String,
    /// Present for desktop UI event fan-out; `None` in headless / MCP-only runs.
    app: Option<tauri::AppHandle>,
    /// Shared SQLite handle (always available; does not require AppHandle).
    database: Database,
    graph: RuntimeGraph,
    outputs: Arc<Mutex<HashMap<String, RuntimeOutput>>>,
    /// Cumulative per-node usage for this run, including failed retries and revisions.
    node_tokens: Arc<Mutex<HashMap<String, u64>>>,
    stop: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
    limiter: Arc<ProcessLimiter>,
    approval_broker: ApprovalBroker,
    process_broker: ProcessBroker,
    turn_stdin_broker: TurnStdinBroker,
    run_approvals: RunApprovalBroker,
    target_workspace: Option<PathBuf>,
}

pub(crate) use crate::{db_guard_for as database_guard_for, runtime_lock as poison_aware_lock};

fn safe_lock<'a, T: ?Sized>(
    context: &RunContext,
    mutex: &'a Mutex<T>,
    name: &str,
) -> parking_lot::MutexGuard<'a, T> {
    crate::runtime_lock(mutex, name, Some(&context.run_id))
}

fn database_guard<'a>(
    context: &'a RunContext,
) -> parking_lot::MutexGuard<'a, rusqlite::Connection> {
    context.database.0.lock()
}

fn record_node_tokens(context: &RunContext, node_id: &str, attempt_tokens: u64) -> u64 {
    let mut totals = safe_lock(context, &context.node_tokens, "node_tokens");
    let total = totals.entry(node_id.to_string()).or_default();
    *total = total.saturating_add(attempt_tokens);
    *total
}

/// Cumulative token total for a node in the current run.
fn node_token_total(context: &RunContext, node_id: &str) -> u64 {
    let totals = safe_lock(context, &context.node_tokens, "node_tokens");
    totals.get(node_id).copied().unwrap_or(0)
}

/// Durable record of how a node pattern (role/model/effort) has behaved in
/// past runs. Drives inline self-improvement and is exposed to the editor and
/// workflow chat for longer-loop learning.
#[derive(Debug, Clone)]
struct NodeExperience {
    node_id: String,
    workflow_id: String,
    role: String,
    model: String,
    effort: String,
    failure_class: Option<String>,
    stop_reason: Option<String>,
    outcome: String,
    attempt_count: u32,
    total_tokens: u64,
    latency_ms: u64,
}

/// Record a durable experience row for a node. Returns an error so the caller
/// can decide whether to fail the run or emit a warning and continue.
fn record_node_experience(context: &RunContext, row: &NodeExperience) -> Result<(), String> {
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
pub(crate) fn get_node_experience(
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
fn load_node_experience(context: &RunContext, node: &RuntimeNode) -> Result<Vec<Value>, String> {
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
fn experience_guidance(records: &[Value]) -> Option<String> {
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

fn load_node_token_totals(
    connection: &rusqlite::Connection,
    run_id: &str,
) -> Result<HashMap<String, u64>, String> {
    let mut statement = connection
        .prepare("SELECT node_id,diagnostics_json FROM node_attempts WHERE run_id=?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut totals = HashMap::new();
    for row in rows {
        let (node_id, diagnostics) = row.map_err(|error| error.to_string())?;
        let tokens = serde_json::from_str::<Value>(&diagnostics)
            .ok()
            .and_then(|value| {
                value
                    .get("attemptTokens")
                    .or_else(|| value.get("tokens"))
                    .and_then(Value::as_u64)
            })
            .unwrap_or(0);
        let total = totals.entry(node_id).or_insert(0_u64);
        *total = total.saturating_add(tokens);
    }
    Ok(totals)
}

fn new_run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = RUN_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("run-{millis:x}-{counter:x}")
}

/// Persist a verification-driven revision routing as a `node_attempts`-style
/// record (P3). The verification gate itself has no Codex attempt, so analytics
/// would otherwise miss "verification → revision" loops per node. Each routing
/// of a required verification failure writes a row carrying
/// `failureClass:"verification"` and the failing criterion id(s), queryable via
/// `count_verification_revisions`-style SQL on `node_attempts`.
fn record_verification_revision(
    context: &RunContext,
    reviewer_node_id: &str,
    routed_to_node_id: &str,
    revision: u32,
    criterion_ids: &[String],
    feedback: &str,
) {
    let id = format!(
        "{}:{reviewer_node_id}:verification:r{revision}",
        context.run_id
    );
    let diagnostics = json!({
        "failureClass": "verification",
        "gate": "verification",
        "criterionIds": criterion_ids,
        "routedTo": routed_to_node_id,
        "revision": revision,
        "summary": feedback,
    });
    {
        let connection = database_guard(context);
        let _ = connection.execute(
            "INSERT OR REPLACE INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json,completed_at) VALUES(?1,?2,?3,?4,?5,'failed',?6,CURRENT_TIMESTAMP)",
            params![id, context.run_id, reviewer_node_id, 0_i64, revision, diagnostics.to_string()],
        );
    }
}

/// Count verification-gate revisions routed for a node in a run (analytics for
/// "verification → revision" loops). JSON1 is enabled on the shared SQLite.
#[cfg(test)]
fn count_verification_revisions(
    connection: &rusqlite::Connection,
    run_id: &str,
    node_id: &str,
) -> Result<u64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM node_attempts
             WHERE run_id=?1 AND node_id=?2
               AND json_extract(diagnostics_json,'$.failureClass')='verification'
               AND json_extract(diagnostics_json,'$.gate')='verification'",
            params![run_id, node_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count as u64)
        .map_err(|error| error.to_string())
}

/// Per-node verification-revision analytics (P4). Surfaces "how many
/// verification → revision loops per node?" from `node_attempts`, including the
/// failing criterion ids carried by `record_verification_revision`. Exposed as a
/// Tauri command (`analytics_verification_loops`) and MCP tool.
pub(crate) fn verification_loops_for_run(
    connection: &rusqlite::Connection,
    run_id: &str,
) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "SELECT node_id, diagnostics_json
             FROM node_attempts
             WHERE run_id=?1
               AND json_extract(diagnostics_json,'$.failureClass')='verification'
               AND json_extract(diagnostics_json,'$.gate')='verification'
             ORDER BY node_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut by_node: BTreeMap<String, (u64, BTreeSet<String>)> = BTreeMap::new();
    for row in rows {
        let (node_id, diagnostics) = row.map_err(|error| error.to_string())?;
        let entry = by_node.entry(node_id).or_default();
        entry.0 += 1;
        if let Ok(value) = serde_json::from_str::<Value>(&diagnostics) {
            if let Some(ids) = value.get("criterionIds").and_then(Value::as_array) {
                for id in ids {
                    if let Some(id) = id.as_str() {
                        entry.1.insert(id.to_string());
                    }
                }
            }
        }
    }
    let nodes: Vec<Value> = by_node
        .into_iter()
        .map(|(node_id, (revisions, criterion_ids))| {
            json!({
                "nodeId": node_id,
                "verificationRevisions": revisions,
                "criterionIds": criterion_ids.into_iter().collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "runId": run_id, "nodes": nodes }))
}

fn now_isoish() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn event_item_type(event_type: &str) -> &'static str {
    match event_type.split('.').next().unwrap_or_default() {
        "node" => "node",
        "approval" => "approval",
        "verification" => "verification",
        "edge" => "edge",
        "run" | "workflow" => "run",
        _ => "runtime",
    }
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
    let mut safe_diagnostics = crate::redact_sensitive(diagnostics);
    if let Value::Object(fields) = &mut safe_diagnostics {
        fields
            .entry("itemType".to_string())
            .or_insert_with(|| json!(event_item_type(event_type)));
    } else {
        safe_diagnostics = json!({
            "itemType": event_item_type(event_type),
            "detail": safe_diagnostics,
        });
    }
    let event = WorkflowRunEvent {
        run_id: context.run_id.clone(),
        node_id: node_id.map(str::to_string),
        attempt_id: attempt_id.map(str::to_string),
        sequence,
        event_type: event_type.into(),
        level: level.into(),
        at: now_isoish(),
        message: message.into(),
        diagnostics: safe_diagnostics,
    };
    {
        let connection = database_guard(context);
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
    if let Some(app) = &context.app {
        let _ = app.emit("workflow-run-event", event);
    }
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
            "\n\nCOMPLETION CRITERIA:\n{}\nFor claim criteria, return data.criteria[] entries with exact id, claim (satisfied|not_satisfied|unknown), evidence text, and optional evidencePaths. Your claim is not final — runtime verifiers own the pass bit. Do not treat passed:true as completion authority.",
            rows.join("\n")
        )
    }
}

/// Look up a precomputed verification.results row (plan III.4 SSOT).
/// Returns (passed, detail) when a matching id is present.
fn verification_result_row(output: &RuntimeOutput, criterion_id: &str) -> Option<(bool, String)> {
    let results = output
        .data
        .get("verification")
        .and_then(|v| v.get("results"))
        .and_then(Value::as_array)?;
    let row = results
        .iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(criterion_id))?;
    let passed = row.get("passed").and_then(Value::as_bool)?;
    let detail = row
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some((passed, detail))
}

/// A required completion-criterion failure with the failing criterion id(s). The
/// ids feed the persisted `failureClass:"verification"` attempt records (P3).
#[derive(Debug, Clone)]
struct RequiredCriteriaFailure {
    message: String,
    criterion_ids: Vec<String>,
}

fn required_criteria_failure(
    criteria: &[RuntimeCriterion],
    output: &RuntimeOutput,
    context: &RunContext,
    hard_criteria_gate: bool,
) -> Option<RequiredCriteriaFailure> {
    for criterion in criteria {
        let required =
            hard_criteria_gate || criterion.platform || criterion.enforcement == "required";
        if !required || (!criterion.enabled && !criterion.platform) {
            continue;
        }
        // Prefer precomputed verification.results (plan III.4) — do not re-run
        // expensive host verifiers (command / architecture_policy).
        if let Some((passed, detail)) = verification_result_row(output, &criterion.id) {
            if !passed {
                return Some(RequiredCriteriaFailure {
                    message: format!(
                        "required completion criterion failed: {} — {}",
                        criterion.label, detail
                    ),
                    criterion_ids: vec![criterion.id.clone()],
                });
            }
            continue;
        }
        // Fallback only when no verification row exists (legacy / non-specialist).
        let eval = evaluate_criterion(criterion, output, context);
        if eval.failed {
            return Some(RequiredCriteriaFailure {
                message: format!(
                    "required completion criterion failed: {} — {}",
                    criterion.label, eval.detail
                ),
                criterion_ids: vec![criterion.id.clone()],
            });
        }
    }
    None
}

/// Host evaluation of one criterion with operator-facing detail (N1/SSOT chips).
#[derive(Debug, Clone)]
struct CriterionEval {
    failed: bool,
    detail: String,
    /// Specific method string (kind or template/policy id).
    method: String,
    residual_risks: Vec<String>,
}

fn evaluate_structured_json(output: &RuntimeOutput) -> CriterionEval {
    let status = output.status.trim();
    let summary_ok = !output.summary.trim().is_empty();
    let status_ok = matches!(status, "success" | "failure" | "needs_revision");
    let failed = !summary_ok || !status_ok;
    CriterionEval {
        failed,
        detail: if failed {
            "missing status and/or summary in structured result".into()
        } else {
            format!("status={status}; summary present")
        },
        method: "structured_json".into(),
        residual_risks: Vec::new(),
    }
}

fn evaluate_claim_criterion(
    criterion: &RuntimeCriterion,
    output: &RuntimeOutput,
    required: bool,
) -> CriterionEval {
    if required {
        return CriterionEval {
            failed: true,
            detail: "required claim cannot own the pass bit".into(),
            method: "claim".into(),
            residual_risks: Vec::new(),
        };
    }
    let entry = output
        .data
        .get("criteria")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(criterion.id.as_str()))
        });
    let text = entry
        .and_then(|item| {
            item.get("evidence")
                .and_then(Value::as_str)
                .or_else(|| item.get("note").and_then(Value::as_str))
        })
        .unwrap_or("")
        .trim();
    let claim = entry
        .and_then(|item| item.get("claim").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let passed_false = entry
        .and_then(|item| item.get("passed"))
        .and_then(Value::as_bool)
        == Some(false);
    // Ignore producer passed:true as sole authority. Fail on empty
    // evidence, explicit negative claim, or passed:false.
    let failed =
        text.is_empty() || passed_false || matches!(claim.as_str(), "not_satisfied" | "unknown");
    CriterionEval {
        failed,
        detail: if text.is_empty() {
            "no claim evidence text".into()
        } else if failed {
            format!("claim={claim} (advisory evidence present but not satisfied)")
        } else {
            text.to_string()
        },
        method: "claim".into(),
        residual_risks: Vec::new(),
    }
}

fn normalized_private_reasoning_key(key: &str) -> String {
    normalized_private_reasoning_label(key).replace(' ', "_")
}

fn normalized_private_reasoning_label(label: &str) -> String {
    label
        .trim()
        .to_ascii_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_private_reasoning_label(label: &str) -> bool {
    matches!(
        normalized_private_reasoning_label(label).as_str(),
        "chain of thought"
            | "hidden reasoning"
            | "internal monologue"
            | "reasoning content"
            | "scratchpad"
    )
}

fn private_reasoning_section(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().collect();
    lines.iter().enumerate().any(|(index, line)| {
        let mut cleaned = line.trim();
        cleaned = cleaned.trim_start_matches('#').trim();
        cleaned = cleaned
            .strip_prefix("- ")
            .or_else(|| cleaned.strip_prefix("* "))
            .unwrap_or(cleaned)
            .trim();
        if let Some((label, content)) = cleaned.split_once(':') {
            if is_private_reasoning_label(label) {
                return !content.trim().is_empty()
                    || lines[index + 1..]
                        .iter()
                        .any(|following| !following.trim().is_empty());
            }
        }
        is_private_reasoning_label(cleaned)
            && lines[index + 1..]
                .iter()
                .any(|following| !following.trim().is_empty())
    })
}

fn hidden_reasoning_value_violation(value: &Value, path: &str, depth: usize) -> Option<String> {
    if depth > 32 {
        return Some(format!("{path} exceeds the private-reasoning scan depth"));
    }
    match value {
        Value::String(text) => {
            if private_reasoning_section(text) {
                return Some(format!("private-reasoning section marker at {path}"));
            }
            let trimmed = text.trim();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                if let Ok(encoded) = serde_json::from_str::<Value>(trimmed) {
                    return hidden_reasoning_value_violation(&encoded, path, depth + 1);
                }
            }
            None
        }
        Value::Array(items) => items.iter().enumerate().find_map(|(index, item)| {
            hidden_reasoning_value_violation(item, &format!("{path}[{index}]"), depth + 1)
        }),
        Value::Object(entries) => entries.iter().find_map(|(key, child)| {
            let child_path = format!("{path}.{key}");
            if matches!(
                normalized_private_reasoning_key(key).as_str(),
                "chain_of_thought"
                    | "hidden_reasoning"
                    | "internal_monologue"
                    | "reasoning_content"
                    | "scratchpad"
            ) {
                return Some(format!("explicit private-reasoning field at {child_path}"));
            }
            hidden_reasoning_value_violation(child, &child_path, depth + 1)
        }),
        _ => None,
    }
}

fn hidden_reasoning_violation(summary: &str, data: &Value) -> Option<String> {
    hidden_reasoning_value_violation(&Value::String(summary.into()), "summary", 0)
        .or_else(|| hidden_reasoning_value_violation(data, "data", 0))
}

fn evaluate_criterion(
    criterion: &RuntimeCriterion,
    output: &RuntimeOutput,
    context: &RunContext,
) -> CriterionEval {
    // Shared alias: custom → claim (also applied at deserialize).
    let kind = crate::verifier::normalize_kind(&criterion.kind);
    let required = criterion.platform || criterion.enforcement == "required";
    match kind.as_str() {
        // Text/JSON criteria remain runtime-local (not host I/O).
        "structured_json" => evaluate_structured_json(output),
        "concise_summary" => {
            let words = output.summary.split_whitespace().count();
            let failed = !(3..=600).contains(&words);
            CriterionEval {
                failed,
                detail: if failed {
                    if words < 3 {
                        "summary too short".into()
                    } else {
                        "summary exceeds concise limit (~600 words)".into()
                    }
                } else {
                    format!("{words} words")
                },
                method: "concise_summary".into(),
                residual_risks: Vec::new(),
            }
        }
        "no_hidden_reasoning" => {
            let violation = hidden_reasoning_violation(&output.summary, &output.data);
            CriterionEval {
                failed: violation.is_some(),
                detail: violation.unwrap_or_else(|| {
                    "no explicit private-reasoning fields or sections detected".into()
                }),
                method: "no_hidden_reasoning".into(),
                residual_risks: Vec::new(),
            }
        }
        // Claim never owns required pass bit. Required claim always fails;
        // advisory claim needs evidence and non-negative claim enum.
        // Ignore producer passed:true as sole authority.
        // Still runtime-local (text evidence in data.criteria).
        "claim" => evaluate_claim_criterion(criterion, output, required),
        // Host I/O kinds: verifier/* only, explicit workspace (no CWD fallback).
        "artifact_exists" => {
            let failed = artifact_exists_failed(
                criterion.artifact_name.as_deref(),
                criterion.artifact_path.as_deref(),
                &output.artifacts,
            );
            let needle = criterion
                .artifact_name
                .as_deref()
                .or(criterion.artifact_path.as_deref())
                .unwrap_or("(any artifact)");
            CriterionEval {
                failed,
                detail: if failed {
                    format!("missing artifact matching {needle}")
                } else {
                    format!("artifact present matching {needle}")
                },
                method: "artifact_exists".into(),
                residual_risks: Vec::new(),
            }
        }
        "command" => {
            // Fail closed: never fall back to process CWD (install dir / monorepo root).
            let Some(cwd) = context.target_workspace.as_ref() else {
                return CriterionEval {
                    failed: true,
                    detail: "workspacePath is required for command criteria".into(),
                    method: "command".into(),
                    residual_risks: Vec::new(),
                };
            };
            let runner = ProcessCommandRunner::default();
            let template = criterion.template_id.as_deref().unwrap_or("");
            let (failed, detail) = command_failed(
                &runner,
                criterion.template_id.as_deref(),
                criterion.instruction.as_deref(),
                cwd,
                &context.stop,
            );
            CriterionEval {
                failed,
                detail,
                method: if template.is_empty() {
                    "command".into()
                } else {
                    format!("command:{template}")
                },
                residual_risks: Vec::new(),
            }
        }
        "architecture_policy" => {
            // Fail closed: never fall back to process CWD (install dir / monorepo root).
            let Some(cwd) = context.target_workspace.as_ref() else {
                return CriterionEval {
                    failed: true,
                    detail: "workspacePath is required for architecture_policy criteria".into(),
                    method: "architecture_policy".into(),
                    residual_risks: Vec::new(),
                };
            };
            let policy = criterion
                .policy_id
                .as_deref()
                .unwrap_or("native_runtime_ownership_v1");
            let arch = architecture_policy_failed(criterion.policy_id.as_deref(), cwd);
            CriterionEval {
                failed: arch.failed,
                detail: arch.detail,
                method: format!("architecture_policy:{policy}"),
                residual_risks: arch.residual_risks,
            }
        }
        // Fail-closed: unknown/unimplemented required kinds must never pass.
        other => CriterionEval {
            failed: required,
            detail: if required {
                format!("unknown required criterion kind: {other}")
            } else {
                format!("unknown advisory criterion kind: {other}")
            },
            method: other.into(),
            residual_risks: Vec::new(),
        },
    }
}

fn emit_advisory_failures(context: &RunContext, node: &RuntimeNode, output: &RuntimeOutput) {
    for criterion in node.data.completion_criteria.iter().filter(|criterion| {
        criterion.enabled && !criterion.platform && criterion.enforcement == "advisory"
    }) {
        // Prefer verification.results SSOT so advisory command/architecture do not re-run.
        let (failed, detail, method) =
            if let Some((passed, detail)) = verification_result_row(output, &criterion.id) {
                (!passed, detail, "verification.results".to_string())
            } else {
                let eval = evaluate_criterion(criterion, output, context);
                (eval.failed, eval.detail, eval.method)
            };
        if failed {
            emit_event(
                context,
                "criterion.advisory_failed",
                "warning",
                Some(&node.id),
                None,
                format!("Advisory criterion not satisfied: {}", criterion.label),
                json!({"criterionId":criterion.id,"detail":detail,"method":method}),
            );
        }
    }
}

/// Collect host verification blocks from specialist outputs (delivery SSOT).
fn collect_verification_summary(outputs: &HashMap<String, RuntimeOutput>) -> Vec<Value> {
    outputs
        .values()
        .filter_map(|o| o.data.get("verification").cloned())
        .collect()
}

/// Plan III.12: every completed specialist/creative output must carry a host verification block.
/// Missing block → fail closed at delivery (prevents silent skip of runtime SSOT).
fn require_specialist_verification_blocks(
    graph: &RuntimeGraph,
    outputs: &HashMap<String, RuntimeOutput>,
) -> Result<(), String> {
    for node in &graph.nodes {
        if node.data.kind != "agent" && node.data.kind != "creative" {
            continue;
        }
        let Some(output) = outputs.get(&node.id) else {
            continue;
        };
        if output.data.get("verification").is_none() {
            return Err(format!(
                "delivery rejected: specialist {} ({}) missing data.verification block",
                node.id, node.data.label
            ));
        }
    }
    Ok(())
}

/// Resolve content_hash for an artifact row: prefer stored value; recompute when NULL/empty.
/// Used so resume/load of pre-migration rows does not treat missing hash as a match token.
fn resolve_artifact_content_hash(stored: Option<&str>, content: &str) -> String {
    match stored.map(str::trim).filter(|s| !s.is_empty()) {
        Some(hash) => hash.to_string(),
        None => crate::verifier::types::content_hash_for(content),
    }
}

fn tool_policy(node: &RuntimeNode) -> Result<(String, String), String> {
    let sandbox_profile = match node.data.permission_profile.as_deref() {
        Some(profile) if profile.contains("read-only") => "read-only".to_string(),
        Some(_) => "workspace-write".to_string(),
        None => node.data.sandbox_profile.clone(),
    };
    let write_selected = node
        .data
        .tools
        .iter()
        .any(|tool| tool.to_ascii_lowercase().contains("write"));
    if write_selected && sandbox_profile == "read-only" {
        return Err(format!(
            "{} selects write capability with a read-only sandbox",
            node.data.label
        ));
    }
    Ok((sandbox_profile, node.data.approval_policy.clone()))
}

fn resolve_json_path(root: &Value, path: &str) -> Option<Value> {
    let mut current = root;
    for segment in path.strip_prefix("$.")?.split('.') {
        let (key, index) = if let Some(open) = segment.find('[') {
            let close = segment.strip_suffix(']')?;
            (
                &segment[..open],
                Some(close[open + 1..].parse::<usize>().ok()?),
            )
        } else {
            (segment, None)
        };
        current = current.get(key)?;
        if let Some(index) = index {
            current = current.get(index)?;
        }
    }
    Some(current.clone())
}

struct MappedOutput {
    value: Value,
    /// (target_field, source_path) pairs that failed to resolve and were
    /// substituted with `null` in the projected payload.
    missing: Vec<(String, String)>,
}

fn mapped_output(
    output: &RuntimeOutput,
    mapping: Option<&HashMap<String, String>>,
) -> MappedOutput {
    let full = json!({
        "status": output.status,
        "summary": output.summary,
        "data": output.data,
        "artifacts": output.artifacts,
        "threadId": output.thread_id,
    });
    let Some(mapping) = mapping.filter(|mapping| !mapping.is_empty()) else {
        return MappedOutput {
            value: full,
            missing: Vec::new(),
        };
    };
    let mut projected = serde_json::Map::new();
    let mut missing = Vec::new();
    for (field, path) in mapping {
        if field.trim().is_empty() {
            continue;
        }
        match resolve_json_path(&full, path) {
            Some(value) => {
                projected.insert(field.clone(), value);
            }
            None => {
                missing.push((field.clone(), path.clone()));
                projected.insert(field.clone(), Value::Null);
            }
        }
    }
    MappedOutput {
        value: Value::Object(projected),
        missing,
    }
}

fn compose_specialist_input(
    context: &RunContext,
    node: &RuntimeNode,
    revision_feedback: &str,
) -> Result<Value, String> {
    let input_node = context
        .graph
        .nodes
        .iter()
        .find(|candidate| candidate.data.kind == "input");
    let mission = input_node
        .and_then(|candidate| candidate.data.output.clone())
        .unwrap_or_default();
    let operator_test_feedback = input_node
        .map(|candidate| {
            candidate
                .data
                .user_test_feedback
                .iter()
                .rev()
                .take(8)
                .map(|feedback| feedback.chars().take(4_000).collect::<String>())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let outputs = safe_lock(context, &context.outputs, "outputs");
    let mut missing_events: Vec<(String, String, String, String, String, String)> = Vec::new();
    let upstream_outputs = context
        .graph
        .edges
        .iter()
        .filter(|edge| {
            edge.target == node.id
                && edge
                    .data
                    .as_ref()
                    .map(|data| data.edge_type.as_str())
                    .unwrap_or("standard")
                    != "revision"
        })
        .filter_map(|edge| {
            outputs.get(&edge.source).map(|output| {
                let mapped = mapped_output(
                    output,
                    edge.data.as_ref().and_then(|data| data.mapping.as_ref()),
                );
                for (field, path) in &mapped.missing {
                    missing_events.push((
                        node.id.clone(),
                        edge.id.clone(),
                        edge.source.clone(),
                        field.clone(),
                        path.clone(),
                        node.data.label.clone(),
                    ));
                }
                json!({
                    "sourceNodeId": edge.source,
                    "edgeId": edge.id,
                    "payload": mapped.value,
                })
            })
        })
        .collect::<Vec<_>>();
    drop(outputs);
    for (node_id, edge_id, source, field, path, label) in missing_events {
        emit_event(
            context,
            "node.input.mapping.missing",
            "warning",
            Some(&node_id),
            None,
            format!(
                "{label} mapped field '{field}' (path '{path}') resolved to null from {source}"
            ),
            json!({
                "sourceNodeId": source,
                "edgeId": edge_id,
                "field": field,
                "path": path,
            }),
        );
    }
    let revision_feedback = if revision_feedback.trim().is_empty() {
        Vec::new()
    } else {
        vec![json!({"message": revision_feedback.trim()})]
    };
    Ok(json!({
        "workflowInput": mission,
        "upstreamOutputs": upstream_outputs,
        "revisionFeedback": revision_feedback,
        "operatorTestFeedback": operator_test_feedback,
    }))
}

fn validate_json_schema(raw: &str, instance: &Value, label: &str) -> Result<(), String> {
    let schema: Value = serde_json::from_str(raw)
        .map_err(|error| format!("invalid {label} JSON Schema: {error}"))?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|error| format!("invalid {label} JSON Schema: {error}"))?;
    if let Err(error) = validator.validate(instance) {
        return Err(format!("{label} schema validation failed: {error}"));
    }
    Ok(())
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
    let composed_input = compose_specialist_input(context, node, extra_instruction)?;
    if let Some(input_schema) = node.data.input_schema.as_deref() {
        validate_json_schema(input_schema, &composed_input, "input")?;
    }
    let mission = composed_input
        .get("workflowInput")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let schema = node
        .data
        .output_schema
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    // Every specialist invocation owns a new ephemeral app-server process.
    // A thread created by a finished process is therefore not resumable.
    let resume_thread_id = specialist_thread_id_for_attempt(attempt, revision, None);
    // Composition split (plan I.1.2): base | developer+connector+criteria | user_input+extra
    let base_instructions = node.data.base_instructions.trim().to_string();
    let developer_core = if !node.data.developer_instructions.trim().is_empty() {
        node.data.developer_instructions.trim().to_string()
    } else {
        // Legacy graphs: single prompt blob routes to developer, not base.
        node.data.prompt.trim().to_string()
    };
    let mut developer_parts = vec![developer_core];
    let connector = connector_capability_instructions(node);
    if !connector.trim().is_empty() {
        developer_parts.push(connector.trim().to_string());
    }
    let criteria = criteria_instructions(&node.data.completion_criteria);
    if !criteria.trim().is_empty() {
        developer_parts.push(criteria.trim().to_string());
    }
    let developer_instructions = developer_parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let user_input = serde_json::to_string_pretty(&composed_input)
        .map_err(|error| format!("failed to compose authorized input: {error}"))?;
    let request = AgentRequest {
        node_id: node.id.clone(),
        run_id: Some(context.run_id.clone()),
        attempt_id: Some(attempt_id.clone()),
        thread_id: resume_thread_id,
        role: node.data.role.clone(),
        model: node.data.model.clone(),
        effort: node.data.effort.clone(),
        base_instructions,
        developer_instructions,
        user_input,
        upstream_outputs: Vec::new(),
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
        timeout_seconds: node.data.timeout_seconds.clamp(10, 1800),
        output_schema: schema,
        tools: node.data.tools.clone(),
        skills: node.data.skills.clone(),
        tool_boundary: "Tool selections are enforced through the host sandbox and approval policy where supported. CLI-internal tool granularity remains governed by Codex.".into(),
        app_server_path: None,
    };
    let started = SystemTime::now();
    let token_meter = Arc::new(AtomicU64::new(0));
    let result = execute_agent_internal(
        request,
        context.app.clone(),
        context.approval_broker.clone(),
        context.process_broker.clone(),
        context.turn_stdin_broker.clone(),
        context.database.clone(),
        token_meter.clone(),
    )
    .await;
    drop(permit);
    let elapsed_ms = started
        .elapsed()
        .map(|value| value.as_millis())
        .unwrap_or(0);
    match result {
        Ok(result) => {
            let mut output: RuntimeOutput = result.into();
            if let Some(output_schema) = node.data.output_schema.as_deref() {
                validate_json_schema(
                    output_schema,
                    &json!({
                        "status": output.status,
                        "summary": output.summary,
                        "data": output.data,
                        "artifacts": output.artifacts,
                    }),
                    "output",
                )?;
            }
            // Host materialize: assign hostOrdinal + artifactKey + contentHash
            let previous = context
                .outputs
                .lock()
                .get(&node.id)
                .map(|o| o.artifacts.clone());
            let (materialized, refs) =
                materialize_artifacts(&node.id, &output.artifacts, previous.as_deref());
            output.artifacts = materialized;
            // Verification SSOT block (platform criteria + host refs)
            let mut verification_results = Vec::new();
            let mut required_failed: Vec<String> = Vec::new();
            let mut residual_risks: Vec<String> = Vec::new();
            for criterion in &node.data.completion_criteria {
                if !criterion.enabled && !criterion.platform {
                    continue;
                }
                // Host I/O verifiers block (process poll / git). Run them on the
                // blocking pool so parallel specialists do not stall the async runtime.
                let kind = if criterion.kind == "custom" {
                    "claim"
                } else {
                    criterion.kind.as_str()
                };
                let eval = if matches!(kind, "command" | "architecture_policy") {
                    let criterion_c = criterion.clone();
                    let output_c = output.clone();
                    let context_c = context.clone();
                    match tauri::async_runtime::spawn_blocking(move || {
                        evaluate_criterion(&criterion_c, &output_c, &context_c)
                    })
                    .await
                    {
                        Ok(eval) => eval,
                        Err(e) => CriterionEval {
                            failed: true,
                            detail: format!("verifier join failed: {e}"),
                            method: kind.into(),
                            residual_risks: Vec::new(),
                        },
                    }
                } else {
                    evaluate_criterion(criterion, &output, context)
                };
                let enforcement = if node.data.hard_criteria_gate
                    || criterion.platform
                    || criterion.enforcement == "required"
                {
                    "required"
                } else {
                    "advisory"
                };
                if eval.failed && enforcement == "required" {
                    required_failed.push(criterion.id.clone());
                }
                for risk in eval.residual_risks {
                    if !residual_risks.contains(&risk) {
                        residual_risks.push(risk);
                    }
                }
                verification_results.push(json!({
                    "id": criterion.id,
                    "label": criterion.label,
                    "kind": criterion.kind,
                    "passed": !eval.failed,
                    "enforcement": enforcement,
                    "detail": eval.detail,
                    "method": eval.method,
                    "source": "runtime"
                }));
            }
            let fingerprint = attempt_fingerprint(
                &node.data.role,
                &mission,
                &format!("{extra_instruction}|{}", output.summary),
            );
            // Always materialize a data object so verification SSOT is written.
            if !output.data.is_object() {
                output.data = json!({ "payload": output.data });
            }
            if let Some(obj) = output.data.as_object_mut() {
                obj.insert(
                    "verification".into(),
                    json!({
                        "results": verification_results,
                        "requiredFailed": required_failed,
                        "fingerprint": fingerprint,
                        "artifactRefs": refs,
                        "residualRisks": residual_risks,
                        "passBitOwner": "runtime"
                    }),
                );
            }
            let attempt_tokens = output.tokens.max(token_meter.load(Ordering::SeqCst));
            output.tokens = record_node_tokens(context, &node.id, attempt_tokens);
            if output.status == "failure" {
                let error = if output.summary.trim().is_empty() {
                    "specialist returned failure without a summary".to_string()
                } else {
                    output.summary.clone()
                };
                let failure_class = classify_failure(&error).as_str();
                emit_event(
                    context,
                    "node.attempt.failed",
                    "error",
                    Some(&node.id),
                    Some(&attempt_id),
                    format!("{} reported failure: {error}", node.data.label),
                    json!({
                        "elapsedMs": elapsed_ms,
                        "status": "failure",
                        "threadId": output.thread_id,
                        "turnId": output.turn_id,
                        "attempt": attempt,
                        "revision": revision,
                        "attemptTokens": attempt_tokens,
                        "tokens": output.tokens,
                        "failureClass": failure_class,
                        // Slim meta only — full content stays on RuntimeOutput for the retry adapter.
                        "artifactMeta": slim_artifact_meta(&output.artifacts),
                    }),
                );
                {
                    let connection = database_guard(context);
                    let _ = connection.execute(
                        "INSERT OR REPLACE INTO node_attempts(id,run_id,node_id,attempt,revision,status,thread_id,turn_id,diagnostics_json,completed_at) VALUES(?1,?2,?3,?4,?5,'failed',?6,?7,?8,CURRENT_TIMESTAMP)",
                        params![format!("{}:{}:{}",context.run_id,node.id,attempt_id),context.run_id,node.id,attempt,revision,output.thread_id,output.turn_id,json!({"elapsedMs":elapsed_ms,"reportedFailure":true,"summary":error,"attemptTokens":attempt_tokens,"failureClass":failure_class}).to_string()],
                    );
                }
                // Return Ok with status=failure so the retry adapter can record artifact
                // hash-sets for plateau detection (Err(String) would drop them).
                return Ok(output);
            }
            emit_event(
                context,
                "node.attempt.completed",
                "info",
                Some(&node.id),
                Some(&attempt_id),
                format!("{} attempt completed", node.data.label),
                // Slim diagnostics for live chips (verification + summary + artifact meta).
                // Full artifact content remains in node_executions via persist, not the event bus.
                slim_attempt_completed_diagnostics(elapsed_ms, attempt_tokens, &output),
            );
            {
                let connection = database_guard(context);
                let _ = connection.execute(
                    "INSERT OR REPLACE INTO node_attempts(id,run_id,node_id,attempt,revision,status,thread_id,turn_id,diagnostics_json,completed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,CURRENT_TIMESTAMP)",
                    params![format!("{}:{}:{}",context.run_id,node.id,attempt_id),context.run_id,node.id,attempt,revision,output.status,output.thread_id,output.turn_id,json!({"elapsedMs":elapsed_ms,"attemptTokens":attempt_tokens}).to_string()],
                );
            }
            Ok(output)
        }
        Err(error) => {
            let attempt_tokens = token_meter.load(Ordering::SeqCst);
            let cumulative_tokens = record_node_tokens(context, &node.id, attempt_tokens);
            let failure_class = classify_failure(&error).as_str();
            emit_event(
                context,
                "node.attempt.failed",
                "error",
                Some(&node.id),
                Some(&attempt_id),
                format!("{} attempt failed: {error}", node.data.label),
                json!({"elapsedMs":elapsed_ms,"error":error,"attempt":attempt,"revision":revision,"attemptTokens":attempt_tokens,"tokens":cumulative_tokens,"failureClass":failure_class}),
            );
            {
                let connection = database_guard(context);
                let _ = connection.execute(
                    "INSERT OR REPLACE INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json,completed_at) VALUES(?1,?2,?3,?4,?5,'failed',?6,CURRENT_TIMESTAMP)",
                    params![format!("{}:{}:{}",context.run_id,node.id,attempt_id),context.run_id,node.id,attempt,revision,json!({"elapsedMs":elapsed_ms,"error":error,"attemptTokens":attempt_tokens,"failureClass":failure_class}).to_string()],
                );
            }
            Err(error)
        }
    }
}

fn specialist_thread_id_for_attempt(
    _attempt: u32,
    _revision: u32,
    _prior_thread_id: Option<&str>,
) -> Option<String> {
    None
}

/// Classification of specialist_once Err strings for retry policy (G7).
/// Verification failures return Ok and are never retried here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryErrorClass {
    Transient,
    Contract,
    /// Permission / sandbox denial → request authorization or reroute (P2).
    Capability,
    /// Acceptance-criteria ambiguity / incompleteness → pause for human (P2).
    Specification,
    Fatal,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryStopReason {
    Plateau,
    Fatal,
    ContractExhausted,
    MaxRetries,
    Interrupted,
    /// Capability/specification recovery armed a needs_human gate that was
    /// declined or timed out (run stops only after the human path failed).
    NeedsHuman,
}

impl RetryStopReason {
    fn as_str(&self) -> &'static str {
        match self {
            RetryStopReason::Plateau => "plateau",
            RetryStopReason::Fatal => "fatal",
            RetryStopReason::ContractExhausted => "contract_exhausted",
            RetryStopReason::MaxRetries => "max_retries",
            RetryStopReason::Interrupted => "interrupted",
            RetryStopReason::NeedsHuman => "needs_human",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RetryAction {
    Stop(RetryStopReason),
    RetryTransient {
        backoff_ms: u64,
    },
    RetryContractRepair {
        new_extra: String,
    },
    /// Strategy-aware recovery for capability/specification classes: arm a
    /// human gate instead of failing the run; `class` records the intact
    /// failure class on the gate.
    NeedsHuman {
        class: FailureClass,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryActionOutcome {
    Stop,
    Retry,
    RetryAfterHuman,
}

fn retry_limit_after_human_approval(attempt: u32, retry_limit: u32) -> u32 {
    if attempt >= retry_limit {
        retry_limit.saturating_add(1)
    } else {
        retry_limit
    }
}

/// Retry-policy projection of the full failure taxonomy (single source of truth for
/// `RetryErrorClass` behavior; `FailureClass` carries the richer recorded category).
fn classify_retry_error(error: &str) -> RetryErrorClass {
    match classify_failure(error) {
        FailureClass::Transient => RetryErrorClass::Transient,
        FailureClass::Contract => RetryErrorClass::Contract,
        FailureClass::Capability => RetryErrorClass::Capability,
        FailureClass::Specification => RetryErrorClass::Specification,
        // Verification / plateau / fatal all stop today; the richer class is
        // what gets recorded for strategy-aware recovery.
        FailureClass::Verification | FailureClass::Plateau | FailureClass::Fatal => {
            RetryErrorClass::Fatal
        }
    }
}

/// Content hashes from materialized artifacts (for plateau hash-set keys).
fn content_hashes_from_artifacts(artifacts: &[Value]) -> Vec<String> {
    artifacts
        .iter()
        .filter_map(|art| {
            art.get("contentHash")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|s| !s.is_empty())
        })
        .collect()
}

/// Hash-set key for this attempt: prefer this attempt's artifacts; else carry last known.
fn attempt_artifact_hash_set(
    attempt_artifacts: Option<&[Value]>,
    last_known_hash_set: &str,
) -> String {
    if let Some(arts) = attempt_artifacts {
        let hashes = content_hashes_from_artifacts(arts);
        if !hashes.is_empty() {
            return artifact_hash_set_key(&hashes);
        }
    }
    if !last_known_hash_set.is_empty() {
        return last_known_hash_set.to_string();
    }
    artifact_hash_set_key(&[])
}

/// Slim artifact rows for event bus (no file `content` bodies).
fn slim_artifact_meta(artifacts: &[Value]) -> Vec<Value> {
    artifacts
        .iter()
        .map(|art| {
            json!({
                "name": art.get("name").cloned().unwrap_or(Value::Null),
                "contentHash": art.get("contentHash").cloned().unwrap_or(Value::Null),
                "artifactKey": art.get("artifactKey").cloned().unwrap_or(Value::Null),
                "hostOrdinal": art.get("hostOrdinal").cloned().unwrap_or(Value::Null),
                "kind": art.get("kind").cloned().unwrap_or(Value::Null),
                "id": art.get("id").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// Live-canvas diagnostics: summary + verification SSOT + artifact meta (no full content).
fn slim_attempt_completed_diagnostics(
    elapsed_ms: u128,
    attempt_tokens: u64,
    output: &RuntimeOutput,
) -> Value {
    let verification = output.data.get("verification").cloned();
    // Keep residualRisks if present for operator honesty without shipping full data blob.
    let residual = output.data.get("residualRisks").cloned();
    let mut slim_data = serde_json::Map::new();
    if let Some(v) = verification {
        slim_data.insert("verification".into(), v);
    }
    if let Some(r) = residual {
        slim_data.insert("residualRisks".into(), r);
    }
    json!({
        "elapsedMs": elapsed_ms,
        "status": output.status,
        "threadId": output.thread_id,
        "turnId": output.turn_id,
        "attemptTokens": attempt_tokens,
        "tokens": output.tokens,
        "summary": output.summary,
        "data": Value::Object(slim_data),
        "artifacts": slim_artifact_meta(&output.artifacts),
    })
}

/// Slim deterministic control-node completion data for the live canvas.
/// Full delivery handoffs and artifact bodies remain in persisted node output.
fn slim_control_completed_diagnostics(output: &RuntimeOutput) -> Value {
    const SAFE_DATA_KEYS: &[&str] = &[
        "schemaVersion",
        "mode",
        "status",
        "review",
        "decision",
        "explicitHuman",
        "approvedArtifacts",
        "approvedAt",
        "requestId",
        "liveArtifactRefs",
        "verificationSummary",
        "verification",
        "residualRisks",
        "safety",
        "bundleHash",
        "branch",
        "matched",
        "sourceNodeId",
        "control",
    ];
    let mut slim_data = serde_json::Map::new();
    for key in SAFE_DATA_KEYS {
        if let Some(value) = output.data.get(*key) {
            slim_data.insert((*key).to_string(), value.clone());
        }
    }
    json!({
        "status": output.status,
        "summary": output.summary,
        "data": Value::Object(slim_data),
        "artifacts": slim_artifact_meta(&output.artifacts),
        "tokens": output.tokens,
    })
}

fn emits_control_completion(kind: Option<&str>) -> bool {
    matches!(kind, Some("approval" | "merge" | "condition" | "output"))
}

fn revision_routed_diagnostics(
    revision: u32,
    max_revisions: u32,
    reviewer_node_id: &str,
    feedback: &str,
) -> Value {
    json!({
        "revision": revision,
        "maxRevisions": max_revisions,
        "reviewerNodeId": reviewer_node_id,
        "feedback": feedback,
    })
}

/// Pure retry state machine (G7). Unit-tested independently of specialist_once.
///
/// Plateau is **not** applied for transient errors: environmental flakiness keeps the
/// same inputs by definition and must keep backoff up to max_retries.
///
/// For non-transient errors, plateau fires when ≥2 identical fingerprints are observed
/// with a stable artifact hash-set (including empty→empty when no artifacts were ever
/// produced). That path is reachable after a prior retryable attempt (e.g. transient
/// then fatal with same inputs, or two reported failures with the same artifact set).
fn next_retry_action(
    error: &str,
    attempt: u32,
    max_retries: u32,
    fingerprints: &[String],
    hash_sets: &[String],
    contract_repair_used: bool,
    current_extra: &str,
) -> RetryAction {
    // Strategy-aware recovery (P2): capability/specification failures cannot be
    // fixed by re-prompting. Arm a needs_human gate on the FIRST such failure
    // (before max-retries/plateau) — retrying won't grant a permission or
    // clarify acceptance criteria. The gate records the intact failure class;
    // the run only stops if the human path is declined or never resolves.
    match classify_failure(error) {
        FailureClass::Capability => {
            return RetryAction::NeedsHuman {
                class: FailureClass::Capability,
            }
        }
        FailureClass::Specification => {
            return RetryAction::NeedsHuman {
                class: FailureClass::Specification,
            }
        }
        _ => {}
    }
    if attempt >= max_retries {
        return RetryAction::Stop(RetryStopReason::MaxRetries);
    }
    let class = classify_retry_error(error);

    // Transient: backoff up to max_retries; never plateau (same inputs are expected).
    if class == RetryErrorClass::Transient {
        let backoff_ms = 200u64.saturating_mul(1u64 << attempt.min(4));
        return RetryAction::RetryTransient { backoff_ms };
    }

    // Non-transient: no-progress stop when inputs + artifact hash-set are stable.
    // Empty hash-sets are allowed here (unlike transient) so plateau is reachable
    // when agents fail twice without producing artifacts.
    if is_plateau(fingerprints, hash_sets) {
        return RetryAction::Stop(RetryStopReason::Plateau);
    }

    match class {
        RetryErrorClass::Transient => {
            // Already handled above; keep exhaustive.
            let backoff_ms = 200u64.saturating_mul(1u64 << attempt.min(4));
            RetryAction::RetryTransient { backoff_ms }
        }
        RetryErrorClass::Contract if !contract_repair_used => RetryAction::RetryContractRepair {
            new_extra: format!(
                "{current_extra}\n\nCONTRACT REPAIR: previous attempt failed schema/parse validation:\n{error}\nReturn valid structured JSON matching the required output schema. Do not omit required fields."
            ),
        },
        RetryErrorClass::Contract => RetryAction::Stop(RetryStopReason::ContractExhausted),
        RetryErrorClass::Fatal => RetryAction::Stop(RetryStopReason::Fatal),
        // Unreachable: capability/specification return NeedsHuman earlier, but
        // the classifier projection still needs exhaustive arms here.
        RetryErrorClass::Capability | RetryErrorClass::Specification => {
            RetryAction::Stop(RetryStopReason::NeedsHuman)
        }
    }
}

fn format_retry_stop_error(
    label: &str,
    max_retries: u32,
    attempts_used: u32,
    last_error: &str,
    reason: Option<RetryStopReason>,
) -> String {
    match reason {
        Some(RetryStopReason::Plateau) => format!(
            "{label} stopped after plateau (attempt {attempts_used}/{}): {last_error}",
            max_retries + 1
        ),
        Some(RetryStopReason::Fatal) => format!(
            "{label} stopped on non-retryable error (attempt {attempts_used}/{}): {last_error}",
            max_retries + 1
        ),
        Some(RetryStopReason::ContractExhausted) => format!(
            "{label} stopped after contract repair exhausted (attempt {attempts_used}/{}): {last_error}",
            max_retries + 1
        ),
        Some(RetryStopReason::NeedsHuman) => format!(
            "{label} armed a needs_human gate but no human unblocked it (attempt {attempts_used}/{}): {last_error}",
            max_retries + 1
        ),
        Some(RetryStopReason::Interrupted) => {
            format!("{label} interrupted during retries: {last_error}")
        }
        Some(RetryStopReason::MaxRetries) | None => format!(
            "{label} exhausted {max_retries} retries after {attempts_used} attempt(s): {last_error}"
        ),
    }
}

async fn specialist_with_retries(
    context: &RunContext,
    node: &RuntimeNode,
    revision: u32,
    extra_instruction: &str,
) -> Result<RuntimeOutput, String> {
    let started_at = Instant::now();
    let mut last_error = String::new();
    let mut fingerprints: Vec<String> = Vec::new();
    let mut hash_sets: Vec<String> = Vec::new();
    let mut contract_repair_used = false;
    let mut effective_extra = extra_instruction.to_string();
    // Inline self-improvement: if this node pattern has recurring failures in
    // prior runs, prepend a small guidance note to the specialist prompt.
    let experience_records = match load_node_experience(context, node) {
        Ok(records) => records,
        Err(error) => {
            emit_event(
                context,
                "node.experience.load_failed",
                "warning",
                Some(&node.id),
                None,
                format!("failed to load node experience: {error}"),
                json!({"error": error}),
            );
            Vec::new()
        }
    };
    if let Some(guidance) = experience_guidance(&experience_records) {
        effective_extra = format!("{guidance}{effective_extra}");
        emit_event(
            context,
            "node.experience.guidance",
            "info",
            Some(&node.id),
            None,
            "Pre-pending experience guidance to specialist prompt",
            json!({"guidance": guidance}),
        );
    }
    let mut stop_reason: Option<RetryStopReason> = None;
    let mut attempts_used: u32 = 0;
    let mut retry_limit = node.data.max_retries;
    // Seed from any prior node output (e.g. previous revision) so plateau can compare
    // against last known artifact identity when the next attempt fails.
    let mut last_known_hash_set = {
        let outputs = safe_lock(context, &context.outputs, "outputs");
        outputs
            .get(&node.id)
            .cloned()
            .map(|prior| attempt_artifact_hash_set(Some(&prior.artifacts), ""))
            .unwrap_or_default()
    };
    let mission = context
        .graph
        .nodes
        .iter()
        .find(|candidate| candidate.data.kind == "input")
        .and_then(|candidate| candidate.data.output.clone())
        .unwrap_or_default();

    let mut attempt = 0_u32;
    loop {
        if attempt > retry_limit {
            break;
        }
        if context.stop.load(Ordering::SeqCst) {
            stop_reason = Some(RetryStopReason::Interrupted);
            break;
        }

        let fingerprint = attempt_fingerprint(&node.data.role, &mission, &effective_extra);
        attempts_used = attempt.saturating_add(1);

        match specialist_once(context, node, attempt, revision, &effective_extra).await {
            // status=failure is returned as Ok so we can record artifact hash-sets for plateau.
            Ok(output) if output.status == "failure" => {
                let error = if output.summary.trim().is_empty() {
                    "specialist returned failure without a summary".to_string()
                } else {
                    output.summary.clone()
                };
                last_error = error.clone();
                let hash_key =
                    attempt_artifact_hash_set(Some(&output.artifacts), &last_known_hash_set);
                if !content_hashes_from_artifacts(&output.artifacts).is_empty() {
                    last_known_hash_set = hash_key.clone();
                }
                fingerprints.push(fingerprint);
                hash_sets.push(hash_key);

                if context.stop.load(Ordering::SeqCst) {
                    stop_reason = Some(RetryStopReason::Interrupted);
                    break;
                }
                let action = next_retry_action(
                    &error,
                    attempt,
                    retry_limit,
                    &fingerprints,
                    &hash_sets,
                    contract_repair_used,
                    &effective_extra,
                );
                match apply_retry_action(
                    context,
                    node,
                    action,
                    attempt,
                    &error,
                    &fingerprints,
                    &mut contract_repair_used,
                    &mut effective_extra,
                    &mut stop_reason,
                )
                .await
                {
                    RetryActionOutcome::Stop => break,
                    RetryActionOutcome::Retry => attempt = attempt.saturating_add(1),
                    RetryActionOutcome::RetryAfterHuman => {
                        retry_limit = retry_limit_after_human_approval(attempt, retry_limit);
                        attempt = attempt.saturating_add(1);
                    }
                }
            }
            // Ok includes verification-failed success outputs — revision owns that path.
            // Future specialist_with_retries calls seed last_known from context.outputs after persist.
            Ok(output) => {
                let latency_ms = started_at.elapsed().as_millis() as u64;
                let experience = NodeExperience {
                    node_id: node.id.clone(),
                    workflow_id: context.workflow_id.clone(),
                    role: node.data.role.clone(),
                    model: node.data.model.clone(),
                    effort: node.data.effort.clone(),
                    failure_class: None,
                    stop_reason: None,
                    outcome: "success".into(),
                    attempt_count: attempts_used,
                    total_tokens: output.tokens,
                    latency_ms,
                };
                if let Err(error) = record_node_experience(context, &experience) {
                    emit_event(
                        context,
                        "node.experience.record_failed",
                        "warning",
                        Some(&node.id),
                        None,
                        error,
                        json!({}),
                    );
                }
                return Ok(output);
            }
            Err(error) => {
                last_error = error.clone();
                // Pre-materialize failures: carry last known artifact set (if any).
                let hash_key = attempt_artifact_hash_set(None, &last_known_hash_set);
                fingerprints.push(fingerprint);
                hash_sets.push(hash_key);

                if context.stop.load(Ordering::SeqCst) {
                    stop_reason = Some(RetryStopReason::Interrupted);
                    break;
                }

                let action = next_retry_action(
                    &error,
                    attempt,
                    retry_limit,
                    &fingerprints,
                    &hash_sets,
                    contract_repair_used,
                    &effective_extra,
                );
                match apply_retry_action(
                    context,
                    node,
                    action,
                    attempt,
                    &error,
                    &fingerprints,
                    &mut contract_repair_used,
                    &mut effective_extra,
                    &mut stop_reason,
                )
                .await
                {
                    RetryActionOutcome::Stop => break,
                    RetryActionOutcome::Retry => attempt = attempt.saturating_add(1),
                    RetryActionOutcome::RetryAfterHuman => {
                        retry_limit = retry_limit_after_human_approval(attempt, retry_limit);
                        attempt = attempt.saturating_add(1);
                    }
                }
            }
        }
    }
    let latency_ms = started_at.elapsed().as_millis() as u64;
    let (outcome, failure_class) = match stop_reason {
        Some(RetryStopReason::Plateau) => ("plateau", "plateau"),
        Some(RetryStopReason::MaxRetries) => {
            ("max_retries", classify_failure(&last_error).as_str())
        }
        Some(RetryStopReason::ContractExhausted) => ("contract_exhausted", "contract"),
        Some(RetryStopReason::NeedsHuman) => {
            ("needs_human", classify_failure(&last_error).as_str())
        }
        Some(RetryStopReason::Interrupted) => {
            ("interrupted", classify_failure(&last_error).as_str())
        }
        Some(RetryStopReason::Fatal) | None => ("fatal", classify_failure(&last_error).as_str()),
    };
    let experience = NodeExperience {
        node_id: node.id.clone(),
        workflow_id: context.workflow_id.clone(),
        role: node.data.role.clone(),
        model: node.data.model.clone(),
        effort: node.data.effort.clone(),
        failure_class: Some(failure_class.to_string()),
        stop_reason: stop_reason.map(|r| r.as_str().into()),
        outcome: outcome.into(),
        attempt_count: attempts_used,
        total_tokens: node_token_total(context, &node.id),
        latency_ms,
    };
    if let Err(error) = record_node_experience(context, &experience) {
        emit_event(
            context,
            "node.experience.record_failed",
            "warning",
            Some(&node.id),
            None,
            error,
            json!({}),
        );
    }
    Err(format_retry_stop_error(
        &node.data.label,
        retry_limit,
        attempts_used,
        &last_error,
        stop_reason,
    ))
}

fn revision_gate_state(
    criteria: &[RuntimeCriterion],
    output: &RuntimeOutput,
    context: &RunContext,
    hard_criteria_gate: bool,
) -> (Option<RequiredCriteriaFailure>, Option<String>) {
    let required_failure = if output.status == "needs_revision" {
        None
    } else {
        required_criteria_failure(criteria, output, context, hard_criteria_gate)
    };
    let reason = if output.status == "needs_revision" {
        Some(output.summary.clone())
    } else {
        required_failure
            .as_ref()
            .map(|failure| failure.message.clone())
    };
    (required_failure, reason)
}

/// Apply a retry decision and report whether the caller should stop, retry, or
/// consume a human-approved recovery attempt beyond the configured limit.
#[allow(clippy::too_many_arguments)]
async fn apply_retry_action(
    context: &RunContext,
    node: &RuntimeNode,
    action: RetryAction,
    attempt: u32,
    error: &str,
    fingerprints: &[String],
    contract_repair_used: &mut bool,
    effective_extra: &mut String,
    stop_reason: &mut Option<RetryStopReason>,
) -> RetryActionOutcome {
    match action {
        RetryAction::Stop(reason) => {
            *stop_reason = Some(reason);
            let event_type = match reason {
                RetryStopReason::Plateau => "retry.plateau",
                RetryStopReason::MaxRetries => "retry.exhausted",
                _ => "retry.stopped",
            };
            // Plateau is a stop-level class; other stops keep their attempt class.
            let failure_class = if reason == RetryStopReason::Plateau {
                FailureClass::Plateau.as_str()
            } else {
                classify_failure(error).as_str()
            };
            emit_event(
                context,
                event_type,
                "warning",
                Some(&node.id),
                None,
                format!(
                    "{} retry stop ({reason:?}) after attempt {attempt}",
                    node.data.label
                ),
                json!({
                    "attempt": attempt,
                    "error": error,
                    "reason": format!("{reason:?}"),
                    "failureClass": failure_class,
                    "fingerprints": fingerprints,
                }),
            );
            RetryActionOutcome::Stop
        }
        RetryAction::RetryTransient { backoff_ms } => {
            emit_event(
                context,
                "retry.transient",
                "warning",
                Some(&node.id),
                None,
                format!(
                    "{} transient error; backoff {backoff_ms}ms then retry",
                    node.data.label
                ),
                json!({
                    "attempt": attempt,
                    "error": error,
                    "backoffMs": backoff_ms,
                    "failureClass": FailureClass::Transient.as_str(),
                }),
            );
            let _ = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(backoff_ms));
            })
            .await;
            RetryActionOutcome::Retry
        }
        RetryAction::RetryContractRepair { new_extra } => {
            *contract_repair_used = true;
            *effective_extra = new_extra;
            emit_event(
                context,
                "retry.contract_repair",
                "warning",
                Some(&node.id),
                None,
                format!(
                    "{} contract/schema failure; one repair retry",
                    node.data.label
                ),
                json!({
                    "attempt": attempt,
                    "error": error,
                    "failureClass": FailureClass::Contract.as_str(),
                }),
            );
            RetryActionOutcome::Retry
        }
        RetryAction::NeedsHuman { class } => {
            let failure_class = class.as_str();
            // Record the intact attempt class (capability | specification) on a
            // node.attempt.failed-style event so analytics never lose the class
            // to a plateau/fatal overwrite.
            emit_event(
                context,
                "node.attempt.failed",
                "warning",
                Some(&node.id),
                None,
                format!(
                    "{} needs human decision after {} failure: {error}",
                    node.data.label, failure_class
                ),
                json!({
                    "attempt": attempt,
                    "error": error,
                    "gate": "needs_human",
                    "failureClass": failure_class,
                    "strategy": "request authorization or route to a capable node / pause for human clarification",
                }),
            );
            emit_event(
                context,
                "retry.needs_human",
                "warning",
                Some(&node.id),
                None,
                format!(
                    "{} armed needs_human gate ({failure_class})",
                    node.data.label
                ),
                json!({
                    "attempt": attempt,
                    "error": error,
                    "failureClass": failure_class,
                }),
            );
            let detail = match class {
                FailureClass::Capability => format!(
                    "{} hit a capability boundary (permission / unavailable tool). Retrying the same prompt will not grant access — grant authorization, route to a capable node, or approve to proceed anyway.",
                    node.data.label
                ),
                FailureClass::Specification => format!(
                    "{} hit a specification open question (ambiguous/incomplete acceptance criteria). Pausing for human clarification — clarify the criteria or approve to proceed anyway.",
                    node.data.label
                ),
                _ => format!(
                    "{} requires a human decision before continuing: {error}",
                    node.data.label
                ),
            };
            match await_operator_approval(context, node, "needs_human", &detail).await {
                // Human unblocked the node → let the retry loop take another
                // attempt with the same inputs (the data plane may have changed:
                // permission granted, criteria clarified).
                Ok(_) => RetryActionOutcome::RetryAfterHuman,
                // Gate declined or timed out → stop with the intact class, but
                // as a needs_human stop (never a silent fatal).
                Err(_) => {
                    *stop_reason = Some(RetryStopReason::NeedsHuman);
                    RetryActionOutcome::Stop
                }
            }
        }
    }
}

async fn execute_specialist_with_revision(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<RuntimeOutput, NodeExecutionFailure> {
    let mut output = specialist_with_retries(context, node, 0, "")
        .await
        .map_err(|error| NodeExecutionFailure::owned(&node.id, error))?;
    emit_advisory_failures(context, node, &output);
    let revision_edge = context.graph.edges.iter().find(|edge| {
        edge.source == node.id
            && edge
                .data
                .as_ref()
                .is_some_and(|data| data.edge_type == "revision")
    });
    let (mut required_failure, mut reason) = revision_gate_state(
        &node.data.completion_criteria,
        &output,
        context,
        node.data.hard_criteria_gate,
    );
    let Some(edge) = revision_edge else {
        if let Some(reason) = reason {
            return Err(NodeExecutionFailure::owned(
                &node.id,
                format!("{reason}; no revision edge is configured"),
            ));
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
        .ok_or_else(|| NodeExecutionFailure::owned(&node.id, "revision target missing"))?;
    for revision in 1..=max {
        let Some(feedback) = reason.take() else {
            return Ok(output);
        };
        // P3: each routing of a REQUIRED VERIFICATION failure persists an
        // attempt record (failureClass:"verification" + failing criterion ids)
        // so "verification → revision" loops are queryable, not re-parsed.
        if let Some(required) = required_failure.take() {
            record_verification_revision(
                context,
                &node.id,
                &target.id,
                revision,
                &required.criterion_ids,
                &required.message,
            );
        }
        emit_event(
            context,
            "revision.routed",
            "warning",
            Some(&target.id),
            None,
            format!("Revision {revision}/{max} routed to {}", target.data.label),
            revision_routed_diagnostics(revision, max, &node.id, &feedback),
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
        .await
        .map_err(|error| NodeExecutionFailure::owned(&target.id, error))?;
        // A revision is a new durable result for the target node, not merely
        // transient reviewer context. Persist it before exposing it in memory.
        persist_node_output(context, &target.id, &revised)
            .map_err(|error| NodeExecutionFailure::owned(&target.id, error))?;
        {
            let mut outputs = safe_lock(context, &context.outputs, "outputs");
            outputs.insert(target.id.clone(), revised);
        }
        output = specialist_with_retries(
            context,
            node,
            revision,
            "\n\nRe-review the revised upstream work and return success only if all required criteria pass.",
        )
        .await
        .map_err(|error| NodeExecutionFailure::owned(&node.id, error))?;
        emit_advisory_failures(context, node, &output);
        (required_failure, reason) = revision_gate_state(
            &node.data.completion_criteria,
            &output,
            context,
            node.data.hard_criteria_gate,
        );
        if reason.is_none() {
            // A re-review is authoritative for the current revision. Do not
            // fall through to the exhaustion error after the final allowed
            // revision has actually passed every required host gate.
            return Ok(output);
        }
    }
    Err(NodeExecutionFailure::owned(
        &node.id,
        format!(
            "{} exhausted the revision limit ({max}): {}",
            node.data.label,
            reason.unwrap_or_else(|| "required criteria remain unsatisfied".into())
        ),
    ))
}

async fn await_operator_approval(
    context: &RunContext,
    node: &RuntimeNode,
    gate: &str,
    detail: &str,
) -> Result<String, String> {
    let request_id = format!("{}::{}::{gate}", context.run_id, node.id);
    let (sender, receiver) = mpsc::channel();
    poison_aware_lock(
        &context.run_approvals.0,
        "run approval broker",
        Some(&context.run_id),
    )
    .insert(request_id.clone(), sender);
    if let Some(app) = &context.app {
        let _ = app.emit(
            "workflow-run-approval",
            RunApprovalEvent {
                run_id: context.run_id.clone(),
                request_id: request_id.clone(),
                node_id: node.id.clone(),
                title: node.data.label.clone(),
                detail: detail.into(),
            },
        );
    } else {
        // Headless / MCP: no UI event bus — surface requestId for operators and tools.
        eprintln!(
            "[codex-corp] run approval pending requestId={} runId={} nodeId={} (list_pending_run_approvals / respond_run_approval)",
            request_id, context.run_id, node.id
        );
    }
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
        &context.database,
        &context.run_id,
        "waiting_approval",
        None,
        true,
    );
    {
        let connection = database_guard(context);
        let _ = connection.execute(
            "INSERT OR REPLACE INTO approvals(id,run_id,node_id,request_json,decision) VALUES(?1,?2,?3,?4,NULL)",
            params![request_id,context.run_id,node.id,json!({"title":node.data.label,"detail":detail,"gate":gate}).to_string()],
        );
    }
    let stop = context.stop.clone();
    let approval_timeout = operator_approval_timeout(gate, context.app.is_none());
    let wait_result = tauri::async_runtime::spawn_blocking(move || {
        wait_for_approval(
            &receiver,
            &stop,
            approval_timeout,
            Duration::from_millis(250),
        )
    })
    .await
    .map_err(|error| error.to_string());
    // Always remove the broker entry, including timeout, cancellation, and
    // sender-disconnect paths. Stale approvals must never be actionable.
    {
        let mut pending = poison_aware_lock(
            &*context.run_approvals.0,
            "run approval broker",
            Some(&context.run_id),
        );
        pending.remove(&request_id);
    }
    update_run_status(&context.database, &context.run_id, "running", None, true);
    let decision_result = match wait_result {
        Ok(result) => result,
        Err(error) => {
            let error = error.to_string();
            {
                let connection = database_guard(context);
                let _ = connection.execute(
                    "UPDATE approvals SET decision=?2 WHERE id=?1",
                    params![request_id, error],
                );
            }
            emit_event(
                context,
                "approval.expired",
                "error",
                Some(&node.id),
                None,
                format!("{} approval wait failed: {error}", node.data.label),
                json!({"requestId":request_id,"error":error}),
            );
            return Err(error);
        }
    };
    let decision = match decision_result {
        Ok(decision) => decision,
        Err(error) => {
            {
                let connection = database_guard(context);
                let _ = connection.execute(
                    "UPDATE approvals SET decision=?2 WHERE id=?1",
                    params![request_id, error],
                );
            }
            emit_event(
                context,
                "approval.expired",
                "error",
                Some(&node.id),
                None,
                format!("{} approval wait ended: {error}", node.data.label),
                json!({"requestId":request_id,"error":error}),
            );
            return Err(error);
        }
    };
    if !decision {
        {
            let connection = database_guard(context);
            let _ = connection.execute(
                "UPDATE approvals SET decision='declined' WHERE id=?1",
                params![request_id],
            );
        }
        emit_event(
            context,
            "approval.declined",
            "warning",
            Some(&node.id),
            None,
            format!("{} was declined", node.data.label),
            json!({"requestId":request_id,"decision":"declined"}),
        );
        return Err("operator declined the approval gate".into());
    }
    {
        let connection = database_guard(context);
        let _ = connection.execute(
            "UPDATE approvals SET decision='approved' WHERE id=?1",
            params![request_id],
        );
    }
    emit_event(
        context,
        "approval.approved",
        "info",
        Some(&node.id),
        None,
        format!("{} was approved", node.data.label),
        json!({"requestId":request_id,"decision":"approved"}),
    );
    Ok(request_id)
}

async fn approval_node(context: &RunContext, node: &RuntimeNode) -> Result<RuntimeOutput, String> {
    let request_id = await_operator_approval(
        context,
        node,
        "approval",
        "Review the completed required work before authorizing the verified release bundle.",
    )
    .await?;
    // Freeze approved artifact (key,hash) pairs onto approval output only.
    // Cannot re-derive from artifacts table after revision DELETE+reinsert.
    let outputs_snapshot = poison_aware_lock(&context.outputs, "outputs", Some(&context.run_id));
    let mut kind_artifacts: HashMap<String, (String, Vec<Value>)> = HashMap::new();
    for node_ref in &context.graph.nodes {
        if let Some(out) = outputs_snapshot.get(&node_ref.id) {
            kind_artifacts.insert(
                node_ref.id.clone(),
                (node_ref.data.kind.clone(), out.artifacts.clone()),
            );
        }
    }
    let refs = collect_upstream_artifacts(&kind_artifacts);
    let approved_at = chrono_like_now_iso();
    let freeze = freeze_approval_snapshot(&request_id, &approved_at, &refs);
    Ok(RuntimeOutput {
        status: "success".into(),
        summary: "Human release approval recorded.".into(),
        data: freeze,
        artifacts: Vec::new(),
        thread_id: None,
        turn_id: None,
        tokens: 0,
    })
}

/// Headless `needs_human` gate deadline (P1). In headless / CI there is no
/// operator watching the broker, so a capability/specification gate must fail
/// closed within a short configurable window instead of stalling a batch run
/// for the interactive 30-minute default.
const DEFAULT_NEEDS_HUMAN_TIMEOUT_SECS: u64 = 30;
const DEFAULT_APPROVAL_TIMEOUT_SECS: u64 = 30 * 60;

/// Gate-scoped operator approval delay. `needs_human` uses the short headless
/// window (`CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS`, default 30s); interactive
/// approval gates keep the long operator window.
fn operator_approval_timeout(gate: &str, headless: bool) -> Duration {
    if gate == "needs_human" && headless {
        Duration::from_secs(parse_needs_human_timeout(
            std::env::var("CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS")
                .ok()
                .as_deref(),
        ))
    } else {
        Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS)
    }
}

/// Parse `CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS` (seconds). Unset/invalid → the
/// conservative 30s default; values clamp to [1, 3600] so a batch run can
/// never hang for an hour but always grants the gate at least 1s to resolve.
fn parse_needs_human_timeout(raw: Option<&str>) -> u64 {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return DEFAULT_NEEDS_HUMAN_TIMEOUT_SECS;
    };
    match raw.parse::<u64>() {
        Ok(secs) => secs.clamp(1, 3600),
        Err(_) => DEFAULT_NEEDS_HUMAN_TIMEOUT_SECS,
    }
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

fn chrono_like_now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix={secs}")
}

/// Conditional residual risks (plan III.12 / invariant #9) — only emit when applicable.
fn collect_residual_risks(
    graph: &RuntimeGraph,
    outputs: &HashMap<String, RuntimeOutput>,
    approved: &[ApprovedArtifact],
) -> Vec<String> {
    let mut risks = Vec::new();
    let mut used_authored_base = false;
    let mut had_claim_criterion = false;
    for node in &graph.nodes {
        if node.data.kind != "agent" && node.data.kind != "creative" {
            continue;
        }
        if !node.data.base_instructions.trim().is_empty() {
            used_authored_base = true;
        }
        if node
            .data
            .completion_criteria
            .iter()
            .any(|c| c.kind == "claim" || c.kind == "custom")
        {
            had_claim_criterion = true;
        }
    }
    if used_authored_base {
        risks.push("authored_base_not_native_codex_base".into());
    }
    if had_claim_criterion {
        risks.push("claim_criteria_are_advisory_only".into());
    }
    if approved.is_empty() {
        risks.push("empty_approval_artifact_set".into());
    }
    // Surface architecture residual risks from verification payloads when present.
    for output in outputs.values() {
        if let Some(arr) = output
            .data
            .pointer("/verification/residualRisks")
            .and_then(Value::as_array)
        {
            for item in arr {
                if let Some(s) = item.as_str() {
                    if !risks.iter().any(|r| r == s) {
                        risks.push(s.to_string());
                    }
                }
            }
        }
    }
    risks
}

async fn execute_node(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<RuntimeOutput, NodeExecutionFailure> {
    if context.stop.load(Ordering::SeqCst) {
        return Err(NodeExecutionFailure::owned(&node.id, "run interrupted"));
    }
    match node.data.kind.as_str() {
        "agent" | "creative" => {
            let output = execute_specialist_with_revision(context, node).await?;
            if node.data.requires_approval {
                await_operator_approval(
                    context,
                    node,
                    "post-node-approval",
                    "Review this specialist's verified output before downstream work is released.",
                )
                .await
                .map_err(|error| NodeExecutionFailure::owned(&node.id, error))?;
            }
            Ok(output)
        }
        "approval" => approval_node(context, node)
            .await
            .map_err(|error| NodeExecutionFailure::owned(&node.id, error)),
        "merge" => Ok(RuntimeOutput {
            status: "success".into(),
            summary: "Dependencies joined.".into(),
            data: json!({"control":"merge"}),
            artifacts: Vec::new(),
            thread_id: None,
            turn_id: None,
            tokens: 0,
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
            let outputs = safe_lock(context, &context.outputs, "outputs");
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
                tokens: 0,
            })
        }
        "output" => {
            let outputs = safe_lock(context, &context.outputs, "outputs");
            let approval_output = outputs.values().find(|output| {
                output.data.get("decision").and_then(Value::as_str) == Some("approved")
            });
            let approval_output = match approval_output {
                Some(output) => output,
                None => return Err("delivery requires an explicit approved gate".into()),
            };
            // Fail closed if any completed specialist lacks host verification SSOT.
            require_specialist_verification_blocks(&context.graph, &outputs)?;
            // Frozen snapshot only — never rebuild from artifacts table.
            let approved_artifacts: Vec<ApprovedArtifact> = approval_output
                .data
                .get("approvedArtifacts")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            let mut kind_artifacts: HashMap<String, (String, Vec<Value>)> = HashMap::new();
            for node_ref in &context.graph.nodes {
                if let Some(out) = outputs.get(&node_ref.id) {
                    kind_artifacts.insert(
                        node_ref.id.clone(),
                        (node_ref.data.kind.clone(), out.artifacts.clone()),
                    );
                }
            }
            let live_refs = collect_upstream_artifacts(&kind_artifacts);
            match delivery_pair_compare(&approved_artifacts, &live_refs) {
                DeliveryCompareResult::Pass => {}
                DeliveryCompareResult::Fail(reason) => {
                    return Err(format!("delivery pair-compare failed: {reason}").into());
                }
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
            let verification_summary = collect_verification_summary(&outputs);
            let residual_risks =
                collect_residual_risks(&context.graph, &outputs, &approved_artifacts);
            let mut bundle = json!({
                "schemaVersion":"codex-corp.delivery.v3",
                "mode":"live",
                "status":"success",
                "review":{"outcome":review},
                "specialistHandoffs":handoffs,
                "approvedArtifacts": approved_artifacts,
                "liveArtifactRefs": live_refs,
                "verificationSummary": verification_summary,
                "residualRisks": residual_risks,
                "safety":{"approval":"explicit-human","chainOfThought":"not-exposed","passBitOwner":"runtime"}
            });
            // Canonical self-hash of the bundle without the self-hash field.
            let canonical = serde_json::to_string(&bundle).unwrap_or_default();
            if let Some(obj) = bundle.as_object_mut() {
                obj.insert(
                    "bundleHash".into(),
                    json!(crate::verifier::types::content_hash_for(&canonical)),
                );
            }
            Ok(RuntimeOutput {
                status: "success".into(),
                summary: "Approved delivery bundle assembled with pair-verified artifacts.".into(),
                data: bundle.clone(),
                artifacts: vec![
                    json!({"id":"delivery-bundle","name":"delivery-bundle.json","kind":"json","content":serde_json::to_string_pretty(&bundle).unwrap_or_default()}),
                ],
                thread_id: None,
                turn_id: None,
                tokens: 0,
            })
        }
        _ => Err(format!("unsupported runtime node kind: {}", node.data.kind).into()),
    }
}

fn persist_node_output(
    context: &RunContext,
    node_id: &str,
    output: &RuntimeOutput,
) -> Result<(), String> {
    let mut connection = database_guard(context);
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
        let content = artifact
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        let content_hash = resolve_artifact_content_hash(
            artifact.get("contentHash").and_then(Value::as_str),
            content,
        );
        let byte_length = content.len() as i64;
        // v1: artifacts remain inline in metadata_json; storage_path reserved for on-disk.
        let storage_path: Option<String> = None;
        transaction
            .execute(
                "INSERT INTO artifacts(id,run_id,node_id,metadata_json,content_hash,byte_length,storage_path) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    format!("{run_id}:{node_id}:{index}:{raw_id}"),
                    run_id,
                    node_id,
                    artifact.to_string(),
                    content_hash,
                    byte_length,
                    storage_path
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

fn initial_execution_sets(
    graph: &RuntimeGraph,
    start: Option<&str>,
) -> (HashSet<String>, HashSet<String>, HashSet<String>) {
    let included = downstream_from(graph, start);
    let mut prerequisites = HashSet::new();
    if let Some(start) = start {
        let mut frontier = vec![start.to_string()];
        while let Some(target) = frontier.pop() {
            for edge in graph.edges.iter().filter(|edge| {
                edge.target == target
                    && edge.data.as_ref().map(|data| data.edge_type.as_str()) != Some("revision")
            }) {
                if prerequisites.insert(edge.source.clone()) {
                    frontier.push(edge.source.clone());
                }
            }
        }
        prerequisites.remove(start);
    }
    let completed: HashSet<String> = graph
        .nodes
        .iter()
        .filter(|node| {
            prerequisites.contains(&node.id)
                || (included.contains(&node.id)
                    && (node.data.kind == "input" || node.data.kind == "cron"))
        })
        .map(|node| node.id.clone())
        .collect();
    let skipped = graph
        .nodes
        .iter()
        .filter(|node| !included.contains(&node.id) && !prerequisites.contains(&node.id))
        .map(|node| node.id.clone())
        .collect();
    (included, completed, skipped)
}

async fn run_worker(
    context: RunContext,
    start_node_id: Option<String>,
    resume_checkpoint: Option<RunCheckpoint>,
    runtime: WorkflowRuntime,
) {
    update_run_status(&context.database, &context.run_id, "running", None, false);
    emit_event(
        &context,
        "run.started",
        "info",
        None,
        None,
        "Native workflow runtime started",
        json!({"runtimeVersion":RUNTIME_VERSION}),
    );
    let (included, mut completed, mut skipped) =
        initial_execution_sets(&context.graph, start_node_id.as_deref());
    if let Some(checkpoint) = resume_checkpoint {
        completed.extend(checkpoint.completed);
        skipped.extend(checkpoint.skipped);
        {
            let mut outputs = safe_lock(&context, &context.outputs, "outputs");
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
        let mut outputs = safe_lock(&context, &context.outputs, "outputs");
        outputs.insert(
            input.id.clone(),
            RuntimeOutput {
                status: "success".into(),
                summary: input.data.output.clone().unwrap_or_default(),
                data: json!({"authorizedMission":true}),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
                tokens: 0,
            },
        );
    }
    if let Err(error) = checkpoint(&context, &completed, &skipped) {
        emit_event(
            &context,
            "run.checkpoint.failed",
            "warning",
            None,
            None,
            format!("initial checkpoint failed: {error}; run will not be resumable"),
            json!({"error": error}),
        );
    }
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
                    let node_kind = context
                        .graph
                        .nodes
                        .iter()
                        .find(|candidate| candidate.id == node_id)
                        .map(|candidate| candidate.data.kind.as_str());
                    let control_completion = emits_control_completion(node_kind)
                        .then(|| slim_control_completed_diagnostics(&output));
                    {
                        let mut outputs = safe_lock(&context, &context.outputs, "outputs");
                        outputs.insert(node_id.clone(), output);
                        completed.insert(node_id.clone());
                        if let Some(ref branch) = branch {
                            for edge in context.graph.edges.iter().filter(|edge| {
                                edge.source == node_id
                                    && edge.data.as_ref().is_some_and(|data| {
                                        data.edge_type == "conditional"
                                            && data.condition.as_deref() != Some(branch.as_str())
                                    })
                            }) {
                                skipped.insert(edge.target.clone());
                            }
                        }
                    }
                    if let Some(diagnostics) = control_completion {
                        let label = context
                            .graph
                            .nodes
                            .iter()
                            .find(|candidate| candidate.id == node_id)
                            .map(|candidate| candidate.data.label.as_str())
                            .unwrap_or(node_id.as_str());
                        emit_event(
                            &context,
                            "node.completed",
                            "info",
                            Some(&node_id),
                            None,
                            format!("{label} completed"),
                            diagnostics,
                        );
                    }
                    if let Some(ref branch) = branch {
                        for edge in context.graph.edges.iter().filter(|edge| {
                            edge.source == node_id
                                && edge.data.as_ref().is_some_and(|data| {
                                    data.edge_type == "conditional"
                                        && data.condition.as_deref() != Some(branch.as_str())
                                })
                        }) {
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
                    batch_failure = Some((error.owner_or(&node_id).to_string(), error.message));
                    break;
                }
                Err(error) => {
                    batch_failure = Some(("runtime-worker".into(), error.to_string()));
                    break;
                }
            }
        }
        if let Some((node_id, error)) = batch_failure {
            emit_event(
                &context,
                "node.terminal.failed",
                "error",
                Some(&node_id),
                None,
                format!("{node_id} terminally failed: {error}"),
                json!({"status":"failed","error":error,"failureClass":classify_failure(&error).as_str()}),
            );
            terminal_error = Some(format!("node {node_id} terminally failed: {error}"));
            context.stop.store(true, Ordering::SeqCst);
            kill_run_processes(
                &context.process_broker,
                &context.turn_stdin_broker,
                &context.run_id,
            );
            // Drain sibling workers so no node can publish success after the
            // terminal run event. Their processes have already been stopped.
            while handles.next().await.is_some() {
                // Drain all sibling workers after their processes are killed.
            }
            break;
        }
        if let Err(error) = checkpoint(&context, &completed, &skipped) {
            emit_event(
                &context,
                "run.checkpoint.failed",
                "warning",
                None,
                None,
                format!("batch checkpoint failed: {error}; resumability may be stale"),
                json!({"error": error}),
            );
        }
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
        &context.database,
        &context.run_id,
        status,
        reason.as_deref(),
        resumable,
    );
    if status != "completed" {
        {
            let connection = database_guard(&context);
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
    let mut active = poison_aware_lock(&runtime.active, "runtime active", Some(&context.run_id));
    active.remove(&context.run_id);
    let mut connection = database_guard(&context);
    if let Ok(settings) = app_settings::load(&connection) {
        let _ = app_settings::cleanup(&mut connection, &settings);
    }
}

fn checkpoint(
    context: &RunContext,
    completed: &HashSet<String>,
    skipped: &HashSet<String>,
) -> Result<(), String> {
    let outputs = {
        let guard = safe_lock(context, &context.outputs, "outputs");
        guard.clone()
    };
    let value = serde_json::to_string(&RunCheckpoint {
        completed: completed.clone(),
        skipped: skipped.clone(),
        outputs,
    })
    .map_err(|error| format!("checkpoint serialization failed: {error}"))?;
    let connection = database_guard(context);
    connection
        .execute(
            "INSERT INTO run_checkpoints(run_id,checkpoint_json,resumable,updated_at) VALUES(?1,?2,1,CURRENT_TIMESTAMP)
             ON CONFLICT(run_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,resumable=1,updated_at=CURRENT_TIMESTAMP",
            params![context.run_id,value],
        )
        .map_err(|error| format!("checkpoint persistence failed: {error}"))?;
    Ok(())
}

fn update_run_status(
    database: &Database,
    run_id: &str,
    status: &str,
    reason: Option<&str>,
    resumable: bool,
) {
    let connection = database_guard_for(database);
    let _ = connection.execute(
        "UPDATE runs SET status=?2,terminal_reason=?3,resumable=?4 WHERE id=?1",
        params![run_id, status, reason, resumable as i32],
    );
}

fn kill_run_processes(
    process_broker: &ProcessBroker,
    turn_stdin_broker: &TurnStdinBroker,
    run_id: &str,
) {
    let prefix = format!("{run_id}::");
    // Phase 2.6: Send turn/interrupt via stdin for graceful shutdown before kill.
    let active_turns: Vec<_> = {
        let turns = poison_aware_lock(&*turn_stdin_broker.0, "turn stdin broker", None);
        turns
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, handle)| handle.clone())
            .collect()
    };
    for handle in active_turns {
        let request_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let _ = crate::send_json_timed(
            &handle.stdin,
            crate::turn_interrupt_request(request_id, &handle),
            std::time::Duration::from_millis(500),
        );
    }
    // Brief grace period for the app-server to process the interrupt.
    std::thread::sleep(std::time::Duration::from_secs(2));
    let children: Vec<_> = {
        let processes = poison_aware_lock(&*process_broker.0, "process broker", None);
        processes
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, child)| child.clone())
            .collect()
    };
    for child in children {
        crate::kill_app_server_child(&child);
    }
    // Clean up stdin handles.
    {
        let mut turns = poison_aware_lock(&*turn_stdin_broker.0, "turn stdin broker", None);
        turns.retain(|key, _| !key.starts_with(&prefix));
    }
}

/// True when any enabled criterion would perform host filesystem / process I/O.
fn graph_has_enabled_host_io_criteria(graph: &RuntimeGraph) -> bool {
    graph.nodes.iter().any(|node| {
        node.data.completion_criteria.iter().any(|criterion| {
            criterion.enabled && crate::verifier::kind_requires_workspace(criterion.kind.as_str())
        })
    })
}

/// Shared start path for desktop (Some(app)) and headless/MCP (None).
#[allow(clippy::too_many_arguments)]
async fn start_run_core(
    workflow_id: String,
    start_node_id: Option<String>,
    workspace_path: Option<String>,
    app: Option<tauri::AppHandle>,
    database: Database,
    runtime: WorkflowRuntime,
    run_approvals: RunApprovalBroker,
    approval_broker: ApprovalBroker,
    process_broker: ProcessBroker,
    turn_stdin_broker: TurnStdinBroker,
) -> Result<NativeRunRecord, String> {
    let graph_json: String = {
        let connection = database_guard_for(&database);
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
        if crate::is_app_managed_workspace(path) {
            crate::prepare_greenfield_workspace(path, true)?;
        }
    }
    if target_workspace.is_none() && graph_has_enabled_host_io_criteria(&graph) {
        return Err(
            "workspacePath is required when the workflow has enabled command or architecture_policy criteria"
                .into(),
        );
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
        let connection = database_guard_for(&database);
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
        workflow_id: workflow_id.clone(),
        app,
        database: database.clone(),
        graph,
        outputs: Arc::new(Mutex::new(HashMap::new())),
        node_tokens: Arc::new(Mutex::new(HashMap::new())),
        stop: stop.clone(),
        sequence: Arc::new(AtomicU64::new(0)),
        limiter: runtime.limiter.clone(),
        approval_broker,
        process_broker,
        turn_stdin_broker,
        run_approvals,
        target_workspace,
    };
    {
        let mut active = poison_aware_lock(&runtime.active, "runtime active", Some(&run_id));
        active.insert(
            run_id.clone(),
            ActiveRun {
                workflow_id: workflow_id.clone(),
                status: "running".into(),
                stop,
            },
        );
    }
    let runtime_owned = runtime.clone();
    tauri::async_runtime::spawn(async move {
        run_worker(context, start_node_id, None, runtime_owned).await;
    });
    get_run_record(&database, &run_id)
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
    turn_stdin_broker: tauri::State<'_, TurnStdinBroker>,
    database: tauri::State<'_, Database>,
) -> Result<NativeRunRecord, String> {
    start_run_core(
        workflow_id,
        start_node_id,
        workspace_path,
        Some(app),
        database.inner().clone(),
        runtime.inner().clone(),
        run_approvals.inner().clone(),
        approval_broker.inner().clone(),
        process_broker.inner().clone(),
        turn_stdin_broker.inner().clone(),
    )
    .await
}

/// Headless / MCP entry: same workflow runtime without a desktop AppHandle.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_run_headless(
    workflow_id: String,
    start_node_id: Option<String>,
    workspace_path: Option<String>,
    database: Database,
    runtime: WorkflowRuntime,
    run_approvals: RunApprovalBroker,
    approval_broker: ApprovalBroker,
    process_broker: ProcessBroker,
    turn_stdin_broker: TurnStdinBroker,
) -> Result<NativeRunRecord, String> {
    start_run_core(
        workflow_id,
        start_node_id,
        workspace_path,
        None,
        database,
        runtime,
        run_approvals,
        approval_broker,
        process_broker,
        turn_stdin_broker,
    )
    .await
}

fn get_run_record(database: &Database, run_id: &str) -> Result<NativeRunRecord, String> {
    let connection = database_guard_for(database);
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
pub(crate) fn stop_run(
    run_id: String,
    runtime: tauri::State<'_, WorkflowRuntime>,
    process_broker: tauri::State<'_, ProcessBroker>,
    turn_stdin_broker: tauri::State<'_, TurnStdinBroker>,
) -> Result<(), String> {
    let active = {
        let active = poison_aware_lock(&runtime.active, "runtime active", None);
        active.get(&run_id).cloned().ok_or("run is not active")?
    };
    active.stop.store(true, Ordering::SeqCst);
    kill_run_processes(process_broker.inner(), turn_stdin_broker.inner(), &run_id);
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
    let sender = {
        let mut pending = poison_aware_lock(&*broker.0, "run approval broker", None);
        pending
            .remove(&request_id)
            .ok_or("approval is no longer pending")?
    };
    sender.send(decision).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_run(
    run_id: String,
    database: tauri::State<'_, Database>,
) -> Result<NativeRunRecord, String> {
    let connection = database_guard_for(&database);
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

/// Expose per-node verification→revision loop analytics for a run (P4).
/// Same query surface as the MCP tool `analytics_verification_loops`.
#[tauri::command]
pub(crate) fn analytics_verification_loops(
    run_id: String,
    database: tauri::State<'_, Database>,
) -> Result<Value, String> {
    let connection = database_guard_for(&database);
    verification_loops_for_run(&connection, &run_id)
}

#[tauri::command]
pub(crate) fn list_active_runs(
    workflow_id: Option<String>,
    runtime: tauri::State<'_, WorkflowRuntime>,
) -> Result<Vec<Value>, String> {
    let active = poison_aware_lock(&runtime.active, "runtime active", None);
    Ok(active
        .iter()
        .filter(|(_, run)| workflow_id.as_ref().is_none_or(|id| &run.workflow_id == id))
        .map(|(run_id, run)| json!({"runId":run_id,"workflowId":run.workflow_id,"status":run.status}))
        .collect())
}

/// Expose durable node experience to workflow chat and the workflow
/// creator/editor so they can learn from past runs.
#[tauri::command]
pub(crate) fn list_node_experience(
    workflow_id: String,
    node_id: String,
    role: String,
    model: String,
    effort: String,
    database: tauri::State<'_, Database>,
) -> Result<Vec<Value>, String> {
    let connection = database_guard_for(&database);
    get_node_experience(&connection, &workflow_id, &node_id, &role, &model, &effort)
}

#[tauri::command]
// Tauri injects each managed state value as an explicit command parameter.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn resume_run(
    run_id: String,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, WorkflowRuntime>,
    run_approvals: tauri::State<'_, RunApprovalBroker>,
    approval_broker: tauri::State<'_, ApprovalBroker>,
    process_broker: tauri::State<'_, ProcessBroker>,
    turn_stdin_broker: tauri::State<'_, TurnStdinBroker>,
    database: tauri::State<'_, Database>,
) -> Result<NativeRunRecord, String> {
    let record = get_run(run_id.clone(), database.clone())?;
    if !record.resumable || record.status != "interrupted" {
        return Err("only interrupted resumable runs can be resumed".into());
    }
    let (graph, checkpoint, target_workspace, node_tokens) = {
        let connection = database_guard_for(&database);
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
        let node_tokens = load_node_token_totals(&connection, &run_id)?;
        (
            graph,
            checkpoint,
            workspace_path.map(PathBuf::from),
            node_tokens,
        )
    };
    let stop = Arc::new(AtomicBool::new(false));
    let context = RunContext {
        run_id: run_id.clone(),
        workflow_id: record.workflow_id.clone(),
        app: Some(app.clone()),
        database: database.inner().clone(),
        graph,
        outputs: Arc::new(Mutex::new(HashMap::new())),
        node_tokens: Arc::new(Mutex::new(node_tokens)),
        stop: stop.clone(),
        sequence: Arc::new(AtomicU64::new(record.last_event_sequence)),
        limiter: runtime.limiter.clone(),
        approval_broker: approval_broker.inner().clone(),
        process_broker: process_broker.inner().clone(),
        turn_stdin_broker: turn_stdin_broker.inner().clone(),
        run_approvals: run_approvals.inner().clone(),
        target_workspace,
    };
    {
        let mut active = poison_aware_lock(&runtime.active, "runtime active", Some(&run_id));
        active.insert(
            run_id.clone(),
            ActiveRun {
                workflow_id: record.workflow_id.clone(),
                status: "running".into(),
                stop,
            },
        );
    }
    let runtime_owned = runtime.inner().clone();
    tauri::async_runtime::spawn(async move {
        run_worker(context, None, Some(checkpoint), runtime_owned).await;
    });
    Ok(record)
}

#[derive(Debug, Clone)]
struct DueSchedule {
    workflow_id: String,
    node_id: String,
    minute_key: String,
    workspace_path: Option<String>,
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

fn cron_matches_at(expression: &str, timezone: &str, now: chrono::DateTime<Utc>) -> Option<String> {
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

fn due_schedules(app: &tauri::AppHandle) -> Result<Vec<DueSchedule>, String> {
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

fn reserve_schedule_firing(app: &tauri::AppHandle, schedule: &DueSchedule) -> Result<bool, String> {
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

fn release_schedule_firing(app: &tauri::AppHandle, schedule: &DueSchedule) {
    let database = app.state::<Database>();
    let connection = database_guard_for(&database);
    let _ = connection.execute(
        "DELETE FROM schedule_firings WHERE workflow_id=?1 AND node_id=?2 AND minute_key=?3",
        params![schedule.workflow_id, schedule.node_id, schedule.minute_key],
    );
}

fn workflow_is_active(app: &tauri::AppHandle, workflow_id: &str) -> bool {
    let runtime = app.state::<WorkflowRuntime>();
    let active = poison_aware_lock(&runtime.active, "runtime active", None);
    active.values().any(|run| run.workflow_id == workflow_id)
}

fn scheduler_tick(app: &tauri::AppHandle) {
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

fn start_scheduler(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("codex-corp-scheduler".into())
        .spawn(move || loop {
            scheduler_tick(&app);
            std::thread::sleep(Duration::from_secs(15));
        });
}

/// Mark in-flight runs as interrupted and apply retention cleanup.
/// Shared by desktop `initialize` and headless `McpHost::headless` (no cron).
pub(crate) fn recover_interrupted_runs(database: &Database) -> Result<(), String> {
    let mut connection = database_guard_for(database);
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
    let _ = connection.execute(
        "DELETE FROM schedule_firings WHERE fired_at < datetime('now','-90 days')",
        [],
    );
    Ok(())
}

pub(crate) fn initialize(app: &tauri::AppHandle) {
    let _ = recover_interrupted_runs(app.state::<Database>().inner());
    start_scheduler(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn native_cron_matching_honors_timezone_and_minute_key() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 4, 30, 0).unwrap();
        assert_eq!(
            cron_matches_at("0 10 * * 5", "Asia/Kolkata", now),
            Some("2026-07-17T10:00+05:30".into())
        );
        assert!(cron_matches_at("1 10 * * 5", "Asia/Kolkata", now).is_none());
        assert!(cron_matches_at("0 10 * * 5", "Not/A_Timezone", now).is_none());
    }

    #[test]
    fn native_cron_matching_supports_lists_ranges_and_steps() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 10, 30, 0).unwrap();
        assert!(cron_matches_at("*/15 9-17 * * 1-5", "UTC", now).is_some());
        assert!(cron_matches_at("0,30 9-17 * * 1-5", "UTC", now).is_some());
        assert!(cron_matches_at("*/20 9-17 * * 1-5", "UTC", now).is_none());
    }

    #[test]
    fn process_limiter_returns_interrupted_when_stopped_while_queued() {
        let limiter = Arc::new(ProcessLimiter::new(1));
        let stop = Arc::new(AtomicBool::new(false));
        let _first = limiter.acquire(&stop).unwrap();

        let limiter2 = limiter.clone();
        let stop2 = stop.clone();
        let handle = std::thread::spawn(move || limiter2.acquire(&stop2));

        std::thread::sleep(Duration::from_millis(50));
        stop.store(true, Ordering::SeqCst);

        let result = handle.join().unwrap();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("interrupted"));
    }

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
                    tokens: 99,
                },
            )]),
        };
        let encoded = serde_json::to_string(&checkpoint).unwrap();
        let restored: RunCheckpoint = serde_json::from_str(&encoded).unwrap();
        assert!(restored.completed.contains("research"));
        assert!(restored.skipped.contains("discarded-branch"));
        assert_eq!(restored.outputs["research"].summary, "evidence");
        assert_eq!(restored.outputs["research"].tokens, 99);
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
                base_instructions: String::new(),
                developer_instructions: String::new(),
                output: None,
                user_test_feedback: Vec::new(),
                completion_criteria: Vec::new(),
                max_retries: 0,
                approval_policy: default_approval(),
                sandbox_profile: default_sandbox(),
                workspace_policy: default_workspace(),
                input_schema: None,
                timeout_seconds: default_timeout_seconds(),
                requires_approval: false,
                hard_criteria_gate: false,
                output_schema: None,
                condition_rule: None,
                cron_expression: None,
                cron_timezone: None,
                cron_enabled: true,
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
                base_instructions: String::new(),
                developer_instructions: String::new(),
                output: None,
                user_test_feedback: Vec::new(),
                completion_criteria: Vec::new(),
                max_retries: 0,
                approval_policy: "never".into(),
                // Ignored because the live named profile is authoritative.
                sandbox_profile: "read-only".into(),
                workspace_policy: default_workspace(),
                input_schema: None,
                timeout_seconds: default_timeout_seconds(),
                requires_approval: false,
                hard_criteria_gate: false,
                output_schema: None,
                condition_rule: None,
                cron_expression: None,
                cron_timezone: None,
                cron_enabled: true,
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
    fn builder_gets_danger_full_access_and_never_approval() {
        let node = RuntimeNode {
            id: "builder".into(),
            data: RuntimeNodeData {
                label: "Builder".into(),
                role: "Builder".into(),
                kind: "agent".into(),
                model: "gpt".into(),
                effort: default_effort(),
                tools: vec![
                    "Workspace read".into(),
                    "Workspace write".into(),
                    "Shell".into(),
                    "Build".into(),
                    "Test".into(),
                    "Package install".into(),
                ],
                connector_tools: vec![],
                skills: vec![],
                active_skill: None,
                permission_profile: None,
                collaboration_mode: None,
                personality: None,
                prompt: String::new(),
                base_instructions: String::new(),
                developer_instructions: String::new(),
                output: None,
                user_test_feedback: Vec::new(),
                completion_criteria: Vec::new(),
                max_retries: 0,
                approval_policy: "never".into(),
                sandbox_profile: "danger-full-access".into(),
                workspace_policy: default_workspace(),
                input_schema: None,
                timeout_seconds: default_timeout_seconds(),
                requires_approval: false,
                hard_criteria_gate: false,
                output_schema: None,
                condition_rule: None,
                cron_expression: None,
                cron_timezone: None,
                cron_enabled: true,
            },
        };
        assert_eq!(
            tool_policy(&node).unwrap(),
            ("danger-full-access".into(), "never".into())
        );
    }

    #[test]
    fn legacy_custom_kind_loads_as_claim() {
        let raw =
            r#"{"id":"c1","label":"Old","kind":"custom","enabled":true,"enforcement":"advisory"}"#;
        let criterion: RuntimeCriterion = serde_json::from_str(raw).unwrap();
        assert_eq!(criterion.kind, "claim");
        // Shared normalize_kind also trims aliases.
        let padded = r#"{"id":"c2","label":"Pad","kind":"  custom  ","enabled":true,"enforcement":"advisory"}"#;
        let criterion: RuntimeCriterion = serde_json::from_str(padded).unwrap();
        assert_eq!(criterion.kind, "claim");
    }

    fn sample_claim_criterion(enforcement: &str) -> RuntimeCriterion {
        RuntimeCriterion {
            id: "c1".into(),
            label: "Claim".into(),
            kind: "claim".into(),
            enabled: true,
            platform: false,
            enforcement: enforcement.into(),
            instruction: None,
            template_id: None,
            artifact_name: None,
            artifact_path: None,
            policy_id: None,
        }
    }

    fn sample_output(status: &str, summary: &str, data: Value) -> RuntimeOutput {
        RuntimeOutput {
            status: status.into(),
            summary: summary.into(),
            data,
            artifacts: Vec::new(),
            thread_id: None,
            turn_id: None,
            tokens: 0,
        }
    }

    #[test]
    fn hidden_reasoning_detection_handles_five_adversarial_shapes() {
        assert_eq!(
            hidden_reasoning_violation(
                "Completed the architecture handoff successfully.",
                &json!({"criteria":[{"evidence":"No hidden reasoning was exposed in the response."}]})
            ),
            None
        );

        let explicit_field = hidden_reasoning_violation(
            "Completed the architecture handoff successfully.",
            &json!({"reasoning_content":"First I considered private alternatives."}),
        )
        .expect("explicit private-reasoning key must fail");
        assert!(explicit_field.contains("data.reasoning_content"));

        let nested_field = hidden_reasoning_violation(
            "Completed the architecture handoff successfully.",
            &json!({"payload":{"debug":{"scratchpad":"private working"}}}),
        )
        .expect("nested scratchpad key must fail");
        assert!(nested_field.contains("data.payload.debug.scratchpad"));

        let labeled_section = hidden_reasoning_violation(
            "Chain of Thought:\nFirst I compared all private alternatives.",
            &json!({}),
        )
        .expect("labeled private-reasoning section must fail");
        assert!(labeled_section.contains("summary"));

        let encoded_json = hidden_reasoning_violation(
            "Completed the architecture handoff successfully.",
            &json!({"payload":"{\"internal_monologue\":\"private working\"}"}),
        )
        .expect("encoded JSON must not bypass the field scan");
        assert!(encoded_json.contains("data.payload.internal_monologue"));
    }

    #[test]
    fn producer_passed_true_ignored_for_claim() {
        let criterion = sample_claim_criterion("advisory");
        let output = sample_output(
            "success",
            "done with enough words for summary",
            json!({"criteria":[{"id":"c1","passed":true}]}),
        );
        // Real evaluation path: passed:true without evidence text still fails.
        let eval = evaluate_claim_criterion(&criterion, &output, false);
        assert!(eval.failed, "{}", eval.detail);
        assert!(eval.detail.contains("no claim evidence"));
    }

    #[test]
    fn advisory_claim_fails_on_not_satisfied() {
        let criterion = sample_claim_criterion("advisory");
        let output = sample_output(
            "success",
            "done with enough words for summary",
            json!({"criteria":[{"id":"c1","claim":"not_satisfied","evidence":"still broken"}]}),
        );
        let eval = evaluate_claim_criterion(&criterion, &output, false);
        assert!(eval.failed, "{}", eval.detail);
    }

    #[test]
    fn advisory_claim_passes_with_evidence_and_satisfied() {
        let criterion = sample_claim_criterion("advisory");
        let output = sample_output(
            "success",
            "done with enough words for summary",
            json!({"criteria":[{"id":"c1","claim":"satisfied","evidence":"screenshots attached"}]}),
        );
        let eval = evaluate_claim_criterion(&criterion, &output, false);
        assert!(!eval.failed, "{}", eval.detail);
    }

    #[test]
    fn required_claim_always_fails() {
        let criterion = sample_claim_criterion("required");
        let output = sample_output(
            "success",
            "done with enough words for summary",
            json!({"criteria":[{"id":"c1","claim":"satisfied","evidence":"ok"}]}),
        );
        let eval = evaluate_claim_criterion(&criterion, &output, true);
        assert!(eval.failed);
    }

    #[test]
    fn structured_json_requires_status_enum() {
        let ok = sample_output("success", "shipped feature", json!({}));
        assert!(!evaluate_structured_json(&ok).failed);

        let empty_status = sample_output("", "shipped feature", json!({}));
        assert!(evaluate_structured_json(&empty_status).failed);

        let bad_status = sample_output("done", "shipped feature", json!({}));
        assert!(evaluate_structured_json(&bad_status).failed);

        let empty_summary = sample_output("success", "  ", json!({}));
        assert!(evaluate_structured_json(&empty_summary).failed);
    }

    #[test]
    fn delivery_accepts_matching_pairs() {
        use crate::verifier::{
            delivery_pair_compare, ApprovedArtifact, ArtifactRef, DeliveryCompareResult,
        };
        let approved = vec![ApprovedArtifact {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        let live = vec![ArtifactRef {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        assert_eq!(
            delivery_pair_compare(&approved, &live),
            DeliveryCompareResult::Pass
        );
    }

    #[test]
    fn retry_error_classifies_transient_contract_fatal() {
        assert_eq!(
            classify_retry_error("connection reset by peer"),
            RetryErrorClass::Transient
        );
        assert_eq!(
            classify_retry_error("request timed out after 120s"),
            RetryErrorClass::Transient
        );
        assert_eq!(
            classify_retry_error("rate limit exceeded"),
            RetryErrorClass::Transient
        );
        assert_eq!(
            classify_retry_error("HTTP 429 from upstream"),
            RetryErrorClass::Transient
        );
        assert_eq!(
            classify_retry_error("failed to parse structured output JSON"),
            RetryErrorClass::Contract
        );
        assert_eq!(
            classify_retry_error("schema validation failed: missing field"),
            RetryErrorClass::Contract
        );
        assert_eq!(
            classify_retry_error("operator declined the approval gate"),
            RetryErrorClass::Fatal
        );
        // Broad false-positive guards: bare substrings no longer match.
        assert_eq!(
            classify_retry_error("returned business json payload ok"),
            RetryErrorClass::Fatal
        );
        assert_eq!(
            classify_retry_error("ticket id 42901 closed"),
            RetryErrorClass::Fatal
        );
    }

    #[test]
    fn wall_clock_deadline_errors_retry_without_broad_exceeded_false_positives() {
        // Attack vector 1: the exact production failure emitted by execute_agent.
        assert_eq!(
            classify_retry_error("Codex turn exceeded the wall-clock budget"),
            RetryErrorClass::Transient
        );
        // Attack vector 2: the normalized event wording uses the opposite order.
        assert_eq!(
            classify_retry_error("Turn wall-clock budget exceeded"),
            RetryErrorClass::Transient
        );
        // Attack vector 3: the outer watchdog has a separate deadline message.
        assert_eq!(
            classify_retry_error("execute_agent hard-deadline (600s active budget) exceeded"),
            RetryErrorClass::Transient
        );
        // Attack vector 4: casing must not change classification.
        assert_eq!(
            classify_retry_error("CODEX TURN EXCEEDED THE WALL-CLOCK BUDGET"),
            RetryErrorClass::Transient
        );
        // Attack vector 5: unrelated exceeded budgets remain fatal.
        assert_eq!(
            classify_retry_error("specialist exceeded the authorized token budget"),
            RetryErrorClass::Fatal
        );
    }

    #[test]
    fn specialist_attempts_never_reuse_threads_from_finished_ephemeral_app_servers() {
        let cases = [
            (0, 0, None),
            (1, 0, Some("retry-thread")),
            (0, 1, Some("revision-thread")),
            (2, 2, Some("older-thread")),
            (0, u32::MAX, Some("hostile-thread-id")),
        ];
        for (attempt, revision, prior) in cases {
            assert_eq!(
                specialist_thread_id_for_attempt(attempt, revision, prior),
                None
            );
        }
    }

    #[test]
    fn nested_revision_failure_keeps_the_actual_failing_node() {
        let failure = NodeExecutionFailure::owned("builder", "thread not found");
        assert_eq!(failure.owner_or("qa"), "builder");
        assert_eq!(failure.message, "thread not found");
    }

    #[test]
    fn next_retry_action_transient_does_not_plateau_on_empty_hash_sets() {
        // Two identical timeout Errs with empty artifact sets must keep retrying
        // (max_retries=2 → attempt 0 and 1 retry; attempt 2 is last).
        let empty = artifact_hash_set_key(&[]);
        let fps = vec!["fp-same".into(), "fp-same".into()];
        let arts = vec![empty.clone(), empty.clone()];
        // After attempt 1 with room to retry: still transient, not plateau.
        let action =
            next_retry_action("request timed out after 120s", 1, 2, &fps, &arts, false, "");
        match action {
            RetryAction::RetryTransient { backoff_ms } => assert!(backoff_ms >= 200),
            other => panic!("expected RetryTransient, got {other:?}"),
        }
        // Attempt at max: stop with MaxRetries.
        assert_eq!(
            next_retry_action("request timed out", 2, 2, &fps, &arts, false, ""),
            RetryAction::Stop(RetryStopReason::MaxRetries)
        );
    }

    #[test]
    fn next_retry_action_contract_repair_once_then_stop() {
        let empty = artifact_hash_set_key(&[]);
        let fps = vec!["fp0".into()];
        let arts = vec![empty];
        let first = next_retry_action(
            "failed to parse structured output JSON",
            0,
            2,
            &fps,
            &arts,
            false,
            "base",
        );
        match first {
            RetryAction::RetryContractRepair { new_extra } => {
                assert!(new_extra.contains("CONTRACT REPAIR"));
                assert!(new_extra.contains("base"));
            }
            other => panic!("expected contract repair, got {other:?}"),
        }
        let second = next_retry_action(
            "failed to parse structured output JSON",
            1,
            2,
            &["fp0".into(), "fp1".into()],
            &[artifact_hash_set_key(&[]), artifact_hash_set_key(&[])],
            true,
            "base",
        );
        assert_eq!(
            second,
            RetryAction::Stop(RetryStopReason::ContractExhausted)
        );
    }

    #[test]
    fn next_retry_action_fatal_stops_immediately() {
        assert_eq!(
            next_retry_action(
                "operator declined the approval gate",
                0,
                3,
                &[],
                &[],
                false,
                ""
            ),
            RetryAction::Stop(RetryStopReason::Fatal)
        );
    }

    #[test]
    fn retry_class_projection_covers_capability_and_specification() {
        assert_eq!(
            classify_retry_error("workspace write denied: sandbox policy is read-only"),
            RetryErrorClass::Capability
        );
        assert_eq!(
            classify_retry_error(
                "acceptance criteria are ambiguous; clarification needed before implementation"
            ),
            RetryErrorClass::Specification
        );
        assert_eq!(
            classify_retry_error("criterion npm_test exited 1"),
            RetryErrorClass::Fatal
        );
    }

    #[test]
    fn next_retry_action_capability_arms_needs_human_gate() {
        assert_eq!(
            next_retry_action(
                "workspace write denied: sandbox policy is read-only",
                0,
                2,
                &[],
                &[],
                false,
                ""
            ),
            RetryAction::NeedsHuman {
                class: FailureClass::Capability
            }
        );
        // Even at the last attempt: gate instead of MaxRetries (P2).
        assert_eq!(
            next_retry_action(
                "permission denied: not authorized for workspace.write",
                2,
                2,
                &[],
                &[],
                false,
                ""
            ),
            RetryAction::NeedsHuman {
                class: FailureClass::Capability
            }
        );
        // Plateau must NOT override a capability gate (same inputs are expected).
        let empty = artifact_hash_set_key(&[]);
        assert_eq!(
            next_retry_action(
                "workspace write denied: sandbox policy is read-only",
                1,
                2,
                &["a".into(), "a".into()],
                &[empty.clone(), empty],
                false,
                ""
            ),
            RetryAction::NeedsHuman {
                class: FailureClass::Capability
            }
        );
    }

    #[test]
    fn approved_needs_human_gate_grants_a_recovery_attempt_at_the_limit() {
        // Attack vector: an approval arriving on the final configured attempt
        // must not be discarded by the inclusive retry loop.
        assert_eq!(retry_limit_after_human_approval(0, 0), 1);
        assert_eq!(retry_limit_after_human_approval(2, 2), 3);
        // Approval before the boundary does not inflate the retry budget.
        assert_eq!(retry_limit_after_human_approval(1, 2), 2);
        // Saturation must remain bounded for hostile configuration values.
        assert_eq!(
            retry_limit_after_human_approval(u32::MAX, u32::MAX),
            u32::MAX
        );
    }

    #[test]
    fn next_retry_action_specification_arms_needs_human_gate() {
        assert_eq!(
            next_retry_action(
                "acceptance criteria are ambiguous; clarification needed before implementation",
                0,
                2,
                &[],
                &[],
                false,
                ""
            ),
            RetryAction::NeedsHuman {
                class: FailureClass::Specification
            }
        );
    }

    #[test]
    fn format_retry_stop_error_needs_human_message() {
        let message = format_retry_stop_error(
            "Builder",
            2,
            1,
            "workspace write denied",
            Some(RetryStopReason::NeedsHuman),
        );
        assert!(message.contains("needs_human"), "{message}");
        assert!(message.contains("no human unblocked"), "{message}");
    }

    #[test]
    fn format_retry_stop_error_max_retries_message() {
        let message = format_retry_stop_error(
            "Builder",
            2,
            3,
            "still broken",
            Some(RetryStopReason::MaxRetries),
        );
        assert!(message.contains("exhausted 2 retries"), "{message}");
    }

    #[test]
    fn next_retry_action_plateau_for_non_transient_including_empty_sets() {
        // Transient still never plateaus even with identical empty sets.
        let empty = artifact_hash_set_key(&[]);
        assert!(matches!(
            next_retry_action(
                "request timed out after 120s",
                1,
                3,
                &["a".into(), "a".into()],
                &[empty.clone(), empty.clone()],
                false,
                ""
            ),
            RetryAction::RetryTransient { .. }
        ));
        // Non-transient + identical fingerprints + stable hash-set (empty ok) → plateau.
        assert_eq!(
            next_retry_action(
                "operator declined",
                1,
                3,
                &["a".into(), "a".into()],
                &[empty.clone(), empty],
                false,
                ""
            ),
            RetryAction::Stop(RetryStopReason::Plateau)
        );
        // Non-empty stable artifact sets also plateau for non-transient.
        let arts = vec![
            artifact_hash_set_key(&["h1".into()]),
            artifact_hash_set_key(&["h1".into()]),
        ];
        assert_eq!(
            next_retry_action(
                "operator declined",
                1,
                3,
                &["a".into(), "a".into()],
                &arts,
                false,
                ""
            ),
            RetryAction::Stop(RetryStopReason::Plateau)
        );
    }

    #[test]
    fn attempt_artifact_hash_set_prefers_attempt_then_last_known() {
        let arts = vec![json!({"name":"a.ts","contentHash":"sha256:abc"})];
        let from_attempt = attempt_artifact_hash_set(Some(&arts), "stale");
        assert_eq!(from_attempt, artifact_hash_set_key(&["sha256:abc".into()]));
        // No attempt artifacts → carry last known.
        assert_eq!(attempt_artifact_hash_set(None, "prior-key"), "prior-key");
        // Nothing known → empty key.
        assert_eq!(
            attempt_artifact_hash_set(None, ""),
            artifact_hash_set_key(&[])
        );
    }

    #[test]
    fn slim_attempt_diagnostics_omit_artifact_content() {
        let output = RuntimeOutput {
            status: "success".into(),
            summary: "done".into(),
            data: json!({
                "verification": {"results": [{"id": "c1", "passed": true, "detail": "ok"}]},
                "noise": "drop-me"
            }),
            artifacts: vec![json!({
                "name": "src/app.ts",
                "contentHash": "sha256:dead",
                "content": "export const huge = true;".repeat(100),
                "artifactKey": "b::0::src/app.ts",
                "hostOrdinal": 0
            })],
            thread_id: None,
            turn_id: None,
            tokens: 1,
        };
        let diag = slim_attempt_completed_diagnostics(10, 1, &output);
        assert_eq!(diag.get("summary").and_then(Value::as_str), Some("done"));
        assert!(diag.pointer("/data/verification/results").is_some());
        assert!(diag.pointer("/data/noise").is_none());
        let arts = diag.get("artifacts").and_then(Value::as_array).unwrap();
        assert_eq!(arts.len(), 1);
        assert!(arts[0].get("content").is_none());
        assert_eq!(
            arts[0].get("contentHash").and_then(Value::as_str),
            Some("sha256:dead")
        );
        assert_eq!(
            arts[0].get("name").and_then(Value::as_str),
            Some("src/app.ts")
        );
    }

    #[test]
    fn slim_control_completion_preserves_release_identity_without_handoffs_or_content() {
        let output = RuntimeOutput {
            status: "success".into(),
            summary: "Approved release bundle assembled.".into(),
            data: json!({
                "schemaVersion": "codex-corp.delivery.v3",
                "bundleHash": "sha256:bundle",
                "approvedArtifacts": [{"artifactKey":"builder::0::app.ts","contentHash":"sha256:app"}],
                "liveArtifactRefs": [{"artifactKey":"builder::0::app.ts","contentHash":"sha256:app"}],
                "residualRisks": [],
                "safety": {"approval":"explicit-human"},
                "specialistHandoffs": [{"huge":"must-not-cross-the-event-bus"}]
            }),
            artifacts: vec![json!({
                "id": "delivery-bundle",
                "name": "delivery-bundle.json",
                "kind": "json",
                "contentHash": "sha256:artifact",
                "content": "large private bundle body"
            })],
            thread_id: None,
            turn_id: None,
            tokens: 0,
        };

        let diagnostics = slim_control_completed_diagnostics(&output);
        assert_eq!(
            diagnostics.get("summary").and_then(Value::as_str),
            Some("Approved release bundle assembled.")
        );
        assert_eq!(
            diagnostics
                .pointer("/data/schemaVersion")
                .and_then(Value::as_str),
            Some("codex-corp.delivery.v3")
        );
        assert!(diagnostics.pointer("/data/specialistHandoffs").is_none());
        assert!(diagnostics.pointer("/artifacts/0/content").is_none());
        assert_eq!(
            diagnostics
                .pointer("/artifacts/0/contentHash")
                .and_then(Value::as_str),
            Some("sha256:artifact")
        );
    }

    #[test]
    fn only_executable_control_nodes_publish_terminal_completion_events() {
        for kind in ["approval", "merge", "condition", "output"] {
            assert!(emits_control_completion(Some(kind)), "{kind}");
        }
        for kind in ["agent", "creative", "input", "cron", "note", "unknown"] {
            assert!(!emits_control_completion(Some(kind)), "{kind}");
        }
        assert!(!emits_control_completion(None));
    }

    #[test]
    fn revision_routed_diagnostics_are_structured_for_connector_progress() {
        let diagnostics = revision_routed_diagnostics(2, 3, "qa", "fix the defect");
        assert_eq!(diagnostics.get("revision").and_then(Value::as_u64), Some(2));
        assert_eq!(
            diagnostics.get("maxRevisions").and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(
            diagnostics.get("reviewerNodeId").and_then(Value::as_str),
            Some("qa")
        );
        assert_eq!(
            diagnostics.get("feedback").and_then(Value::as_str),
            Some("fix the defect")
        );
    }

    #[test]
    fn format_retry_stop_error_names_reason() {
        let msg =
            format_retry_stop_error("Builder", 2, 2, "timed out", Some(RetryStopReason::Plateau));
        assert!(msg.contains("plateau"), "{msg}");
        assert!(!msg.contains("exhausted 2 retries: timed out"));
        let exhausted = format_retry_stop_error(
            "Builder",
            2,
            3,
            "timed out",
            Some(RetryStopReason::MaxRetries),
        );
        assert!(exhausted.contains("exhausted 2 retries"), "{exhausted}");
    }

    #[test]
    fn collect_verification_summary_excludes_absent_blocks() {
        // Production helper used by delivery assembly (III.12).
        let mut outputs = HashMap::new();
        outputs.insert(
            "builder".into(),
            RuntimeOutput {
                status: "success".into(),
                summary: "built".into(),
                data: json!({
                    "verification": {
                        "results": [{"id": "structured_json", "passed": true, "detail": "ok"}],
                        "requiredFailed": [],
                        "passBitOwner": "runtime"
                    }
                }),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
                tokens: 0,
            },
        );
        outputs.insert(
            "qa".into(),
            RuntimeOutput {
                status: "success".into(),
                summary: "checked".into(),
                data: json!({"note": "no verification"}),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
                tokens: 0,
            },
        );
        let summary = collect_verification_summary(&outputs);
        assert_eq!(summary.len(), 1);
        assert_eq!(
            summary[0].get("passBitOwner").and_then(Value::as_str),
            Some("runtime")
        );
    }

    fn sample_run_context(target_workspace: Option<PathBuf>) -> RunContext {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        RunContext {
            run_id: "run-test".into(),
            workflow_id: "wf-test".into(),
            app: None,
            database: Database(Arc::new(Mutex::new(connection))),
            graph: RuntimeGraph {
                nodes: vec![],
                edges: vec![],
            },
            outputs: Arc::new(Mutex::new(HashMap::new())),
            node_tokens: Arc::new(Mutex::new(HashMap::new())),
            stop: Arc::new(AtomicBool::new(false)),
            sequence: Arc::new(AtomicU64::new(0)),
            limiter: Arc::new(ProcessLimiter::new(1)),
            approval_broker: ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))),
            process_broker: ProcessBroker(Arc::new(Mutex::new(HashMap::new()))),
            turn_stdin_broker: TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))),
            run_approvals: RunApprovalBroker::default(),
            target_workspace,
        }
    }

    #[test]
    fn normalized_event_item_types_are_explicit() {
        assert_eq!(event_item_type("node.attempt.completed"), "node");
        assert_eq!(event_item_type("approval.requested"), "approval");
        assert_eq!(event_item_type("verification.failed"), "verification");
        assert_eq!(event_item_type("unexpected.event"), "runtime");
    }

    #[test]
    fn specialist_input_is_direct_mapped_and_revision_scoped() {
        let mut context = sample_run_context(None);
        context.graph = serde_json::from_value(json!({
            "nodes": [
                {"id":"input","data":{"label":"Input","role":"Input","kind":"input","output":"mission","userTestFeedback":["save button is inert"]}},
                {"id":"a","data":{"label":"A","role":"A","kind":"agent"}},
                {"id":"unrelated","data":{"label":"Secret","role":"Secret","kind":"agent"}},
                {"id":"review","data":{"label":"Review","role":"Review","kind":"agent"}},
                {"id":"target","data":{"label":"Target","role":"Target","kind":"agent"}}
            ],
            "edges": [
                {"id":"mapped","source":"a","target":"target","data":{"edgeType":"standard","mapping":{"score":"$.data.score"}}},
                {"id":"other","source":"unrelated","target":"review","data":{"edgeType":"standard"}},
                {"id":"revision","source":"review","target":"target","data":{"edgeType":"revision"}}
            ]
        })).unwrap();
        context.outputs.lock().extend([
            (
                "a".into(),
                sample_output("success", "done", json!({"score":7})),
            ),
            (
                "unrelated".into(),
                sample_output("success", "secret", json!({"score":99})),
            ),
        ]);
        let target = context
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "target")
            .unwrap();
        let composed = compose_specialist_input(&context, target, "fix this").unwrap();
        assert_eq!(composed["workflowInput"], "mission");
        assert_eq!(composed["upstreamOutputs"].as_array().unwrap().len(), 1);
        assert_eq!(
            composed["upstreamOutputs"][0]["payload"],
            json!({"score":7})
        );
        assert_eq!(
            composed["revisionFeedback"],
            json!([{"message":"fix this"}])
        );
        assert_eq!(
            composed["operatorTestFeedback"],
            json!(["save button is inert"])
        );
        assert!(!composed.to_string().contains("secret"));
    }

    #[test]
    fn mapped_output_collects_missing_paths() {
        let output = sample_output("success", "ok", json!({"score": 7}));
        let mut mapping = HashMap::new();
        mapping.insert("score".into(), "$.data.score".into());
        mapping.insert("missing".into(), "$.data.not_present".into());
        mapping.insert("bad_path".into(), "data.score".into()); // no $. prefix
        let mapped = mapped_output(&output, Some(&mapping));
        assert_eq!(
            mapped.value,
            json!({"score": 7, "missing": null, "bad_path": null})
        );
        let missing: HashSet<_> = mapped.missing.iter().cloned().collect();
        assert_eq!(missing.len(), 2, "expected two missing mapped paths");
        assert!(missing.contains(&("missing".into(), "$.data.not_present".into())));
        assert!(missing.contains(&("bad_path".into(), "data.score".into())));
    }

    #[test]
    fn compose_specialist_input_emits_mapping_missing_event() {
        let mut context = sample_run_context(None);
        {
            let connection = context.database.0.lock();
            crate::initialize_database(&connection).unwrap();
        }
        context.graph = serde_json::from_value(json!({
            "nodes": [
                {"id":"input","data":{"label":"Input","role":"Input","kind":"input","output":"mission"}},
                {"id":"a","data":{"label":"A","role":"A","kind":"agent"}},
                {"id":"target","data":{"label":"Target","role":"Target","kind":"agent"}}
            ],
            "edges": [
                {"id":"mapped","source":"a","target":"target","data":{"edgeType":"standard","mapping":{"missing":"$.data.not_present"}}}
            ]
        })).unwrap();
        context.outputs.lock().extend([(
            "a".into(),
            sample_output("success", "done", json!({"score":7})),
        )]);
        let target = context
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "target")
            .unwrap();
        let composed = compose_specialist_input(&context, target, "").unwrap();
        assert_eq!(
            composed["upstreamOutputs"][0]["payload"],
            json!({"missing": null})
        );
        let connection = context.database.0.lock();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM run_events WHERE event_type='node.input.mapping.missing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing mapping should emit a warning event");
    }

    #[test]
    fn json_schema_validation_rejects_contract_mismatches() {
        let schema = r#"{"type":"object","required":["workflowInput"],"properties":{"workflowInput":{"type":"string"}}}"#;
        assert!(validate_json_schema(schema, &json!({"workflowInput":"ok"}), "input").is_ok());
        assert!(
            validate_json_schema(schema, &json!({"workflowInput":7}), "input")
                .unwrap_err()
                .contains("schema validation failed")
        );
    }

    #[test]
    fn evaluate_host_io_criteria_fail_closed_without_workspace() {
        // Belt-and-suspenders: evaluate path never falls back to process CWD.
        // Command runner must not spawn when workspace is missing.
        let context = sample_run_context(None);
        let output = sample_output(
            "success",
            "agent claims tests passed with enough words",
            json!({}),
        );
        let command = RuntimeCriterion {
            id: "npm_test".into(),
            label: "Unit tests".into(),
            kind: "command".into(),
            enabled: true,
            platform: false,
            enforcement: "required".into(),
            instruction: None,
            template_id: Some("npm_test".into()),
            artifact_name: None,
            artifact_path: None,
            policy_id: None,
        };
        let eval = evaluate_criterion(&command, &output, &context);
        assert!(eval.failed, "{}", eval.detail);
        assert!(
            eval.detail.contains("workspacePath is required"),
            "detail={}",
            eval.detail
        );
        assert_eq!(eval.method, "command");

        let arch = RuntimeCriterion {
            id: "arch".into(),
            label: "Native runtime".into(),
            kind: "architecture_policy".into(),
            enabled: true,
            platform: false,
            enforcement: "required".into(),
            instruction: None,
            template_id: None,
            artifact_name: None,
            artifact_path: None,
            policy_id: Some("native_runtime_ownership_v1".into()),
        };
        let eval = evaluate_criterion(&arch, &output, &context);
        assert!(eval.failed, "{}", eval.detail);
        assert!(
            eval.detail.contains("workspacePath is required"),
            "detail={}",
            eval.detail
        );
        assert!(
            eval.method.starts_with("architecture_policy"),
            "method={}",
            eval.method
        );
    }

    #[test]
    fn host_io_criteria_require_workspace_helpers() {
        assert!(crate::verifier::kind_requires_workspace("command"));
        assert!(crate::verifier::kind_requires_workspace(
            "architecture_policy"
        ));
        assert!(!crate::verifier::kind_requires_workspace("claim"));
        assert!(!crate::verifier::kind_requires_workspace("structured_json"));

        let node = |criteria: Vec<RuntimeCriterion>| RuntimeNode {
            id: "n1".into(),
            data: RuntimeNodeData {
                label: "n1".into(),
                role: "agent".into(),
                kind: "agent".into(),
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
                base_instructions: String::new(),
                developer_instructions: String::new(),
                output: None,
                user_test_feedback: Vec::new(),
                completion_criteria: criteria,
                max_retries: 0,
                approval_policy: default_approval(),
                sandbox_profile: default_sandbox(),
                workspace_policy: default_workspace(),
                input_schema: None,
                timeout_seconds: default_timeout_seconds(),
                requires_approval: false,
                hard_criteria_gate: false,
                output_schema: None,
                condition_rule: None,
                cron_expression: None,
                cron_timezone: None,
                cron_enabled: true,
            },
        };
        let command_criterion = RuntimeCriterion {
            id: "npm_test".into(),
            label: "Unit tests".into(),
            kind: "command".into(),
            enabled: true,
            platform: false,
            enforcement: "required".into(),
            instruction: None,
            template_id: Some("npm_test".into()),
            artifact_name: None,
            artifact_path: None,
            policy_id: None,
        };
        let disabled = RuntimeCriterion {
            enabled: false,
            ..command_criterion.clone()
        };
        let with_enabled = RuntimeGraph {
            nodes: vec![node(vec![command_criterion])],
            edges: vec![],
        };
        let with_disabled = RuntimeGraph {
            nodes: vec![node(vec![disabled])],
            edges: vec![],
        };
        assert!(graph_has_enabled_host_io_criteria(&with_enabled));
        assert!(!graph_has_enabled_host_io_criteria(&with_disabled));
    }

    #[test]
    fn required_criteria_failure_prefers_verification_ssot_without_reeval() {
        // Gate must use precomputed verification.results (plan III.4) so expensive
        // command/architecture verifiers are not re-run after the block is built.
        let criteria = vec![RuntimeCriterion {
            id: "npm_test".into(),
            label: "Unit tests".into(),
            kind: "command".into(),
            enabled: true,
            platform: false,
            enforcement: "required".into(),
            instruction: None,
            template_id: Some("npm_test".into()),
            artifact_name: None,
            artifact_path: None,
            policy_id: None,
        }];
        let fail_output = RuntimeOutput {
            status: "success".into(),
            summary: "done with enough words for a summary".into(),
            data: json!({
                "verification": {
                    "results": [{
                        "id": "npm_test",
                        "label": "Unit tests",
                        "kind": "command",
                        "passed": false,
                        "detail": "npm_test exited 1 — simulated",
                        "method": "command:npm_test",
                        "enforcement": "required",
                        "source": "runtime"
                    }],
                    "requiredFailed": ["npm_test"],
                    "passBitOwner": "runtime"
                }
            }),
            artifacts: Vec::new(),
            thread_id: None,
            turn_id: None,
            tokens: 0,
        };
        // SSOT path is pure — no RunContext / ProcessCommandRunner needed.
        assert_eq!(
            verification_result_row(&fail_output, "npm_test"),
            Some((false, "npm_test exited 1 — simulated".into()))
        );
        // Mirror gate control flow when verification.results is present.
        let mut message: Option<String> = None;
        for c in &criteria {
            if !(c.platform || c.enforcement == "required") {
                continue;
            }
            if let Some((passed, detail)) = verification_result_row(&fail_output, &c.id) {
                if !passed {
                    message = Some(format!(
                        "required completion criterion failed: {} — {}",
                        c.label, detail
                    ));
                }
            } else {
                panic!("must not fall through to evaluate_criterion when SSOT row exists");
            }
        }
        let msg = message.expect("should fail from SSOT");
        assert!(msg.contains("Unit tests"));
        assert!(msg.contains("npm_test exited 1"));

        let pass_output = RuntimeOutput {
            data: json!({
                "verification": {
                    "results": [{
                        "id": "npm_test",
                        "passed": true,
                        "detail": "npm_test exited 0"
                    }]
                }
            }),
            ..fail_output
        };
        assert_eq!(
            verification_result_row(&pass_output, "npm_test"),
            Some((true, "npm_test exited 0".into()))
        );
        for c in &criteria {
            if let Some((passed, _)) = verification_result_row(&pass_output, &c.id) {
                assert!(passed, "SSOT pass must not trigger required failure");
            }
        }
    }

    #[test]
    fn a_passed_re_review_clears_the_revision_gate() {
        let context = sample_run_context(None);
        let criteria = vec![RuntimeCriterion {
            id: "npm_test".into(),
            label: "Unit tests".into(),
            kind: "command".into(),
            enabled: true,
            platform: false,
            enforcement: "required".into(),
            instruction: None,
            template_id: Some("npm_test".into()),
            artifact_name: None,
            artifact_path: None,
            policy_id: None,
        }];
        let output = sample_output(
            "success",
            "QA passed after the builder revision.",
            json!({
                "verification": {
                    "results": [{
                        "id": "npm_test",
                        "passed": true,
                        "detail": "npm_test exited 0"
                    }]
                }
            }),
        );

        let (failure, reason) = revision_gate_state(&criteria, &output, &context, false);

        assert!(failure.is_none(), "a passed host row must clear the gate");
        assert!(reason.is_none(), "a passed re-review must stop the loop");
    }

    #[test]
    fn a_failed_re_review_keeps_the_revision_gate_open() {
        let context = sample_run_context(None);
        let criteria = vec![RuntimeCriterion {
            id: "npm_test".into(),
            label: "Unit tests".into(),
            kind: "command".into(),
            enabled: true,
            platform: false,
            enforcement: "required".into(),
            instruction: None,
            template_id: Some("npm_test".into()),
            artifact_name: None,
            artifact_path: None,
            policy_id: None,
        }];
        let output = sample_output(
            "success",
            "QA completed with a host failure.",
            json!({
                "verification": {
                    "results": [{
                        "id": "npm_test",
                        "passed": false,
                        "detail": "npm_test exited 1"
                    }]
                }
            }),
        );

        let (failure, reason) = revision_gate_state(&criteria, &output, &context, false);

        assert!(failure.is_some(), "a failed host row must remain blocking");
        assert!(
            reason.is_some(),
            "the blocking detail must route to revision"
        );
    }

    #[test]
    fn needs_revision_output_stays_revision_owned_without_fabricating_a_host_failure() {
        let context = sample_run_context(None);
        let output = sample_output(
            "needs_revision",
            "The cart count still disagrees with rendered lines.",
            json!({}),
        );

        let (failure, reason) = revision_gate_state(&[], &output, &context, false);

        assert!(failure.is_none());
        assert_eq!(
            reason.as_deref(),
            Some("The cart count still disagrees with rendered lines.")
        );
    }

    #[test]
    fn verification_revision_routes_persist_attempt_records() {
        // P3: each required-verification revision routing writes a node_attempts
        // record carrying failureClass:"verification" + failing criterion ids,
        // queryable via count_verification_revisions without re-parsing delivery.
        let context = sample_run_context(None);
        {
            let connection = context.database.0.lock();
            connection
                .execute_batch(
                    "CREATE TABLE node_attempts (
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
                    );",
                )
                .unwrap();
        }
        record_verification_revision(
            &context,
            "reviewer",
            "builder",
            1,
            &["cmd-1".into()],
            "required completion criterion failed: Unit tests — npm_test exited 1",
        );
        record_verification_revision(
            &context,
            "reviewer",
            "builder",
            2,
            &["cmd-1".into(), "arch-1".into()],
            "still failing",
        );
        record_verification_revision(&context, "other-reviewer", "builder", 1, &["x".into()], "x");
        {
            let connection = context.database.0.lock();
            assert_eq!(
                count_verification_revisions(&connection, "run-test", "reviewer").unwrap(),
                2
            );
            assert_eq!(
                count_verification_revisions(&connection, "run-test", "other-reviewer").unwrap(),
                1
            );
            assert_eq!(
                count_verification_revisions(&connection, "run-test", "builder").unwrap(),
                0
            );
            // Failing criterion ids preserved intact and queryable.
            let with_cmd: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM node_attempts
                     WHERE run_id='run-test' AND node_id='reviewer'
                       AND json_extract(diagnostics_json,'$.failureClass')='verification'
                       AND json_extract(diagnostics_json,'$.criterionIds[0]')='cmd-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(with_cmd, 2);
            let second_criterion: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM node_attempts
                     WHERE run_id='run-test'
                       AND json_extract(diagnostics_json,'$.criterionIds[1]')='arch-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(second_criterion, 1);
            // routedTo persisted for loop analytics.
            let routed: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM node_attempts
                     WHERE run_id='run-test' AND node_id='reviewer'
                       AND json_extract(diagnostics_json,'$.routedTo')='builder'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(routed, 2);
        }
    }

    #[test]
    fn verification_loops_for_run_aggregates_per_node() {
        // P4: the analytics query surface must group per node and preserve the
        // failing criterion ids (deduped) exactly like the inspector chip uses.
        let context = sample_run_context(None);
        {
            let connection = context.database.0.lock();
            connection
                .execute_batch(
                    "CREATE TABLE node_attempts (
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
                    );",
                )
                .unwrap();
        }
        record_verification_revision(
            &context,
            "reviewer",
            "producer",
            1,
            &["cmd-1".into(), "arch-1".into()],
            "required completion criterion failed: Unit tests — npm_test exited 1",
        );
        record_verification_revision(
            &context,
            "reviewer",
            "producer",
            2,
            &["cmd-1".into()],
            "still failing",
        );
        record_verification_revision(&context, "qa", "producer", 1, &["hidden-1".into()], "nope");
        // A non-verification attempt must not count toward loop analytics.
        {
            let connection = context.database.0.lock();
            connection
                .execute(
                    "INSERT INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json)
                     VALUES('x1','run-test','reviewer',0,0,'failed',
                            '{\"failureClass\":\"capability\",\"summary\":\"denied\"}')",
                    [],
                )
                .unwrap();
            // Attack vector: a forged failureClass without the verification gate
            // must not be promoted into a verification loop.
            connection
                .execute(
                    "INSERT INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json)
                     VALUES('x2','run-test','spoofed',0,0,'failed',
                            '{\"failureClass\":\"verification\",\"summary\":\"npm test exited 1\"}')",
                    [],
                )
                .unwrap();
        }
        let connection = context.database.0.lock();
        let value = verification_loops_for_run(&connection, "run-test").unwrap();
        assert_eq!(value["runId"], "run-test");
        let nodes = value["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2, "capability row must be excluded: {value}");
        let reviewer = nodes
            .iter()
            .find(|node| node["nodeId"] == "reviewer")
            .expect("reviewer present");
        assert_eq!(reviewer["verificationRevisions"], 2);
        let ids: Vec<&str> = reviewer["criterionIds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["arch-1", "cmd-1"],
            "criterion ids deduped + sorted"
        );
        let qa = nodes
            .iter()
            .find(|node| node["nodeId"] == "qa")
            .expect("qa present");
        assert_eq!(qa["verificationRevisions"], 1);
        assert_eq!(
            qa["criterionIds"][0].as_str(),
            Some("hidden-1"),
            "per-node criterion ids ride the record"
        );
    }

    #[test]
    fn delivery_rejects_verification_block_absent_on_specialist() {
        let graph: RuntimeGraph = serde_json::from_value(json!({
            "nodes": [
                {"id":"builder","data":{"label":"Builder","role":"Builder","kind":"agent"}},
                {"id":"qa","data":{"label":"QA","role":"QA","kind":"agent"}},
                {"id":"approval","data":{"label":"Approval","role":"Human","kind":"approval"}},
                {"id":"out","data":{"label":"Out","role":"Out","kind":"output"}}
            ],
            "edges": []
        }))
        .unwrap();
        let mut outputs = HashMap::new();
        outputs.insert(
            "builder".into(),
            RuntimeOutput {
                status: "success".into(),
                summary: "built with verification".into(),
                data: json!({
                    "verification": {
                        "results": [{"id": "structured_json", "passed": true}],
                        "passBitOwner": "runtime"
                    }
                }),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
                tokens: 0,
            },
        );
        // Specialist completed without host verification SSOT — delivery must reject.
        outputs.insert(
            "qa".into(),
            RuntimeOutput {
                status: "success".into(),
                summary: "looks good".into(),
                data: json!({"verdict": "pass"}),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
                tokens: 0,
            },
        );
        let err = require_specialist_verification_blocks(&graph, &outputs).unwrap_err();
        assert!(
            err.contains("missing data.verification") && err.contains("qa"),
            "{err}"
        );

        // With verification present on all specialists, gate passes.
        outputs.insert(
            "qa".into(),
            RuntimeOutput {
                status: "success".into(),
                summary: "verified".into(),
                data: json!({
                    "verification": {
                        "results": [{"id": "structured_json", "passed": true}],
                        "passBitOwner": "runtime"
                    }
                }),
                artifacts: Vec::new(),
                thread_id: None,
                turn_id: None,
                tokens: 0,
            },
        );
        assert!(require_specialist_verification_blocks(&graph, &outputs).is_ok());
    }

    #[test]
    fn resolve_artifact_content_hash_backfills_null_or_empty() {
        let recomputed = resolve_artifact_content_hash(None, "export const x=1");
        assert!(recomputed.starts_with("sha256:"));
        assert_eq!(
            resolve_artifact_content_hash(Some(""), "export const x=1"),
            recomputed
        );
        assert_eq!(
            resolve_artifact_content_hash(Some("sha256:abc"), "ignored"),
            "sha256:abc"
        );
        // Empty approved hash still fails pair-compare against live recomputed hash.
        let approved = crate::verifier::ApprovedArtifact {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: String::new(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        };
        let live = crate::verifier::ArtifactRef {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: recomputed,
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        };
        match crate::verifier::delivery_pair_compare(&[approved], &[live]) {
            crate::verifier::DeliveryCompareResult::Fail(msg) => {
                assert!(msg.contains("hash mismatch"))
            }
            crate::verifier::DeliveryCompareResult::Pass => {
                panic!("empty approved hash must not pass")
            }
        }
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
    fn start_node_scope_keeps_prerequisites_completed_without_poisoning_the_retry_branch() {
        let graph: RuntimeGraph = serde_json::from_value(json!({
            "nodes":[
                {"id":"input","data":{"label":"Input","role":"Input","kind":"input"}},
                {"id":"pm","data":{"label":"PM","role":"PM","kind":"agent"}},
                {"id":"builder","data":{"label":"Builder","role":"Builder","kind":"agent"}},
                {"id":"qa","data":{"label":"QA","role":"QA","kind":"agent"}},
                {"id":"approval","data":{"label":"Approval","role":"Approval","kind":"approval"}},
                {"id":"output","data":{"label":"Output","role":"Output","kind":"output"}},
                {"id":"unrelated","data":{"label":"Unrelated","role":"Unrelated","kind":"agent"}}
            ],
            "edges":[
                {"id":"i-p","source":"input","target":"pm"},
                {"id":"p-b","source":"pm","target":"builder"},
                {"id":"b-q","source":"builder","target":"qa"},
                {"id":"q-a","source":"qa","target":"approval","data":{"edgeType":"approval"}},
                {"id":"a-o","source":"approval","target":"output"},
                {"id":"q-b","source":"qa","target":"builder","data":{"edgeType":"revision"}}
            ]
        }))
        .unwrap();

        // Attack vector 1: the selected node and its normal descendants execute.
        let (included, completed, mut skipped) = initial_execution_sets(&graph, Some("qa"));
        assert_eq!(
            included,
            HashSet::from(["qa".into(), "approval".into(), "output".into()])
        );
        // Attack vector 2: ordinary ancestors satisfy dependencies but are not treated as excluded branches.
        assert!(completed.is_superset(&HashSet::from([
            "input".into(),
            "pm".into(),
            "builder".into()
        ])));
        assert!(!skipped.contains("builder"));
        // Attack vector 3: an unrelated node remains excluded.
        assert!(skipped.contains("unrelated"));
        // Attack vector 4: a reverse revision edge never makes the selected QA node skip itself.
        assert!(propagate_skips(&graph, &included, &completed, &mut skipped).is_empty());
        assert!(!skipped.contains("qa"));
        // Attack vector 5: a full run includes everything and has no precompleted/excluded branch state.
        let (all, precompleted, excluded) = initial_execution_sets(&graph, None);
        assert_eq!(all.len(), graph.nodes.len());
        assert!(precompleted.iter().all(|id| id == "input"));
        assert!(excluded.is_empty());
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

    #[test]
    fn approval_wait_times_out_without_an_operator() {
        let (_sender, receiver) = mpsc::channel();
        let stop = AtomicBool::new(false);
        let started = Instant::now();
        let result = wait_for_approval(
            &receiver,
            &stop,
            Duration::from_millis(150),
            Duration::from_millis(10),
        );
        assert_eq!(result.unwrap_err(), "operator approval timed out");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn needs_human_timeout_parses_defaults_clamps_per_gate() {
        assert_eq!(parse_needs_human_timeout(None), 30);
        assert_eq!(parse_needs_human_timeout(Some("")), 30);
        assert_eq!(parse_needs_human_timeout(Some("nonsense")), 30);
        assert_eq!(parse_needs_human_timeout(Some("0")), 1);
        assert_eq!(parse_needs_human_timeout(Some("999999")), 3600);
        assert_eq!(parse_needs_human_timeout(Some("5")), 5);
        // Headless needs_human resolves fail-closed within the short window by
        // default, while the desktop gate keeps the interactive timeout.
        let needs_human = operator_approval_timeout("needs_human", true).as_secs();
        assert!(
            (1..=30).contains(&needs_human),
            "needs_human must default <=30s, was {needs_human}s"
        );
        assert_eq!(
            operator_approval_timeout("needs_human", false).as_secs(),
            30 * 60
        );
        // Other approval gates keep the long operator window in both modes.
        assert_eq!(
            operator_approval_timeout("approval", true).as_secs(),
            30 * 60
        );
        assert_eq!(
            operator_approval_timeout("post-node-approval", false).as_secs(),
            30 * 60
        );
    }

    #[test]
    fn needs_human_gate_declines_fast_and_stays_resolvable() {
        let context = sample_run_context(None);
        let graph: RuntimeGraph = serde_json::from_value(json!({
            "nodes": [{"id":"builder","data":{"label":"Builder","role":"Builder","kind":"agent"}}],
            "edges": []
        }))
        .unwrap();
        let node = graph.nodes[0].clone();

        let span_context = context.clone();
        let span = std::thread::spawn(move || {
            tauri::async_runtime::block_on(await_operator_approval(
                &span_context,
                &node,
                "needs_human",
                "capability boundary hit",
            ))
        });

        // Poll the broker until the gate arms, then decline it as an operator would.
        let mut sender = None;
        let request_id = "run-test::builder::needs_human";
        for _ in 0..100 {
            sender = context.run_approvals.0.lock().remove(request_id);
            if sender.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let sender = sender.expect("needs_human gate must arm in the broker");
        sender.send(false).unwrap();

        let started = Instant::now();
        let result = span.join().unwrap();
        assert!(result.is_err(), "decline must fail the gate");
        assert!(
            result.unwrap_err().contains("declined"),
            "gate decline should surface as decline, not hang"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "declined gate must resolve fast, not wait the full window"
        );
    }

    #[test]
    fn recover_interrupted_runs_marks_running_as_interrupted() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::initialize_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO runs(id,workflow_id,status,events_json,nodes_json,edges_json)
                 VALUES('run-recovery','wf','running','[]','[]','[]')",
                [],
            )
            .unwrap();
        // Ensure optional columns used by recovery UPDATE exist (migrated schema).
        let _ = connection.execute(
            "UPDATE runs SET resumable=0, terminal_reason=NULL WHERE id='run-recovery'",
            [],
        );
        let database = Database(Arc::new(Mutex::new(connection)));
        recover_interrupted_runs(&database).unwrap();
        let connection = database.0.lock();
        let (status, resumable, reason): (String, i64, Option<String>) = connection
            .query_row(
                "SELECT status,resumable,terminal_reason FROM runs WHERE id='run-recovery'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "interrupted");
        assert_eq!(resumable, 1);
        assert!(reason
            .as_deref()
            .unwrap_or("")
            .contains("application restarted"));
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
            tokens: 0,
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

    #[test]
    fn node_experience_records_and_recalls_for_self_improvement() {
        let mut context = sample_run_context(None);
        {
            let connection = context.database.0.lock();
            crate::initialize_database(&connection).unwrap();
        }
        context.graph = serde_json::from_value(json!({
            "nodes": [{
                "id": "greeter",
                "data": {
                    "label": "Greeter",
                    "role": "greeting-specialist",
                    "kind": "agent",
                    "model": "gpt-5.6-luna",
                    "effort": "low"
                }
            }],
            "edges": []
        }))
        .unwrap();
        let node = context
            .graph
            .nodes
            .iter()
            .find(|n| n.id == "greeter")
            .unwrap();

        let base = || NodeExperience {
            node_id: node.id.clone(),
            workflow_id: context.workflow_id.clone(),
            role: node.data.role.clone(),
            model: node.data.model.clone(),
            effort: node.data.effort.clone(),
            failure_class: Some("contract".into()),
            stop_reason: Some("max_retries".into()),
            outcome: "max_retries".into(),
            attempt_count: 0,
            total_tokens: 0,
            latency_ms: 0,
        };

        let mut first = base();
        first.attempt_count = 3;
        first.total_tokens = 120;
        first.latency_ms = 4500;
        record_node_experience(&context, &first).unwrap();

        let mut second = base();
        second.attempt_count = 2;
        second.total_tokens = 90;
        second.latency_ms = 3200;
        record_node_experience(&context, &second).unwrap();

        let records = load_node_experience(&context, node).unwrap();
        assert_eq!(records.len(), 2, "both experience rows should be loaded");
        let guidance = experience_guidance(&records)
            .expect("recurring contract failures should produce guidance");
        assert!(
            guidance.to_ascii_lowercase().contains("schema")
                || guidance.to_ascii_lowercase().contains("structured json"),
            "guidance should nudge the specialist toward valid structured JSON: {guidance}"
        );

        // A recent success should suppress failure-derived guidance.
        record_node_experience(
            &context,
            &NodeExperience {
                failure_class: None,
                stop_reason: None,
                outcome: "success".into(),
                attempt_count: 1,
                total_tokens: 12,
                latency_ms: 800,
                ..base()
            },
        )
        .unwrap();
        let records_after_success = load_node_experience(&context, node).unwrap();
        assert!(
            experience_guidance(&records_after_success).is_none(),
            "a recent success should suppress pre-emptive failure guidance"
        );
    }

    #[test]
    fn node_experience_ignores_stale_success_when_recent_fails() {
        let mut context = sample_run_context(None);
        {
            let connection = context.database.0.lock();
            crate::initialize_database(&connection).unwrap();
        }
        context.graph = serde_json::from_value(json!({
            "nodes": [{
                "id": "greeter",
                "data": {
                    "label": "Greeter",
                    "role": "greeting-specialist",
                    "kind": "agent",
                    "model": "gpt-5.6-luna",
                    "effort": "low"
                }
            }],
            "edges": []
        }))
        .unwrap();
        let node = context
            .graph
            .nodes
            .iter()
            .find(|n| n.id == "greeter")
            .unwrap();

        let base = || NodeExperience {
            node_id: node.id.clone(),
            workflow_id: context.workflow_id.clone(),
            role: node.data.role.clone(),
            model: node.data.model.clone(),
            effort: node.data.effort.clone(),
            failure_class: Some("contract".into()),
            stop_reason: Some("max_retries".into()),
            outcome: "max_retries".into(),
            attempt_count: 0,
            total_tokens: 0,
            latency_ms: 0,
        };

        // An older success should not suppress guidance when the most recent
        // attempts are failing again.
        record_node_experience(
            &context,
            &NodeExperience {
                failure_class: None,
                stop_reason: None,
                outcome: "success".into(),
                attempt_count: 1,
                total_tokens: 12,
                latency_ms: 800,
                ..base()
            },
        )
        .unwrap();
        for _ in 0..2 {
            record_node_experience(&context, &base()).unwrap();
        }

        let records = load_node_experience(&context, node).unwrap();
        assert!(
            experience_guidance(&records).is_some(),
            "recurring recent failures should produce guidance despite an older success"
        );
    }

    #[test]
    fn database_guard_returns_usable_connection() {
        let context = sample_run_context(None);
        {
            let connection = context.database.0.lock();
            crate::initialize_database(&connection).unwrap();
        }
        let guard = database_guard(&context);
        let count: i64 = guard
            .query_row("SELECT COUNT(*) FROM node_experience", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "database_guard should return a usable connection");
    }

    #[test]
    #[ignore = "set CODEX_CORP_LIVE_LUNA_TEST=1 to run a real Luna low call (costs tokens)"]
    fn live_luna_low_agent_roundtrip() {
        if std::env::var("CODEX_CORP_LIVE_LUNA_TEST").is_err() {
            return;
        }
        let temp_dir =
            std::env::temp_dir().join(format!("codex-corp-live-luna-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let output_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["status", "summary", "data", "artifacts"],
            "properties": {
                "status": { "type": "string", "enum": ["success", "failure"] },
                "summary": { "type": "string" },
                "data": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["greeting"],
                    "properties": {
                        "greeting": { "type": "string" }
                    }
                },
                "artifacts": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["name", "kind", "content"],
                        "properties": {
                            "name": { "type": "string" },
                            "kind": { "type": "string", "enum": ["code", "document", "json", "image", "link"] },
                            "content": { "type": "string" }
                        }
                    }
                }
            }
        });
        let request = AgentRequest {
            node_id: "live-luna".into(),
            run_id: Some("live-run".into()),
            attempt_id: Some("a0".into()),
            thread_id: None,
            role: "greeting-specialist".into(),
            model: "gpt-5.6-luna".into(),
            effort: "low".into(),
            base_instructions: "".into(),
            developer_instructions: "Return only a raw JSON object. Do not use markdown code fences or explanation. The data object should contain a single key 'greeting' with a friendly one-sentence greeting string. artifacts must be an empty array.".into(),
            user_input: "Produce a friendly one-sentence greeting and return it as JSON.".into(),
            upstream_outputs: Vec::new(),
            approval_policy: "never".into(),
            sandbox_profile: "workspace-write".into(),
            permission_profile: None,
            collaboration_mode: None,
            personality: None,
            workspace_policy: "workflow".into(),
            target_workspace: Some(temp_dir.to_string_lossy().into_owned()),
            timeout_seconds: 60,
            output_schema: Some(output_schema),
            tools: Vec::new(),
            skills: Vec::new(),
            tool_boundary: "".into(),
            app_server_path: None,
        };
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::initialize_database(&connection).unwrap();
        let result = tauri::async_runtime::block_on(execute_agent_internal(
            request,
            None,
            ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))),
            ProcessBroker(Arc::new(Mutex::new(HashMap::new()))),
            TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))),
            Database(Arc::new(Mutex::new(connection))),
            Arc::new(AtomicU64::new(0)),
        ))
        .expect("luna low call should succeed");
        assert_eq!(
            result.status, "success",
            "agent should report success: {}",
            result.summary
        );
        let greeting = result
            .data
            .get("greeting")
            .and_then(Value::as_str)
            .expect("data.greeting should be present");
        assert!(!greeting.is_empty(), "greeting should not be empty");
    }
}
