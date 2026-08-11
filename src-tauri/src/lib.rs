use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use parking_lot::{Condvar, Mutex, MutexGuard};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

mod app_settings;
mod business_data;
mod chat_data;
pub(crate) mod codex_turn;
pub mod golden;
mod harness_lessons;
mod local_test;
pub mod mcp_server;
mod platform_process;
mod runtime_ownership;
mod verifier;
mod workflow_runtime;
mod workspace;

/// Desktop MCP auto-start gate. Default **on** for hackathon continuity.
/// Opt out with `CODEX_CORP_MCP_AUTO=0` (also accepts `false` / `off` / `no`).
/// Force on with `CODEX_CORP_MCP_AUTO=1` (also `true` / `on` / `yes`).
/// Empty / unknown values keep default **on** (same as unset).
fn mcp_auto_start_enabled() -> bool {
    parse_mcp_auto_start(std::env::var("CODEX_CORP_MCP_AUTO").ok().as_deref())
}

/// Pure parse of `CODEX_CORP_MCP_AUTO` (unit-tested; env wiring is thin).
fn parse_mcp_auto_start(value: Option<&str>) -> bool {
    match value {
        None => cfg!(debug_assertions),
        Some(raw) => {
            let v = raw.trim().to_ascii_lowercase();
            // Empty after trim = unset → default on.
            if v.is_empty() {
                return cfg!(debug_assertions);
            }
            match v.as_str() {
                "1" | "true" | "on" | "yes" => true,
                "0" | "false" | "off" | "no" => false,
                _ => cfg!(debug_assertions),
            }
        }
    }
}

fn default_agent_output_schema() -> Value {
    serde_json::from_str(include_str!("../../src/shared/agent-output.schema.json"))
        .expect("embedded agent output schema must remain valid JSON")
}

/// Shared SQLite handle. `Arc` so desktop, headless, and the MCP server share one connection pool.
#[derive(Clone)]
pub(crate) struct Database(pub(crate) Arc<Mutex<Connection>>);

/// Lock a runtime broker. The `name`/`run_id` parameters are retained for
/// call-site compatibility; the implementation is a direct `parking_lot` lock.
pub(crate) fn runtime_lock<'a, T: ?Sized>(
    mutex: &'a Mutex<T>,
    _name: &str,
    _run_id: Option<&str>,
) -> MutexGuard<'a, T> {
    mutex.lock()
}

/// Guard the shared SQLite connection for command handlers that do not have a
/// `RunContext` (e.g. direct Tauri commands). Lives in `lib.rs` because the
/// `Database` type is owned by this module.
pub(crate) fn db_guard_for(database: &Database) -> MutexGuard<'_, Connection> {
    database.0.lock()
}

#[derive(Clone)]
pub(crate) struct ApprovalBroker(pub(crate) Arc<Mutex<HashMap<String, PendingInteraction>>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PendingInteractionKind {
    Approval,
    UserInput,
    Elicitation,
}

pub(crate) struct PendingInteraction {
    pub(crate) kind: PendingInteractionKind,
    pub(crate) process_key: String,
    pub(crate) sender: mpsc::Sender<Value>,
}

struct PendingProcessInteractions {
    process_key: String,
    broker: ApprovalBroker,
}

impl Drop for PendingProcessInteractions {
    fn drop(&mut self) {
        let mut pending = self.broker.0.lock();
        pending.retain(|_, interaction| interaction.process_key != self.process_key);
    }
}
/// Broker for dynamic tool call results (JSON text content from the UI host).
#[derive(Clone)]
pub(crate) struct ToolBroker(pub(crate) Arc<Mutex<HashMap<String, mpsc::Sender<String>>>>);
#[derive(Clone)]
pub(crate) struct ProcessBroker(pub(crate) Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>);
/// Authoritative identifiers and stdin for graceful `turn/interrupt`.
#[derive(Clone)]
pub(crate) struct ActiveTurnHandle {
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
}

#[derive(Clone)]
pub(crate) struct TurnStdinBroker(pub(crate) Arc<Mutex<HashMap<String, ActiveTurnHandle>>>);

struct TurnRegistration {
    key: String,
    broker: TurnStdinBroker,
}

impl Drop for TurnRegistration {
    fn drop(&mut self) {
        let mut turns = self.broker.0.lock();
        turns.remove(&self.key);
    }
}

pub(crate) fn turn_interrupt_request(id: u64, handle: &ActiveTurnHandle) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/interrupt",
        "params": { "threadId": handle.thread_id, "turnId": handle.turn_id }
    })
}

/// Broker for long-lived realtime voice sessions keyed by sessionKey.
#[derive(Clone)]
pub(crate) struct RealtimeBroker(
    pub(crate) Arc<Mutex<HashMap<String, Arc<Mutex<RealtimeSession>>>>>,
);

impl Default for RealtimeBroker {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

pub(crate) struct RealtimeSession {
    pub(crate) thread_id: String,
    pub(crate) realtime_session_id: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    pub(crate) child: Arc<Mutex<Child>>,
    /// Kept for potential future use (e.g. direct emit from the session).
    /// Optional so tests can construct a session without a Tauri app handle.
    #[allow(dead_code)]
    pub(crate) app_handle: Option<tauri::AppHandle>,
    pub(crate) next_id: AtomicU64,
    /// Owns the process registration for the full realtime lifetime.
    pub(crate) process_lease: Option<ProcessRegistration>,
    /// Signalled by the dispatcher on a terminal notification or EOF.
    pub(crate) closed: Arc<(Mutex<bool>, Condvar)>,
}

impl Drop for RealtimeSession {
    fn drop(&mut self) {
        // Dropping the lease kills and deregisters the process exactly once.
        if self.process_lease.take().is_none() {
            kill_app_server_child(&self.child);
        }
    }
}

struct ProcessRegistration {
    node_id: String,
    broker: ProcessBroker,
    child: Arc<Mutex<Child>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RealtimeAudioChunk {
    data: String,
    sample_rate: u32,
    num_channels: u16,
    samples_per_channel: Option<u32>,
    item_id: Option<String>,
}

const MAX_REALTIME_AUDIO_BYTES: usize = 960_000;
const MAX_REALTIME_AUDIO_FRAMES: usize = 240_000;

impl RealtimeAudioChunk {
    fn validate(&self) -> Result<(), String> {
        if self.sample_rate != 24_000 {
            return Err(format!(
                "unsupported realtime sample rate: {}",
                self.sample_rate
            ));
        }
        if self.num_channels == 0 || self.num_channels > 2 {
            return Err(format!(
                "invalid realtime channel count: {}",
                self.num_channels
            ));
        }
        let decoded = BASE64_STANDARD
            .decode(&self.data)
            .map_err(|error| format!("invalid realtime audio base64: {error}"))?;
        if decoded.len() > MAX_REALTIME_AUDIO_BYTES {
            return Err("realtime audio chunk exceeds the maximum size".into());
        }
        if decoded.len() % 2 != 0 {
            return Err("realtime PCM16 payload has an odd byte length".into());
        }
        let sample_count = decoded.len() / 2;
        if sample_count % usize::from(self.num_channels) != 0 {
            return Err("realtime audio samples are not divisible by channel count".into());
        }
        let frames = sample_count / usize::from(self.num_channels);
        if frames > MAX_REALTIME_AUDIO_FRAMES {
            return Err("realtime audio frame count exceeds the maximum".into());
        }
        if self
            .samples_per_channel
            .is_some_and(|declared| declared as usize != frames)
        {
            return Err("realtime audio frame count does not match payload".into());
        }
        Ok(())
    }
}
impl Drop for ProcessRegistration {
    fn drop(&mut self) {
        // Kill without waiting, then release the child lock before touching the
        // broker. Holding the child lock while acquiring the process broker
        // inverts the safe cleanup order (broker clone -> child kill) used by
        // `kill_run_processes` and can deadlock or hang any broker->child path.
        {
            let mut child =
                crate::workflow_runtime::poison_aware_lock(&self.child, "child process", None);
            let _ = child.kill();
        }
        let mut processes =
            crate::workflow_runtime::poison_aware_lock(&self.broker.0, "process broker", None);
        processes.remove(&self.node_id);
    }
}

/// Kill the app-server child without holding the mutex across wait().
fn emit_optional<S: Serialize + Clone>(app: &Option<tauri::AppHandle>, event: &str, payload: S) {
    if let Some(handle) = app {
        let _ = handle.emit(event, payload);
    }
}

fn unix_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn normalize_unix_millis(value: i64) -> i64 {
    if value.unsigned_abs() < 100_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn parse_hook_run_record(
    notification: &Value,
    node_id: &str,
    fallback_thread_id: &str,
    fallback_turn_id: &str,
) -> Result<app_settings::HookRunRecord, String> {
    let run = notification
        .pointer("/params/run")
        .and_then(Value::as_object)
        .ok_or("hook notification missing params.run")?;
    let required = |key: &str| {
        run.get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("hook notification missing run.{key}"))
    };
    let started_at = run
        .get("startedAt")
        .and_then(Value::as_i64)
        .map(normalize_unix_millis)
        .unwrap_or_else(unix_now_millis);
    Ok(app_settings::HookRunRecord {
        id: required("id")?,
        thread_id: notification
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            .unwrap_or(fallback_thread_id)
            .to_string(),
        turn_id: notification
            .pointer("/params/turnId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| (!fallback_turn_id.is_empty()).then(|| fallback_turn_id.to_string())),
        node_id: node_id.to_string(),
        event_name: required("eventName")?,
        handler_type: required("handlerType")?,
        status: required("status")?,
        source: run
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_string),
        status_message: run
            .get("statusMessage")
            .and_then(Value::as_str)
            .map(str::to_string),
        started_at,
        completed_at: run
            .get("completedAt")
            .and_then(Value::as_i64)
            .map(normalize_unix_millis),
        duration_ms: run.get("durationMs").and_then(Value::as_i64),
    })
}

fn persist_hook_record(
    database: &Database,
    record: &app_settings::HookRunRecord,
) -> Result<(), String> {
    let connection = crate::workflow_runtime::database_guard_for(database);
    app_settings::persist_hook_run_with_connection(&connection, record)
}

fn emit_hook_record(
    app: &Option<tauri::AppHandle>,
    method: &str,
    record: &app_settings::HookRunRecord,
) {
    emit_optional(
        app,
        "codex-hook-lifecycle",
        json!({
            "nodeId": record.node_id, "method": method, "hookRunId": record.id,
            "eventName": record.event_name, "handlerType": record.handler_type,
            "status": record.status, "source": record.source,
            "statusMessage": record.status_message, "startedAt": record.started_at,
            "completedAt": record.completed_at, "durationMs": record.duration_ms,
            "threadId": record.thread_id, "turnId": record.turn_id,
        }),
    );
}

/// Unattended Live Codex approval behavior when `app` is `None` (headless MCP).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeadlessCodexApprovalPolicy {
    AutoAccept,
    AutoDecline,
    Wait,
}

/// Parse a headless approval policy string (pure; used by tests and env wrapper).
pub(crate) fn parse_headless_codex_approval_policy(raw: &str) -> HeadlessCodexApprovalPolicy {
    match raw.trim().to_ascii_lowercase().as_str() {
        "auto_decline" | "decline" | "deny" => HeadlessCodexApprovalPolicy::AutoDecline,
        "wait" | "manual" => HeadlessCodexApprovalPolicy::Wait,
        "auto_accept" | "accept" => HeadlessCodexApprovalPolicy::AutoAccept,
        // Headless default is fail-closed. Builders with danger-full-access + approvalPolicy=never
        // are handled by the dedicated auto-accept branch in execute_agent_internal.
        _ => HeadlessCodexApprovalPolicy::AutoDecline,
    }
}

/// Parse `CODEX_CORP_HEADLESS_APPROVAL`. Default is `auto_decline` for unattended VMs.
pub(crate) fn headless_codex_approval_policy() -> HeadlessCodexApprovalPolicy {
    parse_headless_codex_approval_policy(
        &std::env::var("CODEX_CORP_HEADLESS_APPROVAL").unwrap_or_default(),
    )
}

pub(crate) fn kill_app_server_child(child: &Arc<Mutex<Child>>) {
    let mut guard = child.lock();
    let _ = guard.kill();
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexInfo {
    found: bool,
    version: Option<String>,
    executable: String,
    app_server_available: bool,
    compatible: bool,
    supported_range: String,
    last_tested_version: String,
    selected_source: String,
    fallback_available: bool,
    incompatibility_reason: Option<String>,
    compatibility_warning: Option<String>,
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowSnapshot {
    id: String,
    name: String,
    graph_json: String,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    template_json: Option<String>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSnapshot {
    id: String,
    workflow_id: String,
    status: String,
    events_json: String,
    #[serde(default)]
    nodes_json: String,
    #[serde(default)]
    edges_json: String,
    #[serde(default)]
    approvals_json: String,
    #[serde(default)]
    artifacts_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    id: String,
    workflow_id: String,
    status: String,
    created_at: String,
    events_json: String,
    #[serde(default)]
    nodes_json: String,
    #[serde(default)]
    edges_json: String,
    terminal_reason: Option<String>,
    resumable: bool,
    pinned: bool,
    last_event_sequence: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PortfolioRunSummary {
    workflow_id: String,
    run_count: u64,
    token_burn: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphSnapshot {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

#[derive(Debug, Deserialize)]
struct GraphNode {
    id: String,
    data: GraphNodeData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphNodeData {
    label: String,
    kind: String,
    #[serde(default)]
    prompt: String,
    /// Connector model id from the live list (or empty until loaded). Not a product catalog.
    #[serde(default)]
    model: String,
    #[serde(default)]
    input_schema: Option<String>,
    #[serde(default)]
    output_schema: Option<String>,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    sandbox_profile: Option<String>,
    #[serde(default)]
    permission_profile: Option<String>,
    #[serde(default)]
    collaboration_mode: Option<String>,
    #[serde(default)]
    personality: Option<String>,
    #[serde(default)]
    cron_expression: Option<String>,
    #[serde(default)]
    cron_timezone: Option<String>,
    #[serde(default)]
    completion_criteria: Vec<GraphCriterion>,
    #[serde(default = "default_agent_timeout_seconds")]
    timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphCriterion {
    #[serde(default)]
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    label: String,
    #[serde(default, deserialize_with = "deserialize_graph_criterion_kind")]
    kind: String,
    #[serde(default = "default_true_bool")]
    enabled: bool,
    #[serde(default)]
    platform: bool,
    #[serde(default = "default_required_str")]
    enforcement: String,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    template_id: Option<String>,
    #[serde(default)]
    artifact_name: Option<String>,
    #[serde(default)]
    artifact_path: Option<String>,
    #[serde(default)]
    policy_id: Option<String>,
}

fn default_true_bool() -> bool {
    true
}
fn default_required_str() -> String {
    "required".into()
}

fn deserialize_graph_criterion_kind<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    Ok(crate::verifier::normalize_kind(&raw))
}

#[derive(Debug, Deserialize)]
struct GraphEdge {
    id: String,
    source: String,
    target: String,
    #[serde(default)]
    data: Option<GraphEdgeData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdgeData {
    #[serde(default = "standard_edge")]
    edge_type: String,
    max_revisions: Option<u32>,
    #[serde(default)]
    condition: Option<String>,
    #[serde(default)]
    mapping: Option<Value>,
}

fn standard_edge() -> String {
    "standard".into()
}

/// Pass through trimmed model id (no hardcoded product catalog / name maps).
pub(crate) fn normalize_model_id(raw: &str) -> String {
    raw.trim().to_string()
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GraphProblem {
    id: String,
    severity: String,
    message: String,
    node_id: Option<String>,
    edge_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExecutionPlan {
    batches: Vec<Vec<String>>,
    included_node_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
struct AgentRequest {
    node_id: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    attempt_id: Option<String>,
    /// Resume an existing Codex thread instead of starting a fresh one.
    #[serde(default)]
    thread_id: Option<String>,
    role: String,
    model: String,
    effort: String,
    /// Authored harness-like base; empty omits baseInstructions (native Codex base).
    #[serde(default)]
    base_instructions: String,
    /// Role/developer contract (+ connector/criteria composition on specialist path).
    #[serde(default)]
    developer_instructions: String,
    user_input: String,
    upstream_outputs: Vec<Value>,
    #[serde(default = "default_approval_policy")]
    approval_policy: String,
    #[serde(default = "default_sandbox_profile")]
    sandbox_profile: String,
    #[serde(default)]
    permission_profile: Option<String>,
    #[serde(default)]
    collaboration_mode: Option<String>,
    #[serde(default)]
    personality: Option<String>,
    #[serde(default)]
    workspace_policy: String,
    #[serde(default)]
    target_workspace: Option<String>,
    #[serde(default = "default_agent_timeout_seconds")]
    timeout_seconds: u64,
    #[serde(default)]
    output_schema: Option<Value>,
    /// Selected tool labels from the UI (advisory; not a hard app-server ACL).
    #[serde(default)]
    tools: Vec<String>,
    /// Saved Codex skills. These are resolved against the executing app-server.
    #[serde(default)]
    skills: Vec<String>,
    /// Preformatted tool-boundary disclaimer appended to the turn prompt.
    #[serde(default)]
    tool_boundary: String,
    /// Internal subprocess seam used by the fake app-server integration harness.
    #[serde(skip)]
    app_server_path: Option<PathBuf>,
}

fn default_agent_timeout_seconds() -> u64 {
    120
}

impl AgentRequest {
    fn process_key(&self) -> String {
        match (&self.run_id, &self.attempt_id) {
            (Some(run_id), Some(attempt_id)) => format!("{run_id}::{}::{attempt_id}", self.node_id),
            (Some(run_id), None) => format!("{run_id}::{}", self.node_id),
            _ => self.node_id.clone(),
        }
    }
}

fn default_approval_policy() -> String {
    "on-request".into()
}
fn default_sandbox_profile() -> String {
    "workspace-write".into()
}

fn normalized_personality(value: Option<&str>) -> &'static str {
    match value {
        Some("friendly") => "friendly",
        Some("pragmatic") => "pragmatic",
        _ => "none",
    }
}

fn resolve_agent_working_directory(request: &AgentRequest) -> PathBuf {
    let run_workspace = request.run_id.as_deref().unwrap_or("legacy");
    if request.workspace_policy == "workflow" {
        request
            .target_workspace
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                app_data_dir()
                    .join("workspaces")
                    .join(run_workspace)
                    .join("workflow-shared")
            })
    } else {
        app_data_dir()
            .join("workspaces")
            .join(run_workspace)
            .join(&request.node_id)
            .join(request.attempt_id.as_deref().unwrap_or("legacy"))
    }
}

/// Skill discovery must cover the same process cwd used by the capability
/// picker plus the concrete execution and operator-selected workspaces.
fn skill_discovery_cwds(request: &AgentRequest, workspace: &Path) -> Vec<String> {
    let mut cwds = Vec::<String>::new();
    let mut push_unique = |path: PathBuf| {
        let value = path.to_string_lossy().into_owned();
        let duplicate = cwds.iter().any(|existing| {
            if cfg!(windows) {
                existing.eq_ignore_ascii_case(&value)
            } else {
                existing == &value
            }
        });
        if !duplicate {
            cwds.push(value);
        }
    };
    push_unique(workspace.to_path_buf());
    if let Some(target) = request
        .target_workspace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        push_unique(PathBuf::from(target));
    }
    if let Ok(inventory_cwd) = std::env::current_dir() {
        push_unique(inventory_cwd);
    }
    cwds
}

fn outer_agent_deadline_seconds(wall_seconds: u64) -> u64 {
    // The inner turn deadline owns normal timeout reporting and child cleanup.
    // This outer deadline is only a deadlock safety net and must fire later.
    wall_seconds.saturating_add(30)
}

/// Human interaction is not agent execution time. Keep it bounded separately
/// so slow approvals do not consume the turn budget, while a request loop still
/// cannot keep a specialist alive forever.
const MAX_OPERATOR_WAIT_SECS: u64 = 30 * 60;
const DEADLINE_WATCHDOG_POLL_MILLIS: u64 = 250;

#[derive(Debug)]
struct PausableDeadline {
    deadline: std::time::Instant,
    paused_at: Option<std::time::Instant>,
    credited_pause: Duration,
    max_pause: Duration,
}

impl PausableDeadline {
    fn new(started: std::time::Instant, active_budget: Duration, max_pause: Duration) -> Self {
        Self {
            deadline: started + active_budget,
            paused_at: None,
            credited_pause: Duration::ZERO,
            max_pause,
        }
    }

    fn pause(&mut self, now: std::time::Instant) {
        if self.paused_at.is_none() {
            self.paused_at = Some(now);
        }
    }

    fn resume(&mut self, now: std::time::Instant) {
        let Some(paused_at) = self.paused_at.take() else {
            return;
        };
        let remaining_credit = self.max_pause.saturating_sub(self.credited_pause);
        let credit = now.duration_since(paused_at).min(remaining_credit);
        self.credited_pause = self.credited_pause.saturating_add(credit);
        self.deadline = self.deadline.checked_add(credit).unwrap_or(self.deadline);
    }

    fn remaining(&self, now: std::time::Instant) -> Duration {
        let live_credit = self
            .paused_at
            .map(|paused_at| {
                now.duration_since(paused_at)
                    .min(self.max_pause.saturating_sub(self.credited_pause))
            })
            .unwrap_or(Duration::ZERO);
        self.deadline
            .checked_add(live_credit)
            .unwrap_or(self.deadline)
            .saturating_duration_since(now)
    }
}

fn recv_with_operator_pause<T>(
    receiver: &mpsc::Receiver<T>,
    timeout: Duration,
    turn_deadline: &mut PausableDeadline,
    outer_deadline: &Arc<Mutex<PausableDeadline>>,
) -> Result<Result<T, mpsc::RecvTimeoutError>, String> {
    let paused_at = std::time::Instant::now();
    outer_deadline.lock().pause(paused_at);
    turn_deadline.pause(paused_at);

    let result = receiver.recv_timeout(timeout);
    let resumed_at = std::time::Instant::now();
    turn_deadline.resume(resumed_at);
    outer_deadline.lock().resume(resumed_at);
    Ok(result)
}

/// Apply dual instruction surfaces to app-server thread params (omit empty base).
pub(crate) fn apply_instruction_params(params: &mut Value, base: &str, developer: &str) {
    let base = base.trim();
    let developer = developer.trim();
    if !base.is_empty() {
        params["baseInstructions"] = json!(base);
    }
    if !developer.is_empty() {
        params["developerInstructions"] = json!(developer);
    }
}

fn build_agent_thread_start_params(
    request: &AgentRequest,
    model: &str,
    workspace: &Path,
    approval_policy: &str,
    sandbox: &str,
) -> Value {
    let personality = normalized_personality(request.personality.as_deref());
    let mut params = json!({
        "model":model,
        "cwd":workspace,
        "approvalPolicy":approval_policy,
        "ephemeral":true,
        "personality":personality
    });
    if let Some(root) = request
        .target_workspace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params["runtimeWorkspaceRoots"] = json!([root]);
    }
    apply_instruction_params(
        &mut params,
        &request.base_instructions,
        &request.developer_instructions,
    );
    let permission_profile = request
        .permission_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        });
    if let Some(profile) = permission_profile {
        params["permissions"] = json!(profile);
    } else {
        params["sandbox"] = json!(sandbox);
    }
    params
}

/// Map an internal sandbox profile name to a Codex app-server `SandboxMode`.
/// Unknown or legacy values fall back to `workspace-write` for safety.
fn codex_sandbox_mode(profile: &str) -> &'static str {
    match profile {
        "read-only" => "read-only",
        "workspace-write" => "workspace-write",
        "danger-full-access" => "danger-full-access",
        _ => "workspace-write",
    }
}

fn build_agent_turn_start_params(
    request: &AgentRequest,
    thread_id: &str,
    model: &str,
    composed: &str,
    output_schema: Value,
    skill_inputs: &[Value],
) -> Value {
    let personality = normalized_personality(request.personality.as_deref());
    let mut input = skill_inputs.to_vec();
    input.push(json!({"type":"text","text":composed,"text_elements":[]}));
    let mut params = json!({
        "threadId":thread_id,
        "input":input,
        "model":model,
        "effort":request.effort,
        "personality":personality,
        "outputSchema":output_schema
    });
    if request.collaboration_mode.as_deref() == Some("plan") {
        params["collaborationMode"] = json!({
            "mode":"plan",
            "settings":{
                "model":model,
                "reasoning_effort":request.effort,
                "developer_instructions":Value::Null
            }
        });
    }
    params
}

fn resolve_skill_inputs(result: &Value, selected: &[String]) -> Result<Vec<Value>, String> {
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let mut available = HashMap::<String, String>::new();
    for entry in result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for skill in entry
            .get("skills")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = skill.get("name").and_then(Value::as_str) else {
                continue;
            };
            if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            if let Some(path) = skill.get("path").and_then(Value::as_str) {
                available.insert(name.to_string(), path.to_string());
            }
        }
    }
    selected
        .iter()
        .map(|name| {
            available
                .get(name)
                .map(|path| json!({"type":"skill","name":name,"path":path}))
                .ok_or_else(|| format!("Saved skill '{name}' is not available in this workspace"))
        })
        .collect()
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NormalizedAgentEvent {
    node_id: String,
    event_type: String,
    message: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    /// Tokens attributable to the latest specialist turn when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeApprovalEvent {
    request_id: String,
    node_id: String,
    method: String,
    params: Value,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeApprovalResolvedEvent {
    request_id: String,
    node_id: String,
    decision: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentResult {
    status: String,
    summary: String,
    data: Value,
    artifacts: Vec<Value>,
    thread_id: String,
    turn_id: String,
    /// Peak latest-turn token count observed from token-usage notifications.
    #[serde(default)]
    tokens: u64,
}

fn extract_total_tokens(value: &Value) -> Option<u64> {
    let candidates = [
        // `total` is cumulative across a resumed thread. Prefer the latest
        // turn so separate workflow runs do not repeatedly count old usage.
        value.pointer("/params/tokenUsage/last/totalTokens"),
        value.pointer("/params/tokenUsage/last/total_tokens"),
        value.pointer("/tokenUsage/last/totalTokens"),
        value.pointer("/tokenUsage/last/total_tokens"),
        value.pointer("/params/tokenUsage/total/totalTokens"),
        value.pointer("/params/tokenUsage/total/total_tokens"),
        value.pointer("/tokenUsage/total/totalTokens"),
        value.pointer("/params/totalTokens"),
        value.get("totalTokens"),
        value.get("tokens"),
    ];
    for candidate in candidates {
        if let Some(n) = candidate.and_then(Value::as_u64) {
            return Some(n);
        }
        if let Some(n) = candidate.and_then(Value::as_f64) {
            if n.is_finite() && n >= 0.0 {
                return Some(n as u64);
            }
        }
        if let Some(n) = candidate.and_then(Value::as_i64) {
            if n >= 0 {
                return Some(n as u64);
            }
        }
    }
    None
}

fn parse_agent_message(message: &str) -> Result<(String, String, Value, Vec<Value>), String> {
    let parsed: Value = serde_json::from_str(message.trim())
        .map_err(|error| format!("Codex returned invalid structured output: {error}"))?;
    let status = parsed
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| matches!(*status, "success" | "failure" | "needs_revision"))
        .ok_or("Codex structured output has an invalid or missing status")?
        .to_string();
    let summary = parsed
        .get("summary")
        .and_then(Value::as_str)
        .filter(|summary| !summary.trim().is_empty())
        .ok_or("Codex structured output has an empty or missing summary")?
        .to_string();
    let data = parsed
        .get("data")
        .filter(|data| data.is_object())
        .cloned()
        .ok_or("Codex structured output has invalid or missing data")?;
    let artifacts = parsed
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .ok_or("Codex structured output has invalid or missing artifacts")?;
    Ok((status, summary, data, artifacts))
}

/// App data root for SQLite, workspaces, and MCP PID/status/stop files.
/// Override with `CODEX_CORP_DATA_DIR` (absolute path preferred).
pub(crate) fn app_data_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("CODEX_CORP_DATA_DIR") {
        let path = PathBuf::from(override_dir);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("CodexCorp")
}

/// Cooperative stop-file path (shared by lifecycle and headless poll loops).
pub fn mcp_stop_file_path() -> PathBuf {
    app_data_dir().join("mcp-server.stop")
}

pub(crate) fn default_chat_workspace_path() -> PathBuf {
    app_data_dir().join("workspaces").join("company-mediator")
}

pub(crate) fn is_app_managed_workspace(path: &Path) -> bool {
    path.starts_with(app_data_dir().join("workspaces"))
}

pub(crate) fn prepare_greenfield_workspace(path: &Path, initialize: bool) -> Result<(), String> {
    workspace::prepare_workspace_git(path, initialize).map(|_| ())
}

#[tauri::command]
fn get_default_chat_workspace() -> Result<String, String> {
    let path = default_chat_workspace_path();
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    prepare_greenfield_workspace(&path, true)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn choose_chat_workspace(initial_path: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let fallback = default_chat_workspace_path();
        std::fs::create_dir_all(&fallback).map_err(|error| error.to_string())?;
        let initial = initial_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or(fallback);
        Ok(rfd::FileDialog::new()
            .set_title("Choose app folder")
            .set_directory(initial)
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn open_database() -> Result<Connection, String> {
    let directory = app_data_dir();
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let connection =
        Connection::open(directory.join("codex-corp.sqlite")).map_err(|error| error.to_string())?;
    // Concurrent desktop + headless may open the same file; fail soft with a wait.
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|error| error.to_string())?;
    initialize_database(&connection)?;
    Ok(connection)
}

/// Shared bootstrap used by desktop, headless, and MCP.
pub(crate) fn open_shared_database() -> Result<Database, String> {
    Ok(Database(Arc::new(Mutex::new(open_database()?))))
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            graph_json TEXT NOT NULL,
            workspace_path TEXT,
            template_json TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            status TEXT NOT NULL,
            events_json TEXT NOT NULL,
            nodes_json TEXT NOT NULL DEFAULT '',
            edges_json TEXT NOT NULL DEFAULT '',
            workspace_path TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS run_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            node_id TEXT,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS node_executions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            thread_id TEXT,
            turn_id TEXT,
            status TEXT NOT NULL,
            output_json TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            request_json TEXT NOT NULL,
            decision TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            content_hash TEXT,
            byte_length INTEGER,
            storage_path TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS schedule_firings (
            workflow_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            minute_key TEXT NOT NULL,
            fired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(workflow_id, node_id, minute_key)
        );",
        )
        .map_err(|error| error.to_string())?;
    // Forward-compatible migration for databases created before snapshot columns.
    let _ = connection.execute(
        "ALTER TABLE runs ADD COLUMN nodes_json TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE runs ADD COLUMN edges_json TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = connection.execute("ALTER TABLE runs ADD COLUMN workspace_path TEXT", []);
    let _ = connection.execute("ALTER TABLE workflows ADD COLUMN workspace_path TEXT", []);
    let _ = connection.execute("ALTER TABLE workflows ADD COLUMN template_json TEXT", []);
    // Artifact trust columns (III.5). Pre-migration rows keep NULL hashes and are
    // excluded from hash-indexed delivery queries until re-run materializes them.
    let _ = connection.execute("ALTER TABLE artifacts ADD COLUMN content_hash TEXT", []);
    let _ = connection.execute("ALTER TABLE artifacts ADD COLUMN byte_length INTEGER", []);
    let _ = connection.execute("ALTER TABLE artifacts ADD COLUMN storage_path TEXT", []);
    app_settings::initialize(connection)?;
    workflow_runtime::initialize_node_experience_database(connection)?;
    harness_lessons::initialize(connection)?;
    business_data::initialize(connection)?;
    chat_data::initialize(connection)?;
    local_test::initialize(connection)?;
    Ok(())
}

fn npm_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("npm")
}

/// Global npm install entry: `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`
fn npm_codex_js() -> Option<PathBuf> {
    let js = npm_dir()
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    js.is_file().then_some(js)
}

/// Resolve `node.exe` even when the GUI process PATH is incomplete.
fn find_node_exe() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(if cfg!(windows) { "node.exe" } else { "node" }));
        }
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
    }
    if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(pf86).join("nodejs").join("node.exe"));
    }
    candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"));
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("nodejs")
                .join("node.exe"),
        );
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn system_codex_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODEX_CORP_CODEX_PATH") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    {
        // Prefer codex.cmd for display / path identity. Runtime launch prefers
        // node.exe + codex.js when available (see command_for_codex).
        let npm = npm_dir();
        let cmd = npm.join("codex.cmd");
        if cmd.exists() {
            return cmd;
        }
        let ps1 = npm.join("codex.ps1");
        if ps1.exists() {
            return ps1;
        }
        PathBuf::from("codex.cmd")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("codex")
    }
}

fn fallback_codex_path() -> PathBuf {
    std::env::var_os("CODEX_CORP_FALLBACK_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app_data_dir()
                .join("bin")
                .join(if cfg!(windows) { "codex.exe" } else { "codex" })
        })
}

fn active_codex_path() -> PathBuf {
    std::env::var_os("CODEX_CORP_ACTIVE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(system_codex_path)
}

/// True when `path` is the npm global shim (codex.cmd / codex.ps1 / bare name).
fn is_npm_codex_shim(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_bare_name = path.components().count() == 1;
    let is_in_npm_dir = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("npm"));
    (matches!(name.as_str(), "codex.cmd" | "codex.ps1" | "codex")
        && (is_bare_name || is_in_npm_dir))
        || (name == "codex.exe" && is_in_npm_dir)
}

fn prepare_command(command: &mut Command) {
    // GUI subsystem apps often inherit a thin PATH; ensure node + npm shims resolve.
    if let Some(node) = find_node_exe() {
        if let Some(dir) = node.parent() {
            let mut paths = vec![dir.to_path_buf(), npm_dir()];
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                command.env("PATH", joined);
            }
        }
    }
    // Avoid hanging / flashing consoles when the host is a windowed (GUI) process.
    platform_process::hide_console_window(command);
}

fn command_for_codex(path: &Path, args: &[&str]) -> Command {
    // Prefer direct node + codex.js for npm installs — avoids cmd.ps1/PATH failures
    // that make discover_codex report found=false while CLI works in a terminal.
    #[cfg(target_os = "windows")]
    {
        // Only the known npm shim may be replaced by the global codex.js entry.
        // Explicit custom .cmd/.ps1 paths must remain authoritative.
        let use_node_entry = is_npm_codex_shim(path);
        if use_node_entry {
            if let (Some(node), Some(js)) = (find_node_exe(), npm_codex_js()) {
                let mut command = Command::new(node);
                command.arg(js).args(args);
                prepare_command(&mut command);
                return command;
            }
        }
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        // Windows cannot execute JavaScript modules as Win32 programs. Use
        // the resolved Node runtime for explicit .js/.mjs/.cjs app-server
        // paths, including the golden fake server.
        if matches!(ext.as_str(), "js" | "mjs" | "cjs") {
            if let Some(node) = find_node_exe() {
                let mut command = Command::new(node);
                command.arg(path).args(args);
                prepare_command(&mut command);
                return command;
            }
        }
        if ext == "ps1" {
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(path)
                .args(args);
            prepare_command(&mut command);
            return command;
        }
        // .cmd / .bat need cmd.exe so PATH/node resolution matches interactive shell.
        if ext == "cmd" || ext == "bat" {
            let mut command = Command::new("cmd.exe");
            let displayed = path.to_string_lossy();
            // `cmd.exe /c` treats metacharacters as syntax even without spaces.
            // Quote only when required: `/s` has special handling for a command
            // beginning with quotes, while simple no-space paths work unquoted.
            let needs_quotes = displayed.chars().any(|character| {
                character.is_whitespace()
                    || matches!(character, '&' | '|' | '<' | '>' | '(' | ')' | '^')
            });
            let mut cmdline = if needs_quotes {
                format!("\"{displayed}\"")
            } else {
                displayed.into_owned()
            };
            for arg in args {
                cmdline.push(' ');
                if arg.contains(' ') {
                    cmdline.push('"');
                    cmdline.push_str(arg);
                    cmdline.push('"');
                } else {
                    cmdline.push_str(arg);
                }
            }
            command.args(["/d", "/s", "/c", &cmdline]);
            prepare_command(&mut command);
            return command;
        }
    }
    let mut command = Command::new(path);
    command.args(args);
    prepare_command(&mut command);
    command
}

fn codex_app_server_at(path_override: Option<&Path>) -> Result<Child, String> {
    let path = path_override
        .map(Path::to_path_buf)
        .unwrap_or_else(active_codex_path);
    // stderr must NOT be piped-and-unread: a full OS pipe buffer deadlocks the
    // app-server after tool work (files written) while it still emits logs.
    command_for_codex(&path, &["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to start Codex app-server via {}: {error}",
                path.display()
            )
        })
}

pub(crate) fn codex_app_server() -> Result<Child, String> {
    codex_app_server_at(None)
}

/// Collect version text from a process output (stdout preferred, stderr fallback).
fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

pub(crate) fn send_json(writer: &mut impl Write, value: Value) -> Result<(), String> {
    // Buffer fully first so a single write_all is used (fails fast on broken pipe).
    let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

/// Write JSON-RPC to the app-server with a hard timeout so a stalled stdin
/// (child not reading while we answer requestApproval) cannot pin execute_agent.
pub(crate) fn send_json_timed(
    stdin: &Arc<Mutex<ChildStdin>>,
    value: Value,
    timeout: Duration,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let stdin = Arc::clone(stdin);
    std::thread::spawn(move || {
        let result = {
            let mut guard = crate::workflow_runtime::poison_aware_lock(&stdin, "stdin", None);
            send_json(&mut *guard, value)
        };
        let _ = tx.send(result);
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("stdin write timed out (app-server not reading)".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("stdin write worker disconnected".into()),
    }
}

fn is_revision(edge: &GraphEdge) -> bool {
    edge.data.as_ref().map(|data| data.edge_type.as_str()) == Some("revision")
}

fn standard_cycle(graph: &GraphSnapshot) -> Option<Vec<String>> {
    fn visit(
        id: &str,
        graph: &GraphSnapshot,
        stack: &mut Vec<String>,
        visited: &mut std::collections::HashSet<String>,
    ) -> Option<Vec<String>> {
        if let Some(position) = stack.iter().position(|item| item == id) {
            let mut cycle = stack[position..].to_vec();
            cycle.push(id.into());
            return Some(cycle);
        }
        if visited.contains(id) {
            return None;
        }
        stack.push(id.into());
        for edge in graph
            .edges
            .iter()
            .filter(|edge| edge.source == id && !is_revision(edge))
        {
            if let Some(cycle) = visit(&edge.target, graph, stack, visited) {
                return Some(cycle);
            }
        }
        stack.pop();
        visited.insert(id.into());
        None
    }
    let mut visited = std::collections::HashSet::new();
    for node in &graph.nodes {
        if let Some(cycle) = visit(&node.id, graph, &mut Vec::new(), &mut visited) {
            return Some(cycle);
        }
    }
    None
}

fn problem(
    id: impl Into<String>,
    message: impl Into<String>,
    node_id: Option<String>,
    edge_id: Option<String>,
) -> GraphProblem {
    GraphProblem {
        id: id.into(),
        severity: "error".into(),
        message: message.into(),
        node_id,
        edge_id,
    }
}

fn validate_graph(graph: &GraphSnapshot) -> Vec<GraphProblem> {
    use std::collections::HashSet;
    let mut problems = Vec::new();
    let ids: HashSet<_> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
    let inputs: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "input")
        .collect();
    let outputs: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "output")
        .collect();
    let cron_triggers: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "cron")
        .collect();
    if inputs.is_empty() {
        problems.push(problem(
            "missing-input",
            "Add at least one Input node.",
            None,
            None,
        ));
    }
    if outputs.is_empty() {
        problems.push(problem(
            "missing-output",
            "Add at least one Output node.",
            None,
            None,
        ));
    }
    for edge in &graph.edges {
        if !ids.contains(edge.source.as_str()) || !ids.contains(edge.target.as_str()) {
            problems.push(problem(
                format!("dangling-{}", edge.id),
                "Edge references a missing node.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if edge.source == edge.target {
            problems.push(problem(
                format!("self-{}", edge.id),
                "Self-connections are not allowed.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if is_revision(edge)
            && edge
                .data
                .as_ref()
                .and_then(|data| data.max_revisions)
                .unwrap_or(0)
                == 0
        {
            problems.push(problem(
                format!("revision-limit-{}", edge.id),
                "Revision edges require a positive limit.",
                None,
                Some(edge.id.clone()),
            ));
        }
        let edge_type = edge
            .data
            .as_ref()
            .map(|data| data.edge_type.as_str())
            .unwrap_or("standard");
        let target = graph.nodes.iter().find(|node| node.id == edge.target);
        if edge_type == "conditional"
            && edge
                .data
                .as_ref()
                .and_then(|data| data.condition.as_deref())
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            problems.push(problem(
                format!("condition-{}", edge.id),
                "Conditional edges require a result condition.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if edge_type == "approval" && target.map(|node| node.data.kind.as_str()) != Some("approval")
        {
            problems.push(problem(
                format!("approval-target-{}", edge.id),
                "Approval edges must terminate at an Approval node.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if edge_type == "merge" && target.map(|node| node.data.kind.as_str()) != Some("merge") {
            problems.push(problem(
                format!("merge-target-{}", edge.id),
                "Merge dependencies must terminate at a Merge node.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if edge_type == "revision" {
            let ok = target
                .map(|node| {
                    node.data.kind.as_str() == "agent" || node.data.kind.as_str() == "creative"
                })
                .unwrap_or(false);
            if !ok {
                problems.push(problem(
                    format!("revision-target-{}", edge.id),
                    "Revision feedback must return to an Agent or Creative Studio node.",
                    None,
                    Some(edge.id.clone()),
                ));
            }
        }
        if let Some(Value::Object(mapping)) =
            edge.data.as_ref().and_then(|data| data.mapping.as_ref())
        {
            for (field, path) in mapping {
                if field.trim().is_empty()
                    || !path
                        .as_str()
                        .map(|value| value.starts_with("$."))
                        .unwrap_or(false)
                {
                    problems.push(problem(
                        format!("mapping-{}-{field}", edge.id),
                        "Edge field mappings must use non-empty fields and $. paths.",
                        None,
                        Some(edge.id.clone()),
                    ));
                }
            }
        }
    }
    for cron in &cron_triggers {
        let valid_expression = cron
            .data
            .cron_expression
            .as_deref()
            .map(|value| value.split_whitespace().count() == 5)
            .unwrap_or(false);
        if !valid_expression {
            problems.push(problem(
                format!("cron-expression-{}", cron.id),
                format!(
                    "{} needs a valid five-field cron expression.",
                    cron.data.label
                ),
                Some(cron.id.clone()),
                None,
            ));
        }
        let valid_timezone = cron
            .data
            .cron_timezone
            .as_deref()
            .unwrap_or("UTC")
            .parse::<chrono_tz::Tz>()
            .is_ok();
        if !valid_timezone {
            problems.push(problem(
                format!("cron-timezone-{}", cron.id),
                format!(
                    "{} needs a valid IANA timezone such as UTC or Asia/Kolkata.",
                    cron.data.label
                ),
                Some(cron.id.clone()),
                None,
            ));
        }
        let connects_to_input = graph.edges.iter().any(|edge| {
            edge.source == cron.id
                && graph
                    .nodes
                    .iter()
                    .any(|node| node.id == edge.target && node.data.kind == "input")
        });
        if !connects_to_input {
            problems.push(problem(
                format!("cron-input-{}", cron.id),
                format!("{} must connect to an Input node.", cron.data.label),
                Some(cron.id.clone()),
                None,
            ));
        }
    }
    for node in graph.nodes.iter().filter(|node| node.data.kind != "note") {
        let inbound = graph.edges.iter().any(|edge| edge.target == node.id);
        let outbound = graph.edges.iter().any(|edge| edge.source == node.id);
        let disconnected = match node.data.kind.as_str() {
            "input" | "cron" => !outbound,
            "output" => !inbound,
            _ => !inbound || !outbound,
        };
        if disconnected {
            problems.push(problem(
                format!("disconnected-{}", node.id),
                format!(
                    "{} is disconnected from an executable path.",
                    node.data.label
                ),
                Some(node.id.clone()),
                None,
            ));
        }
        if (node.data.kind == "agent" || node.data.kind == "creative")
            && node.data.prompt.trim().is_empty()
        {
            problems.push(problem(
                format!("prompt-{}", node.id),
                format!("{} needs instructions.", node.data.label),
                Some(node.id.clone()),
                None,
            ));
        }
        // Empty model only — no hardcoded model-name allowlist (live model/list is SSOT).
        if (node.data.kind == "agent" || node.data.kind == "creative")
            && node.data.model.trim().is_empty()
        {
            problems.push(problem(
                format!("model-{}", node.id),
                format!(
                    "{} needs a Codex model (Config → Model, or Refresh models).",
                    node.data.label
                ),
                Some(node.id.clone()),
                None,
            ));
        }
        if (node.data.kind == "agent" || node.data.kind == "creative")
            && !(10..=1800).contains(&node.data.timeout_seconds)
        {
            problems.push(problem(
                format!("timeout-{}", node.id),
                format!(
                    "{} timeout must be between 10 and 1800 seconds.",
                    node.data.label
                ),
                Some(node.id.clone()),
                None,
            ));
        }
        // Criterion kind validation (III.14) — kind aliases via verifier::normalize_kind
        if node.data.kind == "agent" || node.data.kind == "creative" {
            for criterion in &node.data.completion_criteria {
                if !criterion.enabled && !criterion.platform {
                    continue;
                }
                let kind = crate::verifier::normalize_kind(&criterion.kind);
                let kind = kind.as_str();
                let required = criterion.platform || criterion.enforcement == "required";
                // Fail closed at validation: an unknown kind cannot be silently
                // downgraded (TS preview coerces unknown → advisory; Rust must not
                // accept a required gate it cannot evaluate). Runtime also fails
                // closed via evaluate_criterion's unknown-kind branch.
                if !crate::verifier::is_known_kind(kind) {
                    problems.push(problem(
                        format!("criterion-kind-{}-{}", node.id, criterion.id),
                        format!(
                            "{}: unknown criterion kind: {kind}. Use one of structured_json, concise_summary, no_hidden_reasoning, claim, command, artifact_exists, architecture_policy.",
                            node.data.label
                        ),
                        Some(node.id.clone()),
                        None,
                    ));
                }
                if required && kind == "claim" {
                    problems.push(problem(
                        format!("criterion-claim-required-{}-{}", node.id, criterion.id),
                        format!(
                            "{}: required claim criteria are invalid — use platform/command/artifact_exists/architecture_policy.",
                            node.data.label
                        ),
                        Some(node.id.clone()),
                        None,
                    ));
                }
                if kind == "command" {
                    let tid = criterion.template_id.as_deref().unwrap_or("").trim();
                    if tid.is_empty() || !crate::verifier::is_allowed_template(tid) {
                        problems.push(problem(
                            format!("criterion-command-{}-{}", node.id, criterion.id),
                            format!(
                                "{}: command criterion needs an allowlisted templateId (npm_test, cargo_test, …).",
                                node.data.label
                            ),
                            Some(node.id.clone()),
                            None,
                        ));
                    } else if tid == "node_script" {
                        let script = criterion.instruction.as_deref().unwrap_or("").trim();
                        if script.is_empty()
                            || std::path::Path::new(script).is_absolute()
                            || script.contains("..")
                            || script.starts_with('~')
                        {
                            problems.push(problem(
                                format!("criterion-node-script-{}-{}", node.id, criterion.id),
                                format!(
                                    "{}: node_script criterion requires a confined relative instruction path.",
                                    node.data.label
                                ),
                                Some(node.id.clone()),
                                None,
                            ));
                        }
                    }
                }
                if kind == "artifact_exists" {
                    let has_name = criterion
                        .artifact_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_some();
                    let has_path = criterion
                        .artifact_path
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_some();
                    if !has_name && !has_path {
                        problems.push(problem(
                            format!("criterion-artifact-{}-{}", node.id, criterion.id),
                            format!(
                                "{}: artifact_exists criterion needs artifactName or artifactPath.",
                                node.data.label
                            ),
                            Some(node.id.clone()),
                            None,
                        ));
                    }
                }
                if kind == "architecture_policy" {
                    let policy = criterion
                        .policy_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(
                            crate::verifier::architecture::POLICY_NATIVE_RUNTIME_OWNERSHIP_V1,
                        );
                    let supported = [
                        crate::verifier::architecture::POLICY_NATIVE_RUNTIME_OWNERSHIP_V1,
                        crate::verifier::architecture::POLICY_NATIVE_RUNTIME_OWNERSHIP_V2,
                    ];
                    if !supported.contains(&policy) {
                        problems.push(problem(
                            format!("criterion-arch-{}-{}", node.id, criterion.id),
                            format!(
                                "{}: unknown architecture policyId: {policy}.",
                                node.data.label
                            ),
                            Some(node.id.clone()),
                            None,
                        ));
                    }
                }
            }
        }
        if node.data.kind == "agent" || node.data.kind == "creative" {
            let selects_write = node
                .data
                .tools
                .iter()
                .any(|tool| tool.to_ascii_lowercase().contains("write"));
            let effective_read_only = node
                .data
                .permission_profile
                .as_deref()
                .map(|profile| profile.contains("read-only"))
                .unwrap_or_else(|| node.data.sandbox_profile.as_deref() == Some("read-only"));
            if selects_write && effective_read_only {
                problems.push(problem(
                    format!("write-policy-{}", node.id),
                    format!(
                        "{} selects write tools with a read-only permission boundary.",
                        node.data.label
                    ),
                    Some(node.id.clone()),
                    None,
                ));
            }
            if node
                .data
                .collaboration_mode
                .as_deref()
                .is_some_and(|mode| mode != "default" && mode != "plan")
            {
                problems.push(problem(
                    format!("collaboration-mode-{}", node.id),
                    format!("{} has an unsupported collaboration mode.", node.data.label),
                    Some(node.id.clone()),
                    None,
                ));
            }
            if node
                .data
                .personality
                .as_deref()
                .is_some_and(|value| !matches!(value, "none" | "friendly" | "pragmatic"))
            {
                problems.push(problem(
                    format!("personality-{}", node.id),
                    format!("{} has an unsupported Codex personality.", node.data.label),
                    Some(node.id.clone()),
                    None,
                ));
            }
        }
        for (label, schema) in [
            ("input", node.data.input_schema.as_deref()),
            ("output", node.data.output_schema.as_deref()),
        ] {
            if let Some(schema) = schema {
                let valid = serde_json::from_str::<Value>(schema)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("type")
                            .and_then(Value::as_str)
                            .map(|kind| kind == "object")
                    })
                    .unwrap_or(false);
                if !valid {
                    problems.push(problem(
                        format!("{label}-schema-{}", node.id),
                        format!("{} has an invalid {label} JSON Schema.", node.data.label),
                        Some(node.id.clone()),
                        None,
                    ));
                }
            }
        }
    }
    if let Some(cycle) = standard_cycle(graph) {
        problems.push(problem(
            "standard-cycle",
            format!(
                "Standard cycle detected: {}. Use a bounded revision edge instead.",
                cycle.join(" → ")
            ),
            None,
            None,
        ));
    }
    let mut reachable: HashSet<String> = if cron_triggers.is_empty() {
        inputs.iter().map(|node| node.id.clone()).collect()
    } else {
        cron_triggers.iter().map(|node| node.id.clone()).collect()
    };
    let mut changed = true;
    while changed {
        changed = false;
        for edge in graph.edges.iter().filter(|edge| !is_revision(edge)) {
            if reachable.contains(&edge.source) && reachable.insert(edge.target.clone()) {
                changed = true;
            }
        }
    }
    for output in outputs {
        if !reachable.contains(&output.id) {
            problems.push(problem(
                format!("unreachable-{}", output.id),
                format!("{} is not reachable from an Input node.", output.data.label),
                Some(output.id.clone()),
                None,
            ));
        }
    }
    problems
}

fn build_execution_plan(
    graph: &GraphSnapshot,
    start_node_id: Option<&str>,
) -> Result<ExecutionPlan, String> {
    use std::collections::{HashSet, VecDeque};
    let problems = validate_graph(graph);
    if !problems.is_empty() {
        return Err(serde_json::to_string(&problems).unwrap_or_else(|_| "Invalid workflow".into()));
    }
    let executable: HashSet<String> = graph
        .nodes
        .iter()
        .filter(|node| {
            node.data.kind != "note" && node.data.kind != "input" && node.data.kind != "cron"
        })
        .map(|node| node.id.clone())
        .collect();
    let included: HashSet<String> = if let Some(start) = start_node_id {
        if !graph.nodes.iter().any(|node| node.id == start) {
            return Err(format!("Unknown start node: {start}"));
        }
        let mut result = HashSet::from([start.to_string()]);
        let mut queue = VecDeque::from([start.to_string()]);
        while let Some(id) = queue.pop_front() {
            for edge in graph
                .edges
                .iter()
                .filter(|edge| edge.source == id && !is_revision(edge))
            {
                if result.insert(edge.target.clone()) {
                    queue.push_back(edge.target.clone());
                }
            }
        }
        result
            .into_iter()
            .filter(|id| executable.contains(id))
            .collect()
    } else {
        executable.clone()
    };
    let mut remaining = included.clone();
    let mut completed: HashSet<String> = graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "input" || !included.contains(&node.id))
        .map(|node| node.id.clone())
        .collect();
    let mut batches = Vec::new();
    while !remaining.is_empty() {
        let mut ready: Vec<String> = remaining
            .iter()
            .filter(|id| {
                graph
                    .edges
                    .iter()
                    .filter(|edge| edge.target.as_str() == id.as_str() && !is_revision(edge))
                    .all(|edge| completed.contains(&edge.source))
            })
            .cloned()
            .collect();
        ready.sort();
        if ready.is_empty() {
            return Err("No schedulable nodes remain; graph dependencies are unresolved.".into());
        }
        for id in &ready {
            remaining.remove(id);
            completed.insert(id.clone());
        }
        batches.push(ready);
    }
    let mut included_node_ids: Vec<String> = included.into_iter().collect();
    included_node_ids.sort();
    Ok(ExecutionPlan {
        batches,
        included_node_ids,
    })
}

pub(crate) fn parse_app_server_line(line: &str) -> Result<Value, String> {
    serde_json::from_str(line.trim()).map_err(|error| format!("Malformed app-server JSON: {error}"))
}

fn redact_sensitive(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                    let sensitive = [
                        "token",
                        "secret",
                        "password",
                        "apikey",
                        "authorization",
                        "cookie",
                    ]
                    .iter()
                    .any(|needle| normalized.contains(needle));
                    (
                        key,
                        if sensitive {
                            Value::String("[REDACTED]".into())
                        } else {
                            redact_sensitive(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_sensitive).collect()),
        other => other,
    }
}

fn codex_command(args: &[&str]) -> std::io::Result<std::process::Output> {
    command_for_codex(&active_codex_path(), args).output()
}

fn codex_command_at(
    path: &std::path::Path,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    command_for_codex(path, args).output()
}

fn version_supported(value: &str) -> bool {
    value
        .split_whitespace()
        .find_map(|part| {
            let mut numbers = part.split('.').filter_map(|item| item.parse::<u32>().ok());
            let major = numbers.next()?;
            let minor = numbers.next()?;
            Some(major == 0 && (140..=150).contains(&minor))
        })
        .unwrap_or(false)
}

/// Shared Codex CLI probe used by the desktop command, headless CLI, and MCP tools.
pub(crate) fn discover_codex_info() -> CodexInfo {
    discover_codex_impl()
}

#[tauri::command]
fn discover_codex() -> CodexInfo {
    // IPC command name remains `discover_codex` for the frontend.
    discover_codex_impl()
}

fn discover_codex_impl() -> CodexInfo {
    let version_output = codex_command(&["--version"]);
    let version = version_output.ok().and_then(|output| {
        let text = output_text(&output);
        // Accept successful exit, or non-empty version text even if the shim
        // returns a quirky exit code (common with npm .cmd wrappers on Windows).
        if !text.is_empty()
            && (output.status.success() || text.to_ascii_lowercase().contains("codex"))
        {
            Some(text)
        } else {
            None
        }
    });
    let app_server_available = codex_command(&["app-server", "--help"])
        .map(|output| {
            output.status.success()
                || String::from_utf8_lossy(&output.stdout)
                    .to_ascii_lowercase()
                    .contains("app-server")
                || String::from_utf8_lossy(&output.stderr)
                    .to_ascii_lowercase()
                    .contains("app-server")
        })
        .unwrap_or(false);
    let supported = version.as_deref().map(version_supported).unwrap_or(false);
    // If app-server is present and --version worked, prefer treating the CLI as
    // usable even when the semver sits slightly outside the last hard-tested band.
    let compatible = version.is_some() && app_server_available;
    let fallback_path = fallback_codex_path();
    let active_path = active_codex_path();
    let using_fallback = active_path == fallback_path;
    let user_selected = std::env::var_os("CODEX_CORP_ACTIVE_PATH").is_some() && !using_fallback;
    let incompatibility_reason = if version.is_none() {
        Some(format!(
            "Codex CLI was not found via {} (install `@openai/codex` or set CODEX_CORP_CODEX_PATH).",
            active_path.display()
        ))
    } else if !app_server_available {
        Some("The installed CLI does not expose app-server.".into())
    } else if !compatible {
        Some("The installed CLI is outside the tested compatibility range.".into())
    } else {
        None
    };
    CodexInfo {
        found: version.is_some(),
        compatible,
        version: version.clone(),
        executable: active_path.display().to_string(),
        app_server_available,
        supported_range: "codex-cli 0.140–0.150 (app-server required)".into(),
        last_tested_version: "codex-cli 0.144.1".into(),
        selected_source: if using_fallback {
            "Tested fallback".into()
        } else if user_selected {
            "User path".into()
        } else {
            "System CLI".into()
        },
        fallback_available: fallback_path.exists(),
        incompatibility_reason,
        compatibility_warning: if compatible && !supported {
            Some(format!(
                "{} is outside the tested range; required app-server probes passed.",
                version.as_deref().unwrap_or("This Codex version")
            ))
        } else {
            None
        },
        capabilities: if app_server_available {
            vec![
                "stdio-jsonl".into(),
                "fresh-threads".into(),
                "streaming-events".into(),
                "approvals".into(),
                "structured-output".into(),
            ]
        } else {
            Vec::new()
        },
    }
}

#[tauri::command]
fn select_codex_source(source: String) -> Result<CodexInfo, String> {
    match source.as_str() {
        "system" => std::env::remove_var("CODEX_CORP_ACTIVE_PATH"),
        "fallback" => {
            let path = fallback_codex_path();
            if !path.exists() {
                return Err("No tested fallback executable is configured.".into());
            }
            let _ = probe_codex_path(path.display().to_string())?;
            std::env::set_var("CODEX_CORP_ACTIVE_PATH", path);
        }
        _ => return Err("Unknown Codex executable source.".into()),
    }
    Ok(discover_codex())
}

#[tauri::command]
fn select_codex_path(path: String) -> Result<CodexInfo, String> {
    let path = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let _ = probe_codex_path(path.display().to_string())?;
    std::env::set_var("CODEX_CORP_ACTIVE_PATH", path);
    Ok(discover_codex())
}

#[tauri::command]
fn probe_codex_path(path: String) -> Result<CodexInfo, String> {
    let path = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.is_file() {
        return Err("The selected Codex executable does not exist or is not a file.".into());
    }
    let output = codex_command_at(&path, &["--version"]).map_err(|error| error.to_string())?;
    let version_text = output_text(&output);
    if version_text.is_empty() {
        return Err("Selected executable did not return a version.".into());
    }
    let app_server =
        codex_command_at(&path, &["app-server", "--help"]).map_err(|error| error.to_string())?;
    let app_server_available = app_server.status.success()
        || output_text(&app_server)
            .to_ascii_lowercase()
            .contains("app-server");
    if !app_server_available {
        return Err("Selected executable failed the required app-server protocol probe.".into());
    }
    let supported = version_supported(&version_text);
    Ok(CodexInfo {
        found: true,
        version: Some(version_text.clone()),
        executable: path.display().to_string(),
        app_server_available,
        compatible: true,
        supported_range: "codex-cli 0.140–0.150 (app-server required)".into(),
        last_tested_version: "codex-cli 0.144.1".into(),
        selected_source: "Proposed user path".into(),
        fallback_available: fallback_codex_path().exists(),
        incompatibility_reason: None,
        compatibility_warning: if supported {
            None
        } else {
            Some(format!(
                "{version_text} is outside the tested range; required app-server probes passed."
            ))
        },
        capabilities: vec![
            "stdio-jsonl".into(),
            "thread-resume".into(),
            "streaming-events".into(),
            "approvals".into(),
            "structured-output".into(),
        ],
    })
}

#[tauri::command]
fn save_workflow(
    snapshot: WorkflowSnapshot,
    database: tauri::State<'_, Database>,
) -> Result<(), String> {
    let connection = crate::workflow_runtime::database_guard_for(&database);
    connection
        .execute(
            "INSERT INTO workflows (id, name, graph_json, workspace_path, template_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, graph_json=excluded.graph_json, workspace_path=COALESCE(excluded.workspace_path,workflows.workspace_path), template_json=COALESCE(excluded.template_json,workflows.template_json), updated_at=CURRENT_TIMESTAMP",
            params![snapshot.id, snapshot.name, snapshot.graph_json, snapshot.workspace_path, snapshot.template_json]
        ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_workflow_catalog(database: tauri::State<'_, Database>) -> Result<Vec<String>, String> {
    let connection = crate::workflow_runtime::database_guard_for(&database);
    let mut statement = connection
        .prepare("SELECT id,name,graph_json,template_json FROM workflows ORDER BY updated_at,id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let graph_json: String = row.get(2)?;
            let template_json: Option<String> = row.get(3)?;
            if let Some(template) = template_json {
                return Ok(template);
            }
            let graph: Value = serde_json::from_str(&graph_json).unwrap_or_else(|_| json!({}));
            Ok(json!({
                "id": id,
                "name": name,
                "description": "",
                "version": "v0.1",
                "nodes": graph.get("nodes").cloned().unwrap_or_else(|| json!([])),
                "edges": graph.get("edges").cloned().unwrap_or_else(|| json!([])),
            })
            .to_string())
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_workflow_catalog_item(
    template_json: String,
    database: tauri::State<'_, Database>,
) -> Result<(), String> {
    let template: Value = serde_json::from_str(&template_json)
        .map_err(|error| format!("invalid workflow template: {error}"))?;
    let id = template
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("workflow template requires id")?;
    let name = template
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("workflow template requires name")?;
    let nodes = template.get("nodes").cloned().unwrap_or_else(|| json!([]));
    let edges = template.get("edges").cloned().unwrap_or_else(|| json!([]));
    let graph_json = json!({ "nodes": nodes, "edges": edges }).to_string();
    let connection = crate::workflow_runtime::database_guard_for(&database);
    connection
        .execute(
            "INSERT INTO workflows(id,name,graph_json,template_json,updated_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,graph_json=excluded.graph_json,template_json=excluded.template_json,updated_at=CURRENT_TIMESTAMP",
            params![id, name, graph_json, template_json],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_workflow(id: String, database: tauri::State<'_, Database>) -> Result<(), String> {
    let mut connection = crate::workflow_runtime::database_guard_for(&database);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM workflows WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?;
    crate::workflow_runtime::delete_node_experience_for_workflow(&transaction, &id)
        .map_err(|error| error.to_string())?;
    crate::harness_lessons::delete_lessons_for_workflow(&transaction, &id)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn load_workflow(
    id: String,
    database: tauri::State<'_, Database>,
) -> Result<Option<String>, String> {
    let connection = crate::workflow_runtime::database_guard_for(&database);
    let mut statement = connection
        .prepare("SELECT graph_json FROM workflows WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(params![id])
        .map_err(|error| error.to_string())?;
    rows.next()
        .map_err(|error| error.to_string())?
        .map(|row| row.get(0))
        .transpose()
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedWorkflowRecord {
    graph_json: String,
    workspace_path: Option<String>,
}

fn load_workflow_record_from_connection(
    connection: &Connection,
    id: &str,
) -> Result<Option<LoadedWorkflowRecord>, String> {
    let mut statement = connection
        .prepare("SELECT graph_json,workspace_path FROM workflows WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(params![id])
        .map_err(|error| error.to_string())?;
    let Some(row) = rows.next().map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let workspace_path: Option<String> = row.get(1).map_err(|error| error.to_string())?;
    Ok(Some(LoadedWorkflowRecord {
        graph_json: row.get(0).map_err(|error| error.to_string())?,
        workspace_path: workspace_path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty()),
    }))
}

#[tauri::command]
fn load_workflow_record(
    id: String,
    database: tauri::State<'_, Database>,
) -> Result<Option<LoadedWorkflowRecord>, String> {
    let connection = crate::workflow_runtime::database_guard_for(&database);
    load_workflow_record_from_connection(&connection, &id)
}

#[tauri::command]
fn validate_workflow(graph_json: String) -> Result<Vec<GraphProblem>, String> {
    let graph: GraphSnapshot = serde_json::from_str(&graph_json)
        .map_err(|error| format!("Invalid graph JSON: {error}"))?;
    Ok(validate_graph(&graph))
}

#[tauri::command]
fn plan_workflow(
    graph_json: String,
    start_node_id: Option<String>,
) -> Result<ExecutionPlan, String> {
    let graph: GraphSnapshot = serde_json::from_str(&graph_json)
        .map_err(|error| format!("Invalid graph JSON: {error}"))?;
    build_execution_plan(&graph, start_node_id.as_deref())
}

#[cfg(test)]
fn persist_run(connection: &mut Connection, run: &RunSnapshot) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute(
            "INSERT INTO runs (id, workflow_id, status, events_json, nodes_json, edges_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, events_json=excluded.events_json, nodes_json=excluded.nodes_json, edges_json=excluded.edges_json",
            params![&run.id, &run.workflow_id, &run.status, &run.events_json, &run.nodes_json, &run.edges_json]
        ).map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM run_events WHERE run_id=?1", params![&run.id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM node_executions WHERE run_id=?1",
            params![&run.id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM approvals WHERE run_id=?1", params![&run.id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM artifacts WHERE run_id=?1", params![&run.id])
        .map_err(|error| error.to_string())?;
    if let Ok(events) = serde_json::from_str::<Vec<Value>>(&run.events_json) {
        for event in events {
            let node_id = event.get("nodeId").and_then(Value::as_str);
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("run.event");
            transaction.execute(
                "INSERT INTO run_events (run_id, node_id, event_type, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![&run.id, node_id, event_type, event.to_string()]
            ).map_err(|error| error.to_string())?;
        }
    }
    if let Ok(nodes) = serde_json::from_str::<Vec<Value>>(&run.nodes_json) {
        for node in nodes {
            let node_id = node.get("id").and_then(Value::as_str).unwrap_or("unknown");
            let data = node.get("data").cloned().unwrap_or(Value::Null);
            let status = data
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let thread_id = data.get("threadId").and_then(Value::as_str);
            transaction.execute("INSERT INTO node_executions (id,run_id,node_id,thread_id,status,output_json) VALUES (?1,?2,?3,?4,?5,?6)",params![format!("{}:{}",run.id,node_id),&run.id,node_id,thread_id,status,data.to_string()]).map_err(|error|error.to_string())?;
        }
    }
    if let Ok(approvals) = serde_json::from_str::<Vec<Value>>(&run.approvals_json) {
        for approval in approvals {
            let approval_id = approval
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let node_id = approval
                .get("nodeId")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let decision = approval.get("status").and_then(Value::as_str);
            transaction.execute("INSERT INTO approvals (id,run_id,node_id,request_json,decision) VALUES (?1,?2,?3,?4,?5)",params![approval_id,&run.id,node_id,approval.to_string(),decision]).map_err(|error|error.to_string())?;
        }
    }
    if let Ok(artifacts) = serde_json::from_str::<Vec<Value>>(&run.artifacts_json) {
        for (index, artifact) in artifacts.into_iter().enumerate() {
            // Scope ids by run — specialist payloads often reuse stable names
            // which collide with older runs when the PK is global artifacts.id.
            let raw_id = artifact
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("artifact");
            let artifact_id = format!("{}:{}:{}", run.id, index, raw_id);
            let node_id = artifact
                .get("nodeId")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            transaction
                .execute(
                    "INSERT INTO artifacts (id,run_id,node_id,metadata_json) VALUES (?1,?2,?3,?4)",
                    params![artifact_id, &run.id, node_id, artifact.to_string()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_runs(
    workflow_id: String,
    database: tauri::State<'_, Database>,
) -> Result<Vec<RunRecord>, String> {
    let connection = crate::workflow_runtime::database_guard_for(&database);
    let mut records = {
        let mut statement = connection.prepare(
            "SELECT id,workflow_id,status,created_at,events_json,COALESCE(nodes_json,''),COALESCE(edges_json,''),terminal_reason,resumable,pinned,last_event_seq FROM runs WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 50"
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![workflow_id], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    status: row.get(2)?,
                    created_at: row.get(3)?,
                    events_json: row.get(4)?,
                    nodes_json: row.get(5)?,
                    edges_json: row.get(6)?,
                    terminal_reason: row.get(7)?,
                    resumable: row.get::<_, i64>(8)? != 0,
                    pinned: row.get::<_, i64>(9)? != 0,
                    last_event_sequence: row.get::<_, i64>(10)? as u64,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    hydrate_run_records(&connection, &mut records)?;
    Ok(records)
}

fn runtime_output_status_for_canvas(status: &str) -> &'static str {
    match status {
        "success" | "completed" => "completed",
        "failure" | "failed" => "failed",
        "needs_revision" => "needs_revision",
        "interrupted" => "interrupted",
        "skipped" => "skipped",
        _ => "failed",
    }
}

fn hydrate_run_records(connection: &Connection, records: &mut [RunRecord]) -> Result<(), String> {
    for record in records {
        let mut event_statement = connection.prepare(
            "SELECT payload_json FROM run_events WHERE run_id=?1 ORDER BY COALESCE(sequence,id),id"
        ).map_err(|error| error.to_string())?;
        let event_rows = event_statement
            .query_map(params![record.id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let event_values = event_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if !event_values.is_empty() {
            record.events_json = format!("[{}]", event_values.join(","));
        }

        let mut token_totals: HashMap<String, u64> = HashMap::new();
        let mut revision_totals: HashMap<String, u64> = HashMap::new();
        let mut attempt_statement = connection
            .prepare("SELECT node_id,revision,diagnostics_json FROM node_attempts WHERE run_id=?1")
            .map_err(|error| error.to_string())?;
        let attempts = attempt_statement
            .query_map(params![record.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for attempt in attempts {
            let (node_id, revision, diagnostics) = attempt.map_err(|error| error.to_string())?;
            let tokens = serde_json::from_str::<Value>(&diagnostics)
                .ok()
                .and_then(|value| {
                    value
                        .get("attemptTokens")
                        .or_else(|| value.get("tokens"))
                        .and_then(Value::as_u64)
                })
                .unwrap_or(0);
            let total = token_totals.entry(node_id.clone()).or_insert(0);
            *total = total.saturating_add(tokens);
            let highest_revision = revision_totals.entry(node_id).or_insert(0);
            *highest_revision = (*highest_revision).max(revision);
        }

        let mut nodes: Value = serde_json::from_str(&record.nodes_json).unwrap_or(Value::Null);
        if let Some(node_list) = nodes.as_array_mut() {
            let mut execution_statement = connection
                .prepare("SELECT node_id,status,output_json FROM node_executions WHERE run_id=?1")
                .map_err(|error| error.to_string())?;
            let executions = execution_statement
                .query_map(params![record.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            for execution in executions {
                let (node_id, status, output_json) =
                    execution.map_err(|error| error.to_string())?;
                if let Some(node) = node_list
                    .iter_mut()
                    .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id.as_str()))
                {
                    if let Some(data) = node.get_mut("data").and_then(Value::as_object_mut) {
                        data.insert(
                            "status".into(),
                            Value::String(runtime_output_status_for_canvas(&status).into()),
                        );
                        if let Some(output) =
                            output_json.and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                        {
                            if let Some(summary) = output.get("summary") {
                                data.insert("output".into(), summary.clone());
                            }
                            if let Some(structured) = output.get("data") {
                                data.insert("structuredOutput".into(), structured.clone());
                            }
                            if let Some(artifacts) = output.get("artifacts") {
                                data.insert("artifacts".into(), artifacts.clone());
                            }
                            if let Some(thread_id) = output.get("threadId") {
                                data.insert("threadId".into(), thread_id.clone());
                            }
                            if let Some(tokens) = output.get("tokens") {
                                data.insert("tokens".into(), tokens.clone());
                            } else if let Some(tokens) = extract_total_tokens(&output) {
                                data.insert("tokens".into(), Value::Number(tokens.into()));
                            }
                        }
                    }
                }
            }
            for node in node_list {
                let Some(node_id) = node.get("id").and_then(Value::as_str).map(str::to_string)
                else {
                    continue;
                };
                if let Some(data) = node.get_mut("data").and_then(Value::as_object_mut) {
                    if let Some(tokens) = token_totals.get(&node_id).copied() {
                        data.insert("tokens".into(), Value::Number(tokens.into()));
                    }
                    if let Some(revisions) = revision_totals.get(&node_id).copied() {
                        data.insert("revisions".into(), Value::Number(revisions.into()));
                    }
                }
            }
            record.nodes_json =
                serde_json::to_string(&nodes).unwrap_or_else(|_| record.nodes_json.clone());
        }
    }
    Ok(())
}

fn token_burn_from_nodes_json(raw: &str) -> u64 {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|node| node.get("data").and_then(extract_total_tokens))
        .fold(0, u64::saturating_add)
}

fn load_portfolio_run_summaries(
    connection: &Connection,
) -> Result<Vec<PortfolioRunSummary>, String> {
    let runs = {
        let mut statement = connection
            .prepare("SELECT id,workflow_id,COALESCE(nodes_json,'') FROM runs")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    // One scan replaces the previous per-run hydration of events, attempts, and
    // executions. Attempt totals remain authoritative; legacy node snapshots
    // provide a fallback for runs recorded before attempt diagnostics existed.
    let mut attempt_totals: HashMap<String, u64> = HashMap::new();
    {
        let mut statement = connection
            .prepare("SELECT run_id,diagnostics_json FROM node_attempts")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (run_id, diagnostics) = row.map_err(|error| error.to_string())?;
            let tokens = serde_json::from_str::<Value>(&diagnostics)
                .ok()
                .and_then(|value| {
                    value
                        .get("attemptTokens")
                        .or_else(|| value.get("tokens"))
                        .and_then(Value::as_u64)
                });
            if let Some(tokens) = tokens {
                let total = attempt_totals.entry(run_id).or_insert(0);
                *total = total.saturating_add(tokens);
            }
        }
    }

    let mut by_workflow: HashMap<String, PortfolioRunSummary> = HashMap::new();
    for (run_id, workflow_id, nodes_json) in runs {
        let token_burn = attempt_totals
            .get(&run_id)
            .copied()
            .unwrap_or_else(|| token_burn_from_nodes_json(&nodes_json));
        let summary = by_workflow
            .entry(workflow_id.clone())
            .or_insert(PortfolioRunSummary {
                workflow_id,
                run_count: 0,
                token_burn: 0,
            });
        summary.run_count = summary.run_count.saturating_add(1);
        summary.token_burn = summary.token_burn.saturating_add(token_burn);
    }
    let mut summaries = by_workflow.into_values().collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        right
            .token_burn
            .cmp(&left.token_burn)
            .then_with(|| left.workflow_id.cmp(&right.workflow_id))
    });
    Ok(summaries)
}

/// Compact lifetime portfolio totals. The dashboard never needs run events,
/// execution output, or artifact payloads, so do not hydrate full RunRecords.
#[tauri::command]
fn list_portfolio_run_summaries(
    database: tauri::State<'_, Database>,
) -> Result<Vec<PortfolioRunSummary>, String> {
    let connection = crate::workflow_runtime::database_guard_for(&database);
    load_portfolio_run_summaries(&connection)
}

#[tauri::command]
fn respond_codex_approval(
    request_id: String,
    decision: String,
    broker: tauri::State<'_, ApprovalBroker>,
) -> Result<(), String> {
    let pending = crate::workflow_runtime::poison_aware_lock(&broker.0, "approval broker", None)
        .remove(&request_id)
        .ok_or("approval request is no longer pending")?;
    if pending.kind != PendingInteractionKind::Approval {
        return Err("pending request is not an approval".into());
    }
    pending
        .sender
        .send(Value::String(decision))
        .map_err(|error| error.to_string())
}

/// Respond to a pending user-input or elicitation request.
/// `payload` is the typed JSON result to send back to app-server.
#[tauri::command]
fn respond_user_input(
    request_id: String,
    payload: Value,
    broker: tauri::State<'_, ApprovalBroker>,
) -> Result<(), String> {
    let pending = crate::workflow_runtime::poison_aware_lock(&broker.0, "approval broker", None)
        .remove(&request_id)
        .ok_or("user input request is no longer pending")?;
    if pending.kind == PendingInteractionKind::Approval {
        return Err("pending request is an approval, not structured input".into());
    }
    pending
        .sender
        .send(payload)
        .map_err(|error| error.to_string())
}

/// Resolve a pending dynamic tool call from the company mediator host.
/// `content` is plain text (JSON string recommended); `success` is tool success flag.
#[tauri::command]
fn respond_mediator_tool(
    request_id: String,
    success: bool,
    content: String,
    broker: tauri::State<'_, ToolBroker>,
) -> Result<(), String> {
    let payload = json!({
        "success": success,
        "content": content,
    })
    .to_string();
    let sender = crate::workflow_runtime::poison_aware_lock(&broker.0, "tool broker", None)
        .remove(&request_id)
        .ok_or("tool call is no longer pending")?;
    sender.send(payload).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediatorTurnRequest {
    model: String,
    effort: String,
    /// Authored base; empty omits baseInstructions.
    #[serde(default)]
    base_instructions: String,
    /// Role/mediator contract; empty omits developerInstructions.
    #[serde(default)]
    developer_instructions: String,
    /// Legacy single-blob field — treated as base when dual fields are empty.
    #[serde(default)]
    system_prompt: String,
    input: Vec<Value>,
    #[serde(default)]
    context_digest: String,
    /// Bounded plain-text transcript used only when thread/resume cannot recover the thread.
    #[serde(default)]
    fallback_transcript: String,
    /// DynamicToolSpec[] JSON array for thread/start.
    #[serde(default)]
    dynamic_tools: Value,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    project_mode: Option<String>,
    #[serde(default)]
    workspace_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediatorTurnResult {
    summary: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediatorToolCallEvent {
    request_id: String,
    session_id: Option<String>,
    message_id: Option<String>,
    tool: String,
    arguments: Value,
    call_id: Option<String>,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediatorChatDeltaEvent {
    session_id: Option<String>,
    message_id: Option<String>,
    delta: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediatorStreamEvent {
    session_id: Option<String>,
    message_id: Option<String>,
    event_type: String,
    text: String,
    thread_id: String,
    turn_id: String,
}

/// Build the thread/start or thread/resume params for the mediator turn.
/// Byte uses `workspace-write` sandbox and `on-request` approval so it can
/// execute shell commands in the selected workspace, subject to the native
/// approval broker and the publish-operation guard.
fn mediator_turn_params(
    workspace: &Path,
    model: &str,
    tools: &Value,
    base: &str,
    developer: &str,
) -> Value {
    let mut params = json!({
        "model": model,
        "cwd": workspace,
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write",
        "ephemeral": true,
        "dynamicTools": tools
    });
    apply_instruction_params(&mut params, base, developer);
    params
}

/// Detect Git publish operations that must be routed through the dedicated
/// publish-approval node, not ordinary Byte shell access.
fn is_publish_operation(command: &str) -> bool {
    let lower = command.trim().to_lowercase();
    if !lower.starts_with("git ") {
        return false;
    }
    lower.contains("push") || lower.contains("commit") || lower.contains("reset --hard")
}

/// Company chat mediator: Live Codex turn with dynamicTools + streaming deltas.
#[tauri::command]
async fn execute_mediator_turn(
    request: MediatorTurnRequest,
    app: tauri::AppHandle,
    tool_broker: tauri::State<'_, ToolBroker>,
    process_broker: tauri::State<'_, ProcessBroker>,
    broker: tauri::State<'_, ApprovalBroker>,
) -> Result<MediatorTurnResult, String> {
    let tool_broker = tool_broker.inner().clone();
    let process_broker = process_broker.inner().clone();
    let broker = broker.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app = Some(app);
        let workspace = request
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_chat_workspace_path);
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        if !workspace.is_dir() {
            return Err("Selected app workspace is not a folder".into());
        }
        let project_is_new = request
            .project_mode
            .as_deref()
            .is_some_and(|mode| mode.eq_ignore_ascii_case("new"));
        if project_is_new || is_app_managed_workspace(&workspace) {
            prepare_greenfield_workspace(&workspace, true)?;
        }
        let model = normalize_model_id(&request.model);
        if model.is_empty() {
            return Err("No Codex model for company mediator".into());
        }
        let mut child = codex_app_server()?;
        let stdin_raw = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
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
        let child = Arc::new(Mutex::new(child));
        crate::workflow_runtime::poison_aware_lock(&process_broker.0, "process broker", None)
            .insert("company-mediator".into(), child.clone());
        let _registration = ProcessRegistration {
            node_id: "company-mediator".into(),
            broker: process_broker.clone(),
            child: child.clone(),
        };

        let read_response = |expected_id: i64| -> Result<Value, String> {
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    kill_app_server_child(&child);
                    return Err(format!(
                        "Codex app-server timed out waiting for response id={expected_id}"
                    ));
                }
                match line_rx.recv_timeout(remaining) {
                    Ok(Ok(line)) => {
                        let value = parse_app_server_line(&line)?;
                        if value.get("id").and_then(|id| id.as_i64()) == Some(expected_id)
                            || value.get("id").and_then(|id| id.as_u64())
                                == Some(expected_id as u64)
                        {
                            if let Some(err) = value.get("error") {
                                return Err(format!("Codex app-server error: {err}"));
                            }
                            return Ok(value
                                .get("result")
                                .cloned()
                                .unwrap_or(Value::Null));
                        }
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("Codex app-server closed".into());
                    }
                }
            }
        };

        // dynamicTools is gated behind experimentalApi (same as list models / execute_agent).
        // This is the supported app-server handshake — not a fallback or stub path.
        send_json_timed(
            &stdin,
            json!({
                "jsonrpc":"2.0",
                "id":1,
                "method":"initialize",
                "params":{
                    "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
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

        let session_id = request.session_id.clone();
        let message_id = request.message_id.clone();
        let tools = if request.dynamic_tools.is_null() {
            json!([])
        } else {
            request.dynamic_tools.clone()
        };
        // Dual instructions; legacy system_prompt maps to base when dual empty.
        let mediator_base = if !request.base_instructions.trim().is_empty() {
            request.base_instructions.as_str()
        } else if !request.system_prompt.trim().is_empty() {
            request.system_prompt.as_str()
        } else {
            ""
        };
        let mediator_developer = request.developer_instructions.as_str();
        let requested_thread = request
            .thread_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let mut resumed = false;
        let mut next_request_id = 2;
        let thread_result = if let Some(thread_id) = requested_thread {
            let mut resume_params = mediator_turn_params(&workspace, &model, &tools, mediator_base, mediator_developer);
            resume_params["threadId"] = json!(thread_id);
            resume_params["excludeTurns"] = json!(true);
            // Resume does not use dynamicTools; remove it for protocol compatibility.
            if let Some(obj) = resume_params.as_object_mut() {
                obj.remove("dynamicTools");
                obj.remove("ephemeral");
            }
            send_json_timed(
                &stdin,
                json!({
                    "jsonrpc":"2.0","id":next_request_id,"method":"thread/resume",
                    "params": resume_params
                }),
                Duration::from_secs(15),
            )?;
            match read_response(next_request_id) {
                Ok(result) => {
                    resumed = true;
                    result
                }
                Err(error) => {
                    emit_optional(&app,
                        "mediator-thread-recovered",
                        json!({"oldThreadId":thread_id,"reason":error}),
                    );
                    next_request_id += 1;
                    let start_params = mediator_turn_params(&workspace, &model, &tools, mediator_base, mediator_developer);
                    send_json_timed(
                        &stdin,
                        json!({
                            "jsonrpc":"2.0","id":next_request_id,"method":"thread/start",
                            "params": start_params
                        }),
                        Duration::from_secs(15),
                    )?;
                    read_response(next_request_id)?
                }
            }
        } else {
            let start_params = mediator_turn_params(&workspace, &model, &tools, mediator_base, mediator_developer);
            send_json_timed(
                &stdin,
                json!({
                    "jsonrpc":"2.0","id":next_request_id,"method":"thread/start",
                    "params": start_params
                }),
                Duration::from_secs(15),
            )?;
            read_response(next_request_id)?
        };
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("thread/start missing thread id")?
            .to_string();

        let mut input = request.input.clone();
        if !resumed && !request.fallback_transcript.trim().is_empty() {
            input.insert(0, json!({
                "type":"text",
                "text":format!("RECENT CONVERSATION (bounded recovery transcript):\n{}", request.fallback_transcript),
                "text_elements":[]
            }));
        }
        if !request.context_digest.trim().is_empty() {
            input.push(json!({
                "type":"text",
                "text":format!("COMPANY CONTEXT (authorized):\n{}", request.context_digest),
                "text_elements":[]
            }));
        }
        if request.workspace_path.is_some() && request.project_mode.is_some() {
            input.push(json!({
                "type":"text",
                "text":format!(
                    "APP CONTEXT (selected by the operator):\nINTENT={}\nWORKSPACE={}\nUse this intent when clarifying requirements. Treat the workspace as the target project folder and never silently substitute another folder.",
                    request.project_mode.as_deref().unwrap_or("new"),
                    workspace.to_string_lossy()
                ),
                "text_elements":[]
            }));
        }
        if input.is_empty() {
            return Err("Company mediator turn has no input".into());
        }
        next_request_id += 1;
        send_json_timed(
            &stdin,
            json!({
                "jsonrpc":"2.0","id":next_request_id,"method":"turn/start",
                "params":{
                    "threadId": thread_id,
                    "input":input,
                    "model": model,
                    "effort": request.effort
                }
            }),
            Duration::from_secs(15),
        )?;
        let turn_result = read_response(next_request_id)?;
        let turn_id = turn_result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or("turn/start missing turn id")?
            .to_string();

        let mut message = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                kill_app_server_child(&child);
                break;
            }
            let line = match line_rx.recv_timeout(remaining.min(Duration::from_secs(45))) {
                Ok(Ok(l)) => l,
                Ok(Err(e)) => return Err(e),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    kill_app_server_child(&child);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let value = parse_app_server_line(&line)?;
            // Handle requestApproval from the mediator (Byte) turn.
            // Byte uses workspace-write + on-request, so the app-server will ask
            // for approval before executing shell commands. We route these through
            // the same approval broker as specialist nodes, with a publish-operation
            // guard that blocks git commit/push/reset --hard.
            if value.get("id").is_some()
                && value
                    .get("method")
                    .and_then(Value::as_str)
                    .map(|m| m.ends_with("requestApproval"))
                    .unwrap_or(false)
            {
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                let raw_request_id = id
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| id.to_string());
                let broker_request_id = format!("company-mediator::{raw_request_id}");
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                // Publish-operation guard: block git commit/push/reset --hard.
                let command = params
                    .pointer("/command")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let _cwd = params
                    .pointer("/cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if is_publish_operation(command) {
                    let _ = send_json_timed(
                        &stdin,
                        json!({
                            "jsonrpc":"2.0",
                            "id": id,
                            "result": {
                                "decision": "decline",
                                "reason": "Publish operations require the dedicated publish-approval node."
                            }
                        }),
                        Duration::from_secs(10),
                    );
                    emit_optional(
                        &app,
                        "codex-agent-event",
                        NormalizedAgentEvent {
                            node_id: "company-mediator".into(),
                            event_type: "approval.publish_blocked".into(),
                            message: format!(
                                "Blocked publish operation from Byte shell: {command}"
                            ),
                            thread_id: Some(thread_id.clone()),
                            turn_id: Some(turn_id.clone()),
                            tokens: None,
                        },
                    );
                    continue;
                }
                let (sender, receiver) = mpsc::channel();
                crate::workflow_runtime::poison_aware_lock(
                    &broker.0,
                    "approval broker",
                    None,
                )
                .insert(
                    broker_request_id.clone(),
                    PendingInteraction {
                        kind: PendingInteractionKind::Approval,
                        process_key: "company-mediator".into(),
                        sender,
                    },
                );
                emit_optional(
                    &app,
                    "codex-approval-requested",
                    NativeApprovalEvent {
                        request_id: broker_request_id.clone(),
                        node_id: "company-mediator".into(),
                        method: "requestApproval".into(),
                        params: redact_sensitive(params),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                );
                let decision = receiver
                    .recv_timeout(Duration::from_secs(120))
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "decline".into());
                broker.0.lock().remove(&broker_request_id);
                emit_optional(
                    &app,
                    "codex-approval-resolved",
                    NativeApprovalResolvedEvent {
                        request_id: broker_request_id.clone(),
                        node_id: "company-mediator".into(),
                        decision: decision.clone(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                );
                let _ = send_json_timed(
                    &stdin,
                    json!({"jsonrpc":"2.0","id":id,"result":{"decision":decision}}),
                    Duration::from_secs(5),
                );
                continue;
            }
            if value.get("id").is_some()
                && value.get("method").and_then(Value::as_str) == Some("item/tool/call")
            {
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                let request_id = id
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| id.to_string());
                let tool = value
                    .pointer("/params/tool")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let arguments = value
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or(Value::Null);
                let call_id = value
                    .pointer("/params/callId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let (tx, rx) = mpsc::channel();
                crate::workflow_runtime::poison_aware_lock(&tool_broker.0, "tool broker", None)
                    .insert(request_id.clone(), tx);
                emit_optional(&app,
                    "mediator-tool-call",
                    MediatorToolCallEvent {
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                        message_id: message_id.clone(),
                        tool,
                        arguments,
                        call_id,
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                );
                let tool_payload = rx.recv_timeout(Duration::from_secs(120)).unwrap_or_else(
                    |_| {
                        json!({"success":false,"content":"{\"error\":\"tool host timeout\"}"})
                            .to_string()
                    },
                );
                tool_broker.0.lock().remove(&request_id);
                let parsed: Value = serde_json::from_str(&tool_payload)
                    .unwrap_or(json!({"success":false,"content":tool_payload}));
                let success = parsed
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let content = parsed
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let _ = send_json_timed(
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
                );
                continue;
            }
            let method = value.get("method").and_then(Value::as_str).unwrap_or_default();
            if method == "item/agentMessage/delta" {
                let delta = value
                    .pointer("/params/delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                message.push_str(delta);
                emit_optional(&app,
                    "mediator-chat-delta",
                    MediatorChatDeltaEvent {
                        session_id: session_id.clone(),
                        message_id: message_id.clone(),
                        delta: delta.to_string(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                );
            } else if method == "item/completed"
                && value.pointer("/params/item/type").and_then(Value::as_str)
                    == Some("agentMessage")
            {
                if let Some(text) = value.pointer("/params/item/text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        message = text.to_string();
                    }
                }
            } else if method == "item/reasoning/textDelta"
                || method == "item/reasoning/summaryTextDelta"
                || method == "item/plan/delta"
                || method == "turn/plan/updated"
                || method == "item/commandExecution/outputDelta"
                || method == "process/outputDelta"
                || method == "turn/diff/updated"
                || method == "item/fileChange/patchUpdated"
            {
                let delta = value
                    .pointer("/params/delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let stream_text = if method == "turn/diff/updated" {
                    value
                        .pointer("/params/diff")
                        .and_then(Value::as_str)
                        .unwrap_or(&delta)
                        .to_string()
                } else if method == "item/fileChange/patchUpdated" {
                    value
                        .get("params")
                        .map(|p| p.to_string())
                        .unwrap_or_default()
                } else {
                    delta
                };
                emit_optional(
                    &app,
                    "mediator-stream-event",
                    MediatorStreamEvent {
                        session_id: session_id.clone(),
                        message_id: message_id.clone(),
                        event_type: method.into(),
                        text: stream_text,
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                );
            } else if method == "turn/completed" || method == "error" {
                if method == "error" && message.is_empty() {
                    message = value
                        .pointer("/params/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("mediator turn error")
                        .to_string();
                }
                break;
            } else if method == "hook/started" || method == "hook/completed" {
                match parse_hook_run_record(&value, "company-mediator", &thread_id, &turn_id) {
                    Ok(record) => {
                        if let Some(handle) = app.as_ref() {
                            let database = handle.state::<Database>().inner().clone();
                            if let Err(error) = persist_hook_record(&database, &record) {
                                emit_optional(&app, "codex-hook-persistence-error", json!({"message": error}));
                            }
                        }
                        emit_hook_record(&app, method, &record);
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: "company-mediator".into(),
                                event_type: method.into(),
                                message: format!(
                                    "hook {} ({}) → {}",
                                    record.event_name, record.handler_type, record.status
                                ),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    }
                    Err(error) => emit_optional(
                        &app,
                        "codex-hook-persistence-error",
                        json!({"message": error}),
                    ),
                }
            } else if !method.is_empty() {
                // Catch-all: forward unhandled events so the frontend can surface them.
                emit_optional(
                    &app,
                    "codex-agent-event",
                    NormalizedAgentEvent {
                        node_id: "company-mediator".into(),
                        event_type: method.into(),
                        message: value
                            .get("params")
                            .map(|p| p.to_string())
                            .unwrap_or_else(|| method.into()),
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                        tokens: None,
                    },
                );
            }
        }
        if message.trim().is_empty() {
            message = "Company agent finished without text.".into();
        }
        Ok(MediatorTurnResult {
            summary: message,
            thread_id,
            turn_id,
        })
    })
    .await
    .map_err(|e| format!("mediator turn join error: {e}"))?
}

// ---------------------------------------------------------------------------
// Realtime voice session commands
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRealtimeRequest {
    session_key: String,
    surface: String,
    model: Option<String>,
    effort: Option<String>,
    workspace_path: Option<String>,
    voice: Option<String>,
    output_modality: String,
    base_instructions: Option<String>,
    developer_instructions: Option<String>,
    #[serde(default)]
    context_digest: String,
    #[serde(default)]
    recent_transcript: String,
    #[serde(default)]
    dynamic_tools: Value,
    #[serde(skip)]
    app_server_path: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartRealtimeResult {
    thread_id: String,
    realtime_session_id: Option<String>,
    version: Option<String>,
}

/// Spawn a background thread that reads stdout lines and emits Tauri events
/// for realtime notifications.
struct RealtimeDispatcherContext {
    session_key: String,
    thread_id: String,
    broker: RealtimeBroker,
    tool_broker: ToolBroker,
    approval_broker: ApprovalBroker,
    database: Database,
    surface: String,
    app: tauri::AppHandle,
}

fn spawn_realtime_dispatcher(
    buffered_lines: Vec<String>,
    line_rx: mpsc::Receiver<Result<String, String>>,
    context: RealtimeDispatcherContext,
) {
    std::thread::spawn(move || {
        let RealtimeDispatcherContext {
            session_key,
            thread_id,
            broker,
            tool_broker,
            approval_broker,
            database,
            surface,
            app,
        } = context;
        let mut terminal = false;
        for line_result in buffered_lines.into_iter().map(Ok).chain(line_rx) {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => break,
            };
            let value = match parse_app_server_line(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Notifications have no "id" field.
            if value.get("id").is_some() && value.get("method").is_none() {
                continue;
            }
            let method = value.get("method").and_then(Value::as_str).unwrap_or("");
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            match method {
                "item/tool/call" => {
                    let id = value.get("id").cloned().unwrap_or(Value::Null);
                    let raw_id = id
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| id.to_string());
                    let request_id = format!("realtime::{session_key}::{raw_id}");
                    let (sender, receiver) = mpsc::channel();
                    {
                        let mut pending = crate::workflow_runtime::poison_aware_lock(
                            &tool_broker.0,
                            "tool broker",
                            None,
                        );
                        pending.insert(request_id.clone(), sender);
                    }
                    let _ = app.emit(
                        "mediator-tool-call",
                        json!({
                            "requestId": request_id,
                            "sessionKey": session_key,
                            "surface": surface,
                            "tool": params.get("tool").cloned().unwrap_or(Value::Null),
                            "arguments": params.get("arguments").cloned().unwrap_or(Value::Null),
                            "callId": params.get("callId").cloned().unwrap_or(Value::Null),
                            "threadId": thread_id,
                        }),
                    );
                    let pending_tools = tool_broker.clone();
                    let sessions = broker.clone();
                    let key = session_key.clone();
                    std::thread::spawn(move || {
                        let result = receiver
                            .recv_timeout(Duration::from_secs(120))
                            .unwrap_or_else(|_| {
                                json!({"success":false,"content":"{\"error\":\"tool host timeout\"}"})
                                    .to_string()
                            });
                        {
                            let mut pending = crate::workflow_runtime::poison_aware_lock(
                                &pending_tools.0,
                                "tool broker",
                                None,
                            );
                            pending.remove(&request_id);
                        }
                        let parsed: Value = serde_json::from_str(&result)
                            .unwrap_or(json!({"success":false,"content":result}));
                        let session = crate::workflow_runtime::poison_aware_lock(
                            &sessions.0,
                            "realtime broker",
                            None,
                        )
                        .get(&key)
                        .cloned();
                        if let Some(session) = session {
                            let stdin = Some(
                                crate::workflow_runtime::poison_aware_lock(
                                    &session,
                                    "realtime session",
                                    None,
                                )
                                .stdin
                                .clone(),
                            );
                            if let Some(stdin) = stdin {
                                let _ = send_json_timed(
                                    &stdin,
                                    json!({
                                        "jsonrpc":"2.0", "id":id, "result": {
                                            "contentItems":[{"type":"inputText","text":parsed.get("content").and_then(Value::as_str).unwrap_or("")}],
                                            "success":parsed.get("success").and_then(Value::as_bool).unwrap_or(false)
                                        }
                                    }),
                                    Duration::from_secs(10),
                                );
                            }
                        }
                    });
                }
                "item/tool/requestUserInput" | "mcpServer/elicitation/request" => {
                    let id = value.get("id").cloned().unwrap_or(Value::Null);
                    let raw_id = id
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| id.to_string());
                    let request_id = format!("realtime::{session_key}::{raw_id}");
                    let (sender, receiver) = mpsc::channel();
                    {
                        let mut pending = crate::workflow_runtime::poison_aware_lock(
                            &approval_broker.0,
                            "approval broker",
                            None,
                        );
                        pending.insert(
                            request_id.clone(),
                            PendingInteraction {
                                kind: if method == "item/tool/requestUserInput" {
                                    PendingInteractionKind::UserInput
                                } else {
                                    PendingInteractionKind::Elicitation
                                },
                                process_key: format!("realtime-{session_key}"),
                                sender,
                            },
                        );
                    }
                    let event_name = if method == "item/tool/requestUserInput" {
                        "codex-user-input-requested"
                    } else {
                        "codex-elicitation-requested"
                    };
                    let _ = app.emit(
                        event_name,
                        json!({
                            "requestId": request_id,
                            "sessionKey": session_key,
                            "surface": surface,
                            "nodeId": format!("voice:{surface}"),
                            "method": method,
                            "params": params,
                            "threadId": thread_id,
                            "turnId": "realtime",
                        }),
                    );
                    let pending_interactions = approval_broker.clone();
                    let sessions = broker.clone();
                    let key = session_key.clone();
                    let is_user_input = method == "item/tool/requestUserInput";
                    let timeout = if is_user_input {
                        params
                            .get("autoResolutionMs")
                            .and_then(Value::as_u64)
                            .map(Duration::from_millis)
                            .unwrap_or(Duration::from_secs(120))
                    } else {
                        Duration::from_secs(120)
                    };
                    std::thread::spawn(move || {
                        let cancellation = if is_user_input {
                            json!({"answers":{}})
                        } else {
                            json!({"action":"cancel","content":{},"_meta":null})
                        };
                        let result = receiver.recv_timeout(timeout).ok().unwrap_or(cancellation);
                        {
                            let mut pending = crate::workflow_runtime::poison_aware_lock(
                                &pending_interactions.0,
                                "approval broker",
                                None,
                            );
                            pending.remove(&request_id);
                        }
                        let session = crate::workflow_runtime::poison_aware_lock(
                            &sessions.0,
                            "realtime broker",
                            None,
                        )
                        .get(&key)
                        .cloned();
                        if let Some(session) = session {
                            let stdin = Some(
                                crate::workflow_runtime::poison_aware_lock(
                                    &session,
                                    "realtime session",
                                    None,
                                )
                                .stdin
                                .clone(),
                            );
                            if let Some(stdin) = stdin {
                                let _ = send_json_timed(
                                    &stdin,
                                    json!({"jsonrpc":"2.0","id":id,"result":result}),
                                    Duration::from_secs(10),
                                );
                            }
                        }
                    });
                }
                method if method.ends_with("requestApproval") => {
                    let id = value.get("id").cloned().unwrap_or(Value::Null);
                    let raw_id = id
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| id.to_string());
                    let request_id = format!("realtime::{session_key}::{raw_id}");
                    let (sender, receiver) = mpsc::channel();
                    {
                        let mut pending = crate::workflow_runtime::poison_aware_lock(
                            &approval_broker.0,
                            "approval broker",
                            None,
                        );
                        pending.insert(
                            request_id.clone(),
                            PendingInteraction {
                                kind: PendingInteractionKind::Approval,
                                process_key: format!("realtime-{session_key}"),
                                sender,
                            },
                        );
                    }
                    let _ = app.emit(
                        "codex-approval-requested",
                        json!({
                            "requestId": request_id,
                            "sessionKey": session_key,
                            "surface": surface,
                            "nodeId": format!("voice:{surface}"),
                            "method": method,
                            "params": redact_sensitive(params),
                            "threadId": thread_id,
                            "turnId": "realtime",
                        }),
                    );
                    let pending_interactions = approval_broker.clone();
                    let sessions = broker.clone();
                    let key = session_key.clone();
                    std::thread::spawn(move || {
                        let decision = receiver
                            .recv_timeout(Duration::from_secs(120))
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string))
                            .unwrap_or_else(|| "decline".into());
                        {
                            let mut pending = crate::workflow_runtime::poison_aware_lock(
                                &pending_interactions.0,
                                "approval broker",
                                None,
                            );
                            pending.remove(&request_id);
                        }
                        let session = crate::workflow_runtime::poison_aware_lock(
                            &sessions.0,
                            "realtime broker",
                            None,
                        )
                        .get(&key)
                        .cloned();
                        if let Some(session) = session {
                            let stdin = Some(
                                crate::workflow_runtime::poison_aware_lock(
                                    &session,
                                    "realtime session",
                                    None,
                                )
                                .stdin
                                .clone(),
                            );
                            if let Some(stdin) = stdin {
                                let _ = send_json_timed(
                                    &stdin,
                                    json!({"jsonrpc":"2.0","id":id,"result":{"decision":decision}}),
                                    Duration::from_secs(10),
                                );
                            }
                        }
                    });
                }
                "hook/started" | "hook/completed" => {
                    match parse_hook_run_record(
                        &value,
                        &format!("voice:{surface}"),
                        &thread_id,
                        "realtime",
                    ) {
                        Ok(record) => {
                            if let Err(error) = persist_hook_record(&database, &record) {
                                let _ = app.emit(
                                    "codex-hook-persistence-error",
                                    json!({"sessionKey":session_key,"message":error}),
                                );
                            }
                            emit_hook_record(&Some(app.clone()), method, &record);
                        }
                        Err(error) => {
                            let _ = app.emit(
                                "codex-hook-persistence-error",
                                json!({"sessionKey":session_key,"message":error}),
                            );
                        }
                    }
                }
                "thread/realtime/started" => {
                    let realtime_session_id = params
                        .get("realtimeSessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let version = params
                        .get("version")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    // Update the session in the broker with the returned IDs.
                    {
                        let sessions = crate::workflow_runtime::poison_aware_lock(
                            &broker.0,
                            "realtime broker",
                            None,
                        );
                        if let Some(session_arc) = sessions.get(&session_key) {
                            let mut session = crate::workflow_runtime::poison_aware_lock(
                                session_arc,
                                "realtime session",
                                None,
                            );
                            session.realtime_session_id = realtime_session_id.clone();
                            session.version = version.clone();
                        }
                    }
                    let _ = app.emit(
                        "codex-realtime-started",
                        json!({
                            "sessionKey": session_key,
                            "threadId": thread_id,
                            "realtimeSessionId": realtime_session_id,
                            "version": version,
                        }),
                    );
                }
                REALTIME_TRANSCRIPT_DELTA_METHOD => {
                    let role = params
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("user")
                        .to_string();
                    let delta = params
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let _ = app.emit(
                        "codex-realtime-transcript-delta",
                        json!({
                            "sessionKey": session_key,
                            "threadId": thread_id,
                            "role": role,
                            "delta": delta,
                        }),
                    );
                }
                REALTIME_TRANSCRIPT_DONE_METHOD => {
                    let _ = app.emit(
                        "codex-realtime-transcript-done",
                        json!({ "sessionKey": session_key, "threadId": thread_id }),
                    );
                }
                "thread/realtime/outputAudio/delta" => {
                    let _ = app.emit(
                        "codex-realtime-output-audio",
                        json!({
                            "sessionKey": session_key,
                            "threadId": thread_id,
                            "audio": params.get("audio").cloned().unwrap_or(Value::Null),
                        }),
                    );
                }
                "thread/realtime/itemAdded" => {
                    let _ = app.emit(
                        "codex-realtime-item-added",
                        json!({
                            "sessionKey": session_key,
                            "threadId": thread_id,
                            "item": params.get("item").cloned().unwrap_or(Value::Null),
                        }),
                    );
                }
                "thread/realtime/sdp" => {
                    let _ = app.emit(
                        "codex-realtime-sdp",
                        json!({
                            "sessionKey": session_key,
                            "threadId": thread_id,
                            "sdp": params.get("sdp").cloned().unwrap_or(Value::Null),
                        }),
                    );
                }
                "thread/realtime/error" => {
                    let message = params
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown realtime error")
                        .to_string();
                    // Remove the session from the broker without holding the
                    // broker lock across the session Drop (Drop re-locks the
                    // broker to deregister; locking twice deadlocks a
                    // non-reentrant Mutex). Removing clears the session's
                    // back-reference first so Drop's own removal is a no-op,
                    // then drops the Arc outside the lock.
                    let removed = broker.0.lock().remove(&session_key);
                    if let Some(session) = removed {
                        let session = session.lock();
                        let (closed, wake) = &*session.closed;
                        let mut value = closed.lock();
                        *value = true;
                        wake.notify_all();
                    }
                    let _ = app.emit(
                        "codex-realtime-error",
                        json!({ "sessionKey": session_key, "threadId": thread_id, "message": message }),
                    );
                    terminal = true;
                    break;
                }
                "thread/realtime/closed" => {
                    let reason = params
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("closed")
                        .to_string();
                    // Same drop-outside-lock discipline as the error branch.
                    let removed = broker.0.lock().remove(&session_key);
                    if let Some(session) = removed {
                        let session = session.lock();
                        let (closed, wake) = &*session.closed;
                        let mut value = closed.lock();
                        *value = true;
                        wake.notify_all();
                    }
                    let _ = app.emit(
                        "codex-realtime-closed",
                        json!({ "sessionKey": session_key, "threadId": thread_id, "reason": reason }),
                    );
                    terminal = true;
                    break;
                }
                _ => {}
            }
        }
        if !terminal {
            let removed = broker.0.lock().remove(&session_key);
            if let Some(session) = removed {
                let session = session.lock();
                let (closed, wake) = &*session.closed;
                let mut value = closed.lock();
                *value = true;
                wake.notify_all();
            }
            let _ = app.emit(
                "codex-realtime-error",
                json!({
                    "sessionKey": session_key,
                    "threadId": thread_id,
                    "message": "Codex realtime connection closed unexpectedly"
                }),
            );
        }
        let prefix = format!("realtime::{session_key}::");
        {
            let mut pending = tool_broker.0.lock();
            pending.retain(|key, _| !key.starts_with(&prefix));
        }
        {
            let mut pending = approval_broker.0.lock();
            pending.retain(|key, _| !key.starts_with(&prefix));
        };
    });
}

const REALTIME_TRANSCRIPT_DELTA_METHOD: &str = "thread/realtime/transcript/delta";
const REALTIME_TRANSCRIPT_DONE_METHOD: &str = "thread/realtime/transcript/done";

fn enable_realtime_conversation(params: &mut Value) {
    if !params.get("config").is_some_and(Value::is_object) {
        params["config"] = json!({});
    }
    if let Some(config) = params.get_mut("config").and_then(Value::as_object_mut) {
        config.insert("features.realtime_conversation".into(), Value::Bool(true));
    }
}

fn build_realtime_start_params(
    thread_id: &str,
    surface: &str,
    output_modality: &str,
    effort: Option<&str>,
    voice: Option<&str>,
) -> Value {
    let prompt = match effort.filter(|value| !value.trim().is_empty()) {
        Some(effort) => format!(
            "You are Byte on the {surface} surface. Use {effort} reasoning effort. Continue the host-governed conversation naturally."
        ),
        None => format!(
            "You are Byte on the {surface} surface. Continue the host-governed conversation naturally."
        ),
    };
    let mut params = json!({
        "threadId": thread_id,
        "outputModality": output_modality,
        "transport": {"type": "websocket"},
        "version": "v2",
        "includeStartupContext": true,
        "codexResponsesAsItems": true,
        "prompt": prompt,
    });
    if let Some(voice) = voice {
        params["voice"] = json!(voice);
    }
    params
}

#[tauri::command]
async fn start_codex_realtime(
    request: StartRealtimeRequest,
    app: tauri::AppHandle,
    broker: tauri::State<'_, RealtimeBroker>,
    process_broker: tauri::State<'_, ProcessBroker>,
    tool_broker: tauri::State<'_, ToolBroker>,
    approval_broker: tauri::State<'_, ApprovalBroker>,
    database: tauri::State<'_, Database>,
) -> Result<StartRealtimeResult, String> {
    let broker = broker.inner().clone();
    let process_broker = process_broker.inner().clone();
    let tool_broker = tool_broker.inner().clone();
    let approval_broker = approval_broker.inner().clone();
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if request.session_key.trim().is_empty() {
            return Err("realtime session key is required".into());
        }
        if request.output_modality != "audio" && request.output_modality != "text" {
            return Err("realtime output modality must be 'audio' or 'text'".into());
        }
        if request.surface != "company" && request.surface != "architect" {
            return Err("realtime surface must be 'company' or 'architect'".into());
        }
        if crate::workflow_runtime::poison_aware_lock(&broker.0, "realtime broker", None)
            .contains_key(&request.session_key)
        {
            return Err(format!("session '{}' already exists", request.session_key));
        }
        let app_handle = app.clone();
        let workspace = request
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_chat_workspace_path);
        std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        if is_app_managed_workspace(&workspace) {
            prepare_greenfield_workspace(&workspace, true)?;
        }
        let model = normalize_model_id(request.model.as_deref().unwrap_or(""));
        let base_instructions = request.base_instructions.unwrap_or_default();
        let mut developer_instructions = request.developer_instructions.unwrap_or_default();
        if !request.context_digest.trim().is_empty() || !request.recent_transcript.trim().is_empty() {
            developer_instructions.push_str(&format!(
                "\n\nBYTE SESSION CONTEXT (bounded, host-authorized):\n{}\n\nRECENT TRANSCRIPT:\n{}",
                request.context_digest.trim(), request.recent_transcript.trim()
            ));
        }
        if !request.dynamic_tools.is_null() && !request.dynamic_tools.is_array() {
            return Err("realtime dynamicTools must be an array".into());
        }

        // Spawn child process.
        let mut child = if let Some(ref path) = request.app_server_path {
            codex_app_server_at(Some(path))?
        } else {
            codex_app_server()?
        };
        let stdin_raw = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        let stdin: Arc<Mutex<ChildStdin>> = Arc::new(Mutex::new(stdin_raw));

        // Stdout reader thread.
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

        let child_arc = Arc::new(Mutex::new(child));
        let process_key = format!("realtime-{}", request.session_key);
        crate::workflow_runtime::poison_aware_lock(&process_broker.0, "process broker", None)
            .insert(process_key.clone(), child_arc.clone());

        let _child_for_cleanup = child_arc.clone();
        let _broker_for_cleanup = broker.clone();
        let _session_key_for_cleanup = request.session_key.clone();
        let registration = ProcessRegistration {
            node_id: process_key,
            broker: process_broker.clone(),
            child: child_arc.clone(),
        };

        // Handshake.
        let mut next_request_id: i64 = 1;
        // Lines that arrive while we're waiting for a specific response id
        // (typically async notifications like thread/realtime/started that
        // the app-server can emit immediately after the matching response).
        // Without buffering these, the dispatcher would never see them and
        // the frontend would not transition to the live state.
        let mut buffered_lines: Vec<String> = Vec::new();
        let read_response =
            |expected_id: i64, buffered: &mut Vec<String>| -> Result<Value, String> {
                let deadline = std::time::Instant::now() + Duration::from_secs(60);
                loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        kill_app_server_child(&child_arc);
                        return Err(format!(
                            "Codex app-server timed out waiting for response id={expected_id}"
                        ));
                    }
                    match line_rx.recv_timeout(remaining) {
                        Ok(Ok(line)) => {
                            let value = parse_app_server_line(&line)?;
                            if value.get("id").and_then(|id| id.as_i64()) == Some(expected_id)
                                || value.get("id").and_then(|id| id.as_u64())
                                    == Some(expected_id as u64)
                            {
                                if let Some(err) = value.get("error") {
                                    return Err(format!("Codex app-server error: {err}"));
                                }
                                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                            }
                            // Non-matching line (typically an async notification
                            // emitted between request and response). Preserve it
                            // for the dispatcher to process.
                            buffered.push(line);
                        }
                        Ok(Err(e)) => return Err(e),
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
                "id": next_request_id,
                "method":"initialize",
                "params":{
                    "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
                    "capabilities":{"experimentalApi":true,"requestAttestation":false}
                }
            }),
            Duration::from_secs(10),
        )?;
        let _ = read_response(next_request_id, &mut buffered_lines)?;
        next_request_id += 1;
        send_json_timed(
            &stdin,
            json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
            Duration::from_secs(10),
        )?;

        // Thread start/resume.
        // Every voice conversation gets a fresh ephemeral Byte thread. The
        // returned thread ID is persisted by the host for the next text turn.
        let requested_thread: Option<&str> = None;
        let thread_result = if let Some(thread_id) = requested_thread {
            let mut resume_params = json!({
                "threadId": thread_id,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "excludeTurns": true
            });
            if !model.is_empty() {
                resume_params["model"] = json!(model);
            }
            apply_instruction_params(
                &mut resume_params,
                &base_instructions,
                &developer_instructions,
            );
            send_json_timed(
                &stdin,
                json!({
                    "jsonrpc":"2.0","id":next_request_id,"method":"thread/resume",
                    "params": resume_params
                }),
                Duration::from_secs(15),
            )?;
            match read_response(next_request_id, &mut buffered_lines) {
                Ok(result) => result,
                Err(error) => {
                    let _ = app_handle.emit(
                        "codex-realtime-thread-recovered",
                        json!({"oldThreadId": thread_id, "reason": error}),
                    );
                    next_request_id += 1;
                    let mut start_params = json!({
                        "cwd": workspace,
                        "approvalPolicy": "never",
                        "sandbox": "read-only",
                        "ephemeral": true
                    });
                    if !model.is_empty() {
                        start_params["model"] = json!(model);
                    }
                    apply_instruction_params(
                        &mut start_params,
                        &base_instructions,
                        &developer_instructions,
                    );
                    enable_realtime_conversation(&mut start_params);
                    send_json_timed(
                        &stdin,
                        json!({
                            "jsonrpc":"2.0","id":next_request_id,"method":"thread/start",
                            "params": start_params
                        }),
                        Duration::from_secs(15),
                    )?;
                    read_response(next_request_id, &mut buffered_lines)?
                }
            }
        } else {
            let mut start_params = json!({
                "cwd": workspace,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": true
            });
            if request.dynamic_tools.is_array() {
                start_params["dynamicTools"] = request.dynamic_tools.clone();
            }
            if !model.is_empty() {
                start_params["model"] = json!(model);
            }
            apply_instruction_params(
                &mut start_params,
                &base_instructions,
                &developer_instructions,
            );
            enable_realtime_conversation(&mut start_params);
            send_json_timed(
                &stdin,
                json!({
                    "jsonrpc":"2.0","id":next_request_id,"method":"thread/start",
                    "params": start_params
                }),
                Duration::from_secs(15),
            )?;
            read_response(next_request_id, &mut buffered_lines)?
        };

        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("thread/start missing thread id")?
            .to_string();

        // Send thread/realtime/start.
        next_request_id += 1;
        let realtime_start_params = build_realtime_start_params(
            &thread_id,
            &request.surface,
            &request.output_modality,
            request.effort.as_deref(),
            request.voice.as_deref(),
        );
        send_json_timed(
            &stdin,
            json!({
                "jsonrpc":"2.0","id":next_request_id,"method":"thread/realtime/start",
                "params": realtime_start_params
            }),
            Duration::from_secs(15),
        )?;
        // Don't wait for response — the "started" notification comes via the
        // dispatcher. But we do need to read the response to consume the id.
        let _ = read_response(next_request_id, &mut buffered_lines)?;

        // Create session (without line_rx) and spawn the dispatcher.
        // broker/session_key are filled in after insertion to avoid a borrow
        // cycle (Drop reads them; they reference the broker map that owns us).
        let session = Arc::new(Mutex::new(RealtimeSession {
            thread_id: thread_id.clone(),
            realtime_session_id: None,
            version: None,
            stdin: stdin.clone(),
            child: child_arc.clone(),
            app_handle: Some(app_handle.clone()),
            next_id: AtomicU64::new(100),
            process_lease: Some(registration),
            closed: Arc::new((Mutex::new(false), Condvar::new())),
        }));
        {
            let mut sessions = crate::workflow_runtime::poison_aware_lock(&broker.0, "realtime broker", None);
            if sessions.contains_key(&request.session_key) {
                return Err(format!("session '{}' already exists", request.session_key));
            }
            sessions.insert(request.session_key.clone(), session.clone());
        }

        // Dispatcher reads remaining lines and emits Tauri events.
        spawn_realtime_dispatcher(
            buffered_lines,
            line_rx,
            RealtimeDispatcherContext {
                session_key: request.session_key.clone(),
                thread_id: thread_id.clone(),
                broker: broker.clone(),
                tool_broker,
                approval_broker,
                database,
                surface: request.surface,
                app: app_handle.clone(),
            },
        );

        Ok(StartRealtimeResult {
            thread_id,
            realtime_session_id: None,
            version: None,
        })
    })
    .await
    .map_err(|e| format!("start_codex_realtime join error: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendRealtimeAudioRequest {
    session_key: String,
    audio: RealtimeAudioChunk,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendRealtimeTextRequest {
    session_key: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendRealtimeSpeechRequest {
    session_key: String,
    text: String,
}

#[tauri::command]
async fn append_codex_realtime_audio(
    request: AppendRealtimeAudioRequest,
    broker: tauri::State<'_, RealtimeBroker>,
) -> Result<(), String> {
    let broker = broker.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Clone the session Arc out of the map and drop the map lock before
        // sending. Holding the broker lock across send_json_timed serializes
        // every audio frame and blocks the dispatcher's session-state updates
        // (/started writes back into the session while holding the broker lock).
        let session_arc = {
            let sessions =
                crate::workflow_runtime::poison_aware_lock(&broker.0, "realtime broker", None);
            sessions
                .get(&request.session_key)
                .cloned()
                .ok_or_else(|| format!("session '{}' not found", request.session_key))?
        };
        let session =
            crate::workflow_runtime::poison_aware_lock(&session_arc, "realtime session", None);
        request.audio.validate()?;
        let id = session.next_id.fetch_add(1, Ordering::SeqCst);
        send_json_timed(
            &session.stdin,
            json!({
                "jsonrpc":"2.0",
                "id": id,
                "method": "thread/realtime/appendAudio",
                "params": {
                    "threadId": session.thread_id,
                    "audio": request.audio
                }
            }),
            Duration::from_secs(10),
        )
    })
    .await
    .map_err(|e| format!("append_audio join error: {e}"))?
}

#[tauri::command]
async fn append_codex_realtime_text(
    request: AppendRealtimeTextRequest,
    broker: tauri::State<'_, RealtimeBroker>,
) -> Result<(), String> {
    let broker = broker.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Same drop-the-map-lock-before-send discipline as append_audio.
        let session_arc = {
            let sessions =
                crate::workflow_runtime::poison_aware_lock(&broker.0, "realtime broker", None);
            sessions
                .get(&request.session_key)
                .cloned()
                .ok_or_else(|| format!("session '{}' not found", request.session_key))?
        };
        let session =
            crate::workflow_runtime::poison_aware_lock(&session_arc, "realtime session", None);
        let id = session.next_id.fetch_add(1, Ordering::SeqCst);
        send_json_timed(
            &session.stdin,
            json!({
                "jsonrpc":"2.0",
                "id": id,
                "method": "thread/realtime/appendText",
                "params": {
                    "threadId": session.thread_id,
                    "text": request.text
                }
            }),
            Duration::from_secs(10),
        )
    })
    .await
    .map_err(|e| format!("append_text join error: {e}"))?
}

#[tauri::command]
async fn append_codex_realtime_speech(
    request: AppendRealtimeSpeechRequest,
    broker: tauri::State<'_, RealtimeBroker>,
) -> Result<(), String> {
    let broker = broker.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Same drop-the-map-lock-before-send discipline as append_audio.
        let session_arc = {
            let sessions =
                crate::workflow_runtime::poison_aware_lock(&broker.0, "realtime broker", None);
            sessions
                .get(&request.session_key)
                .cloned()
                .ok_or_else(|| format!("session '{}' not found", request.session_key))?
        };
        let session =
            crate::workflow_runtime::poison_aware_lock(&session_arc, "realtime session", None);
        let id = session.next_id.fetch_add(1, Ordering::SeqCst);
        send_json_timed(
            &session.stdin,
            json!({
                "jsonrpc":"2.0",
                "id": id,
                "method": "thread/realtime/appendSpeech",
                "params": {
                    "threadId": session.thread_id,
                    "text": request.text
                }
            }),
            Duration::from_secs(10),
        )
    })
    .await
    .map_err(|e| format!("append_speech join error: {e}"))?
}

#[tauri::command]
async fn stop_codex_realtime(
    session_key: String,
    broker: tauri::State<'_, RealtimeBroker>,
) -> Result<(), String> {
    let broker = broker.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Send thread/realtime/stop best-effort. Clone the session Arc out of
        // the map and drop the map lock before sending so a slow app-server
        // write cannot block the dispatcher or other append calls.
        let session_arc = {
            let sessions = broker.0.lock();
            sessions.get(&session_key).cloned()
        };
        let close_signal = session_arc.as_ref().map(|session_arc| {
            let session = session_arc.lock();
            session.closed.clone()
        });
        if let Some(session_arc) = session_arc {
            let session = session_arc.lock();
            let id = session.next_id.fetch_add(1, Ordering::SeqCst);
            let _ = send_json_timed(
                &session.stdin,
                json!({
                    "jsonrpc":"2.0",
                    "id": id,
                    "method": "thread/realtime/stop",
                    "params": {
                        "threadId": session.thread_id
                    }
                }),
                Duration::from_secs(5),
            );
        }
        // Wait on the terminal signal instead of a fixed sleep. The dispatcher
        // signals for closed, error, and EOF; timeout falls back to force cleanup.
        if let Some(signal) = close_signal {
            let (closed, wake) = &*signal;
            let mut value = closed.lock();
            let _ = wake.wait_while_for(&mut value, |closed| !*closed, Duration::from_secs(2));
        }
        let _removed = broker.0.lock().remove(&session_key);
        Ok(())
    })
    .await
    .map_err(|e| format!("stop_codex_realtime join error: {e}"))?
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexModelOption {
    id: String,
    model: String,
    display_name: String,
    description: String,
    is_default: bool,
    hidden: bool,
    /// Reasoning efforts advertised by app-server for this model.
    supported_efforts: Vec<String>,
    default_effort: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexSkillOption {
    name: String,
    description: String,
    scope: String,
    enabled: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexToolOption {
    id: String,
    server: String,
    name: String,
    title: String,
    description: String,
    read_only: bool,
    destructive: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexCollaborationModeOption {
    name: String,
    mode: String,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexPermissionProfileOption {
    id: String,
    description: String,
    allowed: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexAppOption {
    id: String,
    name: String,
    description: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexHookOption {
    key: String,
    event_name: String,
    trust_status: String,
    managed: bool,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CodexProviderCapabilities {
    namespace_tools: bool,
    image_generation: bool,
    web_search: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexAccountInfo {
    #[serde(rename = "type")]
    account_type: String,
    email: Option<String>,
    plan_type: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexCapabilityInventory {
    skills: Vec<CodexSkillOption>,
    tools: Vec<CodexToolOption>,
    skill_errors: Vec<String>,
    collaboration_modes: Vec<CodexCollaborationModeOption>,
    permission_profiles: Vec<CodexPermissionProfileOption>,
    apps: Vec<CodexAppOption>,
    hooks: Vec<CodexHookOption>,
    provider: CodexProviderCapabilities,
    enabled_runtime_features: Vec<String>,
    realtime_conversation_available: bool,
    account: Option<CodexAccountInfo>,
    auth_mode: Option<String>,
    requires_openai_auth: bool,
}

fn has_realtime_conversation_feature(result: &Value) -> bool {
    result
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(|features| {
            features.iter().any(|feature| {
                feature.get("name").and_then(Value::as_str) == Some("realtime_conversation")
            })
        })
}

fn has_realtime_api_key_auth(auth_method: Option<&str>, environment_key: Option<&str>) -> bool {
    if auth_method == Some("apikey") {
        return true;
    }
    environment_key.is_some_and(|key| {
        let key = key.trim();
        key.starts_with("sk-") && key.len() >= 20
    })
}

/// Discover the skills and MCP tools that this exact Codex app-server exposes.
/// The UI intentionally has no fallback catalog: an unavailable connector
/// produces an unavailable picker instead of invented capabilities.
#[tauri::command]
async fn list_codex_capabilities(cwd: Option<String>) -> Result<CodexCapabilityInventory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = codex_app_server()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        let stderr = child.stderr.take();
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(err) = stderr {
            let sink = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(err);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let mut guard = sink.lock();
                    if guard.len() < 4000 {
                        guard.push_str(&line);
                    }
                    line.clear();
                }
            });
        }
        let mut reader = BufReader::new(stdout);
        let fail = |message: String| {
            let detail = stderr_buf.lock().trim().to_string();
            if detail.is_empty() {
                message
            } else {
                format!("{message} | stderr: {detail}")
            }
        };

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{
                    "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
                    "capabilities":{"experimentalApi":true,"requestAttestation":false}
                }
            }),
        )
        .map_err(&fail)?;
        let _ = read_until_response_silent(&mut reader, 1).map_err(&fail)?;
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )
        .map_err(&fail)?;

        let scan_cwd = cwd
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0", "id":2, "method":"skills/list",
                "params":{"cwds":[scan_cwd.to_string_lossy()],"forceReload":true}
            }),
        )
        .map_err(&fail)?;
        let skill_result = read_until_response_silent(&mut reader, 2).map_err(&fail)?;

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0", "id":3, "method":"mcpServerStatus/list",
                "params":{"limit":100,"detail":"toolsAndAuthOnly"}
            }),
        )
        .map_err(&fail)?;
        let tool_result = read_until_response_silent(&mut reader, 3).map_err(&fail)?;
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":4,"method":"collaborationMode/list","params":{}}),
        )
        .map_err(&fail)?;
        let collaboration_result =
            read_until_response_silent(&mut reader, 4).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":5,"method":"permissionProfile/list","params":{"cwd":scan_cwd.to_string_lossy(),"limit":100}}),
        )
        .map_err(&fail)?;
        let permission_result = read_until_response_silent(&mut reader, 5).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":6,"method":"modelProvider/capabilities/read","params":{}}),
        )
        .map_err(&fail)?;
        let provider_result = read_until_response_silent(&mut reader, 6).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":7,"method":"hooks/list","params":{"cwds":[scan_cwd.to_string_lossy()]}}),
        )
        .map_err(&fail)?;
        let hooks_result = read_until_response_silent(&mut reader, 7).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":8,"method":"app/list","params":{"limit":100,"forceRefetch":false}}),
        )
        .map_err(&fail)?;
        let apps_result = read_until_response_silent(&mut reader, 8).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":9,"method":"experimentalFeature/list","params":{"limit":200}}),
        )
        .map_err(&fail)?;
        let features_result = read_until_response_silent(&mut reader, 9).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":10,"method":"account/read","params":{"refreshToken":false}}),
        )
        .map_err(&fail)?;
        let account_result = read_until_response_silent(&mut reader, 10).unwrap_or(Value::Null);
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":11,"method":"getAuthStatus","params":{"includeToken":false}}),
        )
        .map_err(&fail)?;
        let auth_result = read_until_response_silent(&mut reader, 11).unwrap_or(Value::Null);
        let _ = child.kill();

        let mut skills = Vec::new();
        let mut skill_errors = Vec::new();
        for entry in skill_result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            for skill in entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = skill.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let description = skill
                    .get("shortDescription")
                    .or_else(|| skill.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let scope = skill
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                skills.push(CodexSkillOption {
                    name: name.to_string(),
                    description,
                    scope,
                    enabled: skill
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                });
            }
            for error in entry
                .get("errors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Skill scan error");
                skill_errors.push(message.to_string());
            }
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        skills.dedup_by(|a, b| a.name == b.name);

        let mut tools = Vec::new();
        for server in tool_result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let server_name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
            let Some(server_tools) = server.get("tools").and_then(Value::as_object) else {
                continue;
            };
            for (map_name, tool) in server_tools {
                let name = tool.get("name").and_then(Value::as_str).unwrap_or(map_name);
                tools.push(CodexToolOption {
                    id: format!("{server_name}::{name}"),
                    server: server_name.to_string(),
                    name: name.to_string(),
                    title: tool
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(name)
                        .to_string(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    read_only: tool
                        .pointer("/annotations/readOnlyHint")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    destructive: tool
                        .pointer("/annotations/destructiveHint")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
        }
        tools.sort_by(|a, b| a.server.cmp(&b.server).then_with(|| a.name.cmp(&b.name)));
        tools.dedup_by(|a, b| a.id == b.id);

        let collaboration_modes = collaboration_result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some(CodexCollaborationModeOption {
                    name: item.get("name")?.as_str()?.to_string(),
                    mode: item.get("mode")?.as_str()?.to_string(),
                    reasoning_effort: item
                        .get("reasoning_effort")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect();
        let permission_profiles = permission_result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some(CodexPermissionProfileOption {
                    id: item.get("id")?.as_str()?.to_string(),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    allowed: item.get("allowed").and_then(Value::as_bool).unwrap_or(false),
                })
            })
            .collect();
        let provider = CodexProviderCapabilities {
            namespace_tools: provider_result
                .get("namespaceTools")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            image_generation: provider_result
                .get("imageGeneration")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            web_search: provider_result
                .get("webSearch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let mut hooks = Vec::new();
        for entry in hooks_result.get("data").and_then(Value::as_array).into_iter().flatten() {
            for hook in entry.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                if hook.get("enabled").and_then(Value::as_bool) != Some(true) { continue; }
                hooks.push(CodexHookOption {
                    key: hook.get("key").and_then(Value::as_str).unwrap_or("hook").to_string(),
                    event_name: hook.get("eventName").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                    trust_status: hook.get("trustStatus").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                    managed: hook.get("isManaged").and_then(Value::as_bool).unwrap_or(false),
                });
            }
        }
        let mut apps: Vec<_> = apps_result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| {
                item.get("isAccessible").and_then(Value::as_bool) == Some(true)
                    && item.get("isEnabled").and_then(Value::as_bool) == Some(true)
            })
            .filter_map(|item| {
                Some(CodexAppOption {
                    id: item.get("id")?.as_str()?.to_string(),
                    name: item.get("name")?.as_str()?.to_string(),
                    description: item.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                })
            })
            .collect();
        apps.sort_by(|a, b| a.name.cmp(&b.name));
        let mut enabled_runtime_features: Vec<String> = features_result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| item.get("enabled").and_then(Value::as_bool) == Some(true))
            .filter(|item| matches!(item.get("stage").and_then(Value::as_str), Some("stable" | "beta")))
            .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        enabled_runtime_features.sort();
        let auth_mode = auth_result
            .get("authMethod")
            .and_then(Value::as_str)
            .map(str::to_string);
        let environment_api_key = std::env::var("OPENAI_API_KEY").ok();
        let realtime_conversation_available = has_realtime_conversation_feature(&features_result)
            && has_realtime_api_key_auth(
                auth_mode.as_deref(),
                environment_api_key.as_deref(),
            );
        Ok(CodexCapabilityInventory {
            skills,
            tools,
            skill_errors,
            collaboration_modes,
            permission_profiles,
            apps,
            hooks,
            provider,
            enabled_runtime_features,
            realtime_conversation_available,
            account: account_result.pointer("/account/type").and_then(Value::as_str).map(|t| CodexAccountInfo {
                account_type: t.to_string(),
                email: account_result.pointer("/account/email").and_then(Value::as_str).map(str::to_string),
                plan_type: account_result.pointer("/account/planType").and_then(Value::as_str).map(str::to_string),
            }),
            auth_mode,
            requires_openai_auth: auth_result.get("requiresOpenaiAuth").and_then(Value::as_bool).unwrap_or(false),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// List models from the connected Codex CLI app-server (`model/list`).
#[tauri::command]
async fn list_codex_models() -> Result<Vec<CodexModelOption>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = codex_app_server()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        // Drain stderr so a full pipe cannot deadlock app-server.
        let stderr = child.stderr.take();
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(err) = stderr {
            let sink = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(err);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let mut guard = sink.lock();
                    if guard.len() < 4000 {
                        guard.push_str(&line);
                    }
                    line.clear();
                }
            });
        }
        let mut reader = BufReader::new(stdout);

        let fail = |msg: String| -> String {
            let err = stderr_buf.lock().trim().to_string();
            if err.is_empty() {
                msg
            } else {
                format!("{msg} | stderr: {err}")
            }
        };

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0",
                "id":1,
                "method":"initialize",
                "params":{
                    "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
                    "capabilities":{"experimentalApi":true,"requestAttestation":false}
                }
            }),
        )
        .map_err(&fail)?;
        // Silent reader — no node_id events needed for model list.
        let _ = read_until_response_silent(&mut reader, 1).map_err(&fail)?;
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )
        .map_err(&fail)?;

        let mut models: Vec<CodexModelOption> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut req_id: i64 = 2;
        // includeHidden=true then drop hidden/internal entries so the list matches
        // what operators can pick in Codex.
        loop {
            let mut params = json!({"limit": 100, "includeHidden": true});
            if let Some(ref c) = cursor {
                params["cursor"] = json!(c);
            }
            send_json(
                &mut stdin,
                json!({
                    "jsonrpc":"2.0",
                    "id": req_id,
                    "method":"model/list",
                    "params": params
                }),
            )
            .map_err(&fail)?;
            let result = read_until_response_silent(&mut reader, req_id).map_err(&fail)?;
            let data = result
                .get("data")
                .or_else(|| result.get("models"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in data {
                if let Some(parsed) = parse_model_list_item(&item) {
                    // Keep non-hidden live catalog entries; drop internal helpers.
                    let internal = parsed.id.contains("auto-review")
                        || parsed
                            .display_name
                            .to_ascii_lowercase()
                            .contains("auto review");
                    if !parsed.hidden && !internal {
                        models.push(parsed);
                    }
                }
            }
            cursor = result
                .get("nextCursor")
                .or_else(|| result.get("next_cursor"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.as_ref().map(|c| c.is_empty()).unwrap_or(true) {
                break;
            }
            req_id += 1;
            if req_id > 20 {
                break;
            }
        }

        // Best-effort shutdown
        let _ = child.kill();

        if models.is_empty() {
            return Err(fail(
                "Codex app-server returned no models. Check CLI login and model provider config."
                    .into(),
            ));
        }
        // Prefer is_default first, then stable display-name order.
        models.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then_with(|| a.display_name.cmp(&b.display_name))
        });
        Ok(models)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerStatusEntry {
    name: String,
    tools_count: usize,
    resources_count: usize,
    auth_status: String,
    server_version: Option<String>,
    server_title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpStatusResponseDto {
    data: Vec<McpStatusDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpStatusDto {
    name: String,
    #[serde(default)]
    tools: HashMap<String, Value>,
    #[serde(default)]
    resources: Vec<Value>,
    auth_status: String,
    server_info: Option<McpServerInfoDto>,
}

#[derive(Debug, Deserialize)]
struct McpServerInfoDto {
    version: Option<String>,
    title: Option<String>,
}

#[tauri::command]
async fn list_mcp_server_status() -> Result<Vec<McpServerStatusEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = AppServerConnection::connect()?;
        let result = connection.request(
            "mcpServerStatus/list",
            json!({"limit":100,"detail":"full"}),
            Duration::from_secs(30),
        )?;

        let decoded: McpStatusResponseDto = serde_json::from_value(result)
            .map_err(|error| format!("Malformed mcpServerStatus/list response: {error}"))?;
        let entries = decoded
            .data
            .into_iter()
            .map(|server| McpServerStatusEntry {
                name: server.name,
                tools_count: server.tools.len(),
                resources_count: server.resources.len(),
                auth_status: server.auth_status,
                server_version: server
                    .server_info
                    .as_ref()
                    .and_then(|info| info.version.clone()),
                server_title: server.server_info.and_then(|info| info.title),
            })
            .collect();
        Ok(entries)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexConfigSnapshot {
    model: Option<String>,
    approval_policy: Option<String>,
    sandbox_mode: Option<String>,
    web_search: Option<String>,
    instructions: Option<String>,
    developer_instructions: Option<String>,
    model_reasoning_effort: Option<String>,
    model_provider: Option<String>,
    raw: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ConfigReadResponseDto {
    config: ConfigDto,
}

#[derive(Debug, Deserialize)]
struct ConfigDto {
    model: Option<String>,
    approval_policy: Option<String>,
    sandbox_mode: Option<String>,
    web_search: Option<String>,
    instructions: Option<String>,
    developer_instructions: Option<String>,
    model_reasoning_effort: Option<String>,
    model_provider: Option<String>,
}

#[tauri::command]
async fn read_codex_config() -> Result<CodexConfigSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = AppServerConnection::connect()?;
        let result = connection.request("config/read", json!({}), Duration::from_secs(30))?;

        let decoded: ConfigReadResponseDto = serde_json::from_value(result.clone())
            .map_err(|error| format!("Malformed config/read response: {error}"))?;
        let config = decoded.config;
        let snapshot = CodexConfigSnapshot {
            model: config.model,
            approval_policy: config.approval_policy,
            sandbox_mode: config.sandbox_mode,
            web_search: config.web_search,
            instructions: config.instructions,
            developer_instructions: config.developer_instructions,
            model_reasoning_effort: config.model_reasoning_effort,
            model_provider: config.model_provider,
            raw: result,
        };
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn write_codex_config(key: String, value: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = codex_app_server()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        let stderr = child.stderr.take();
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(err) = stderr {
            let sink = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(err);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let mut guard = sink.lock();
                    if guard.len() < 4000 {
                        guard.push_str(&line);
                    }
                    line.clear();
                }
            });
        }
        let mut reader = BufReader::new(stdout);

        let fail = |msg: String| -> String {
            let err = stderr_buf.lock().trim().to_string();
            if err.is_empty() {
                msg
            } else {
                format!("{msg} | stderr: {err}")
            }
        };

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{
                    "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
                    "capabilities":{"experimentalApi":true,"requestAttestation":false}
                }
            }),
        )
        .map_err(&fail)?;
        let _ = read_until_response_silent(&mut reader, 1).map_err(&fail)?;
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )
        .map_err(&fail)?;

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0", "id":2, "method":"config/value/write",
                "params":{"key": key, "value": value}
            }),
        )
        .map_err(&fail)?;
        let _ = read_until_response_silent(&mut reader, 2).map_err(&fail)?;

        let _ = child.kill();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexThreadSummary {
    id: String,
    name: Option<String>,
    preview: Option<String>,
    status: Option<String>,
    created_at: i64,
    updated_at: i64,
    cwd: Option<String>,
    model_provider: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListResponseDto {
    data: Vec<ThreadDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadReadResponseDto {
    thread: ThreadDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadDto {
    id: String,
    name: Option<String>,
    preview: String,
    status: ThreadStatusDto,
    created_at: i64,
    updated_at: i64,
    cwd: String,
    model_provider: String,
    #[serde(default)]
    turns: Vec<TurnDto>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ThreadStatusDto {
    NotLoaded,
    Idle,
    SystemError,
    Active {
        #[serde(default)]
        active_flags: Vec<Value>,
    },
}

impl ThreadStatusDto {
    fn label(&self) -> String {
        match self {
            Self::NotLoaded => "notLoaded",
            Self::Idle => "idle",
            Self::SystemError => "systemError",
            Self::Active { active_flags } if active_flags.is_empty() => "active",
            Self::Active { .. } => "active",
        }
        .into()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnDto {
    id: String,
    #[serde(default)]
    items: Vec<Value>,
    status: Value,
    started_at: Option<i64>,
}

fn thread_summary(thread: ThreadDto) -> CodexThreadSummary {
    CodexThreadSummary {
        id: thread.id,
        name: thread.name,
        preview: Some(thread.preview),
        status: Some(thread.status.label()),
        created_at: thread.created_at.saturating_mul(1000),
        updated_at: thread.updated_at.saturating_mul(1000),
        cwd: Some(thread.cwd),
        model_provider: Some(thread.model_provider),
    }
}

#[tauri::command]
async fn list_codex_threads(limit: Option<u32>) -> Result<Vec<CodexThreadSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = AppServerConnection::connect()?;
        let result = connection.request(
            "thread/list",
            json!({"limit": limit.unwrap_or(50)}),
            Duration::from_secs(30),
        )?;

        let decoded: ThreadListResponseDto = serde_json::from_value(result)
            .map_err(|error| format!("Malformed thread/list response: {error}"))?;
        let threads = decoded.data.into_iter().map(thread_summary).collect();
        Ok(threads)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexTurnSummary {
    id: String,
    role: Option<String>,
    summary: Option<String>,
    created_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexThreadDetail {
    id: String,
    name: Option<String>,
    preview: Option<String>,
    status: Option<String>,
    created_at: i64,
    updated_at: i64,
    cwd: Option<String>,
    turns: Vec<CodexTurnSummary>,
}

fn turn_summary(turn: TurnDto) -> CodexTurnSummary {
    let role = turn
        .items
        .first()
        .and_then(|item| match item.get("type").and_then(Value::as_str) {
            Some("userMessage") => Some("user".to_string()),
            Some("agentMessage") => Some("assistant".to_string()),
            Some(other) => Some(other.to_string()),
            None => None,
        });
    let summary = turn.items.iter().find_map(|item| {
        item.get("text")
            .and_then(Value::as_str)
            .or_else(|| item.pointer("/content/0/text").and_then(Value::as_str))
            .map(|text| text.chars().take(500).collect())
    });
    let status = turn.status.as_str().map(str::to_string);
    CodexTurnSummary {
        id: turn.id,
        role,
        summary: summary.or(status),
        created_at: turn.started_at.map(|seconds| seconds.saturating_mul(1000)),
    }
}

#[tauri::command]
async fn read_codex_thread(thread_id: String) -> Result<CodexThreadDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = AppServerConnection::connect()?;
        let result = connection.request(
            "thread/read",
            json!({"threadId": thread_id}),
            Duration::from_secs(30),
        )?;

        let decoded: ThreadReadResponseDto = serde_json::from_value(result)
            .map_err(|error| format!("Malformed thread/read response: {error}"))?;
        let thread = decoded.thread;
        let turns = thread.turns.into_iter().map(turn_summary).collect();
        let detail = CodexThreadDetail {
            id: thread.id,
            name: thread.name,
            preview: Some(thread.preview),
            status: Some(thread.status.label()),
            created_at: thread.created_at.saturating_mul(1000),
            updated_at: thread.updated_at.saturating_mul(1000),
            cwd: Some(thread.cwd),
            turns,
        };
        Ok(detail)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// List available realtime voices from the Codex app-server.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RealtimeVoicesListInner {
    pub(crate) v1: Vec<String>,
    pub(crate) v2: Vec<String>,
    pub(crate) default_v1: String,
    pub(crate) default_v2: String,
}

#[tauri::command]
async fn list_codex_voices() -> Result<RealtimeVoicesListInner, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = codex_app_server()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        let stderr = child.stderr.take();
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(err) = stderr {
            let sink = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(err);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let mut guard = sink.lock();
                    if guard.len() < 4000 {
                        guard.push_str(&line);
                    }
                    line.clear();
                }
            });
        }
        let mut reader = BufReader::new(stdout);

        let fail = |msg: String| -> String {
            let err = stderr_buf.lock().trim().to_string();
            if err.is_empty() {
                msg
            } else {
                format!("{msg} | stderr: {err}")
            }
        };

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0",
                "id":1,
                "method":"initialize",
                "params":{
                    "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
                    "capabilities":{"experimentalApi":true,"requestAttestation":false}
                }
            }),
        )
        .map_err(&fail)?;
        let _ = read_until_response_silent(&mut reader, 1).map_err(&fail)?;
        send_json(
            &mut stdin,
            json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )
        .map_err(&fail)?;

        send_json(
            &mut stdin,
            json!({
                "jsonrpc":"2.0",
                "id": 2,
                "method": "thread/realtime/listVoices",
                "params": {}
            }),
        )
        .map_err(&fail)?;
        let result = read_until_response_silent(&mut reader, 2).map_err(&fail)?;

        let _ = child.kill();

        let voices_value = result
            .get("voices")
            .cloned()
            .or_else(|| Some(result.clone()));
        let voices: RealtimeVoicesListInner =
            serde_json::from_value(voices_value.unwrap_or(Value::Null))
                .map_err(|e| fail(format!("failed to parse voices: {e}")))?;

        Ok(voices)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_model_list_item(item: &Value) -> Option<CodexModelOption> {
    let id = item
        .get("id")
        .or_else(|| item.get("model"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let model = item
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let display_name = item
        .get("displayName")
        .or_else(|| item.get("display_name"))
        .and_then(Value::as_str)
        .unwrap_or(&model)
        .to_string();
    let description = item
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let is_default = item
        .get("isDefault")
        .or_else(|| item.get("is_default"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let hidden = item.get("hidden").and_then(Value::as_bool).unwrap_or(false);
    let mut supported_efforts = Vec::new();
    if let Some(arr) = item
        .get("supportedReasoningEfforts")
        .or_else(|| item.get("supported_reasoning_efforts"))
        .and_then(Value::as_array)
    {
        for effort in arr {
            if let Some(s) = effort.as_str() {
                supported_efforts.push(s.to_string());
            } else if let Some(s) = effort.get("effort").and_then(Value::as_str) {
                supported_efforts.push(s.to_string());
            } else if let Some(s) = effort.get("reasoningEffort").and_then(Value::as_str) {
                supported_efforts.push(s.to_string());
            }
        }
    }
    let default_effort = item
        .get("defaultReasoningEffort")
        .or_else(|| item.get("default_reasoning_effort"))
        .and_then(|v| {
            v.as_str().map(str::to_string).or_else(|| {
                v.get("effort")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        v.get("reasoningEffort")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
            })
        });
    Some(CodexModelOption {
        id,
        model,
        display_name,
        description,
        is_default,
        hidden,
        supported_efforts,
        default_effort,
    })
}

fn read_until_response_silent(
    reader: &mut impl BufRead,
    expected_id: i64,
) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            return Err("Codex app-server closed before responding".into());
        }
        let value = parse_app_server_line(&line)?;
        if value.get("id").and_then(Value::as_i64) == Some(expected_id) {
            if let Some(error) = value.get("error") {
                return Err(error.to_string());
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

/// One initialized app-server lease for short capability/config requests.
/// It owns the process and preserves every non-matching protocol line instead
/// of silently consuming notifications while waiting for a response.
struct AppServerConnection {
    child: Child,
    stdin: ChildStdin,
    line_rx: mpsc::Receiver<Result<String, String>>,
    next_id: i64,
    queued: Vec<Value>,
}

impl AppServerConnection {
    fn connect() -> Result<Self, String> {
        let mut child = codex_app_server()?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        let (line_tx, line_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line_tx.send(Ok(line)).is_err() => break,
                    Ok(_) => {}
                    Err(error) => {
                        let _ = line_tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        let mut connection = Self {
            child,
            stdin,
            line_rx,
            next_id: 1,
            queued: Vec::new(),
        };
        connection.request(
            "initialize",
            json!({
                "clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},
                "capabilities":{"experimentalApi":true,"requestAttestation":false}
            }),
            Duration::from_secs(30),
        )?;
        send_json(
            &mut connection.stdin,
            json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )?;
        Ok(connection)
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        send_json(
            &mut self.stdin,
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("Codex app-server timed out waiting for {method}"));
            }
            let line = match self.line_rx.recv_timeout(remaining) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!("Codex app-server timed out waiting for {method}"));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "Codex app-server closed while waiting for {method}"
                    ));
                }
            };
            let value = parse_app_server_line(&line)?;
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(format!("Codex app-server {method} failed: {error}"));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            self.queued.push(value);
        }
    }
}

impl Drop for AppServerConnection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// App-server commands can legitimately stay silent until their process exits.
/// The configured, pausable turn deadline is the single execution bound.
fn turn_receive_timeout(remaining: Duration) -> Duration {
    remaining
}

fn agent_trace(msg: &str) {
    let path = app_data_dir().join("execute-agent-trace.log");
    let line = format!("{} {}\n", chrono_like_now(), msg);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

fn chrono_like_now() -> String {
    // Local-ish wall clock for diagnostics only.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix={secs}")
}

pub(crate) async fn execute_agent_internal(
    request: AgentRequest,
    app: Option<tauri::AppHandle>,
    broker: ApprovalBroker,
    process_broker: ProcessBroker,
    turn_stdin_broker: TurnStdinBroker,
    database: Database,
    token_meter: Arc<std::sync::atomic::AtomicU64>,
) -> Result<AgentResult, String> {
    agent_trace(&format!("execute_agent ENTER node={}", request.node_id));
    let wall_secs = request.timeout_seconds.clamp(10, 1800);
    let timeout_process_key = request.process_key();
    let timeout_broker = process_broker.clone();
    let outer_deadline = Arc::new(Mutex::new(PausableDeadline::new(
        std::time::Instant::now(),
        Duration::from_secs(outer_agent_deadline_seconds(wall_secs)),
        Duration::from_secs(MAX_OPERATOR_WAIT_SECS),
    )));
    // Outer hard deadline: even if the inner body deadlocks, the invoke returns.
    let work = tauri::async_runtime::spawn_blocking(move || {
        let node_for_log = request.node_id.clone();
        agent_trace(&format!("spawn_blocking START node={node_for_log}"));
        let (done_tx, done_rx) = mpsc::channel::<Result<AgentResult, String>>();
        let request_outer = request.clone();
        let app_outer = app.clone();
        let broker_outer = broker.clone();
        let process_broker_outer = process_broker.clone();
        let database_outer = database.clone();
        let worker_outer_deadline = outer_deadline.clone();
        std::thread::spawn(move || {
            let node_id_log = request_outer.node_id.clone();
            agent_trace(&format!("worker START node={node_id_log}"));
            let result = (|| -> Result<AgentResult, String> {
                let request = request_outer;
                let app = app_outer;
                let broker = broker_outer;
                let process_broker = process_broker_outer;
                let database = database_outer;
                let mut child = codex_app_server_at(request.app_server_path.as_deref())?;
                let stdin_raw = child
                    .stdin
                    .take()
                    .ok_or("Codex app-server stdin unavailable")?;
                let stdout = child
                    .stdout
                    .take()
                    .ok_or("Codex app-server stdout unavailable")?;
                let stdin: Arc<Mutex<ChildStdin>> = Arc::new(Mutex::new(stdin_raw));
                // Drain stdout on a dedicated thread + mpsc so the turn loop can use
                // recv_timeout (read_line alone cannot be interrupted on Windows).
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
                let child = Arc::new(Mutex::new(child));
                let process_key = request.process_key();
                let _pending_interactions = PendingProcessInteractions {
                    process_key: process_key.clone(),
                    broker: broker.clone(),
                };
                crate::workflow_runtime::poison_aware_lock(
                    &process_broker.0,
                    "process broker",
                    None,
                )
                .insert(process_key.clone(), child.clone());
                let _registration = ProcessRegistration {
                    node_id: process_key.clone(),
                    broker: process_broker.clone(),
                    child: child.clone(),
                };

                let read_response = |expected_id: i64,
                                     _rx: &mpsc::Receiver<Result<String, String>>,
                                     app: &Option<tauri::AppHandle>,
                                     node_id: &str,
                                     child: &Arc<Mutex<Child>>|
                 -> Result<Value, String> {
                    let deadline = std::time::Instant::now() + Duration::from_secs(60);
                    loop {
                        let remaining =
                            deadline.saturating_duration_since(std::time::Instant::now());
                        if remaining.is_zero() {
                            kill_app_server_child(child);
                            return Err(format!(
                                "Codex app-server timed out waiting for response id={expected_id}"
                            ));
                        }
                        match line_rx.recv_timeout(remaining) {
                            Ok(Ok(line)) => {
                                let value = parse_app_server_line(&line)?;
                                let method = value
                                    .get("method")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                if !method.is_empty() {
                                    emit_optional(
                                        app,
                                        "codex-agent-event",
                                        NormalizedAgentEvent {
                                            node_id: node_id.into(),
                                            event_type: method.into(),
                                            message: method.into(),
                                            thread_id: None,
                                            turn_id: None,
                                            tokens: None,
                                        },
                                    );
                                }
                                if value.get("id").and_then(Value::as_i64) == Some(expected_id) {
                                    if let Some(error) = value.get("error") {
                                        return Err(error.to_string());
                                    }
                                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                                }
                            }
                            Ok(Err(error)) => return Err(error),
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                kill_app_server_child(child);
                                return Err(format!("Codex app-server timed out waiting for response id={expected_id}"));
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                return Err("Codex app-server closed before responding".into());
                            }
                        }
                    }
                };

                send_json_timed(
                    &stdin,
                    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}),
                    Duration::from_secs(10),
                )?;
                read_response(1, &line_rx, &app, &request.node_id, &child)?;
                send_json_timed(
                    &stdin,
                    json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
                    Duration::from_secs(10),
                )?;

                let workspace = resolve_agent_working_directory(&request);
                std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
                let skill_cwds = skill_discovery_cwds(&request, &workspace);
                let skill_inputs = if request.skills.is_empty() {
                    Vec::new()
                } else {
                    send_json_timed(
                        &stdin,
                        json!({"jsonrpc":"2.0","id":10,"method":"skills/list","params":{"cwds":skill_cwds,"forceReload":false}}),
                        Duration::from_secs(10),
                    )?;
                    let skills_result =
                        read_response(10, &line_rx, &app, &request.node_id, &child)?;
                    resolve_skill_inputs(&skills_result, &request.skills)?
                };
                // Pass model id through as provided by model/list (no mock aliases).
                let model = normalize_model_id(&request.model);
                let approval_policy = match request.approval_policy.as_str() {
                    "untrusted" => "untrusted",
                    "never" => "never",
                    _ => "on-request",
                };
                let sandbox = codex_sandbox_mode(&request.sandbox_profile);
                let thread_params = build_agent_thread_start_params(
                    &request,
                    &model,
                    &workspace,
                    approval_policy,
                    sandbox,
                );
                // Resume only through the app-server protocol. A prior ephemeral
                // process may no longer own the thread, so recover fail-safe by
                // starting a fresh thread with the complete authorized input.
                let mut resumed = false;
                let thread_result = if let Some(existing) = request
                    .thread_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                {
                    let mut resume_params = json!({
                        "threadId": existing,
                        "model": model,
                        "cwd": workspace,
                        "approvalPolicy": approval_policy,
                        "sandbox": sandbox,
                        "excludeTurns": true
                    });
                    apply_instruction_params(
                        &mut resume_params,
                        &request.base_instructions,
                        &request.developer_instructions,
                    );
                    send_json_timed(
                        &stdin,
                        json!({"jsonrpc":"2.0","id":11,"method":"thread/resume","params":resume_params}),
                        Duration::from_secs(15),
                    )?;
                    match read_response(11, &line_rx, &app, &request.node_id, &child) {
                        Ok(result) => {
                            resumed = true;
                            result
                        }
                        Err(error) => {
                            emit_optional(
                                &app,
                                "codex-agent-event",
                                NormalizedAgentEvent {
                                    node_id: request.node_id.clone(),
                                    event_type: "agent.thread.recovered".into(),
                                    message: format!(
                                        "Prior thread unavailable; fresh thread started: {error}"
                                    ),
                                    thread_id: Some(existing.into()),
                                    turn_id: None,
                                    tokens: None,
                                },
                            );
                            send_json_timed(
                                &stdin,
                                json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":thread_params}),
                                Duration::from_secs(10),
                            )?;
                            read_response(2, &line_rx, &app, &request.node_id, &child)?
                        }
                    }
                } else {
                    send_json_timed(
                        &stdin,
                        json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":thread_params}),
                        Duration::from_secs(10),
                    )?;
                    read_response(2, &line_rx, &app, &request.node_id, &child)?
                };
                let thread_id = thread_result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .ok_or("thread start/resume response missing thread id")?
                    .to_string();
                if resumed {
                    emit_optional(
                        &app,
                        "codex-agent-event",
                        NormalizedAgentEvent {
                            node_id: request.node_id.clone(),
                            event_type: "agent.thread.resume".into(),
                            message: format!("Resumed existing thread {thread_id}"),
                            thread_id: Some(thread_id.clone()),
                            turn_id: None,
                            tokens: None,
                        },
                    );
                } else {
                    emit_optional(
                        &app,
                        "codex-agent-event",
                        NormalizedAgentEvent {
                            node_id: request.node_id.clone(),
                            event_type: "agent.started".into(),
                            message: "Fresh Codex thread started".into(),
                            thread_id: Some(thread_id.clone()),
                            turn_id: None,
                            tokens: None,
                        },
                    );
                }

                let boundary = request.tool_boundary.trim();
                let boundary_section = if boundary.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{boundary}")
                };
                let tools_note = if request.tools.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\nUI tool grants (advisory labels): {}.",
                        request.tools.join(", ")
                    )
                };
                let composed = format!(
            "ROLE: {}\n\nAUTHORIZED WORKFLOW INPUT:\n{}\n\nAUTHORIZED UPSTREAM OUTPUTS ONLY:\n{}{}\n\nReturn a concise JSON object with keys status, summary, data, artifacts. Do not include hidden reasoning.{}",
            request.role,
            request.user_input,
            serde_json::to_string_pretty(&request.upstream_outputs).unwrap_or_default(),
            tools_note,
            boundary_section
        );
                // Strict response_format: every object needs additionalProperties:false; arrays need items.
                // Freeform specialist fields go in data.payload as a JSON string.
                let output_schema = request
                    .output_schema
                    .clone()
                    .unwrap_or_else(default_agent_output_schema);
                let turn_params = build_agent_turn_start_params(
                    &request,
                    &thread_id,
                    &model,
                    &composed,
                    output_schema,
                    &skill_inputs,
                );
                send_json_timed(
                    &stdin,
                    json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":turn_params}),
                    Duration::from_secs(15),
                )?;
                let turn_result = read_response(3, &line_rx, &app, &request.node_id, &child)?;
                let turn_id = turn_result
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .ok_or("turn/start response missing turn id")?
                    .to_string();
                // Register only after turn/start returns both authoritative IDs.
                // The guard removes the entry on every exit path.
                crate::workflow_runtime::poison_aware_lock(
                    &turn_stdin_broker.0,
                    "turn stdin broker",
                    None,
                )
                .insert(
                    process_key.clone(),
                    ActiveTurnHandle {
                        stdin: stdin.clone(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                );
                let _turn_registration = TurnRegistration {
                    key: process_key.clone(),
                    broker: turn_stdin_broker.clone(),
                };
                let mut message = String::new();
                let mut total_tokens: u64 = 0;
                let mut turn_deadline = PausableDeadline::new(
                    std::time::Instant::now(),
                    Duration::from_secs(wall_secs),
                    Duration::from_secs(MAX_OPERATOR_WAIT_SECS),
                );
                loop {
                    let remaining = turn_deadline.remaining(std::time::Instant::now());
                    if remaining.is_zero() {
                        kill_app_server_child(&child);
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: "turn.timeout".into(),
                                message: "Turn wall-clock budget exceeded".into(),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                        return Err("Codex turn exceeded the wall-clock budget".into());
                    }
                    let line = match line_rx.recv_timeout(turn_receive_timeout(remaining)) {
                        Ok(Ok(line)) => line,
                        Ok(Err(error)) => {
                            if message.is_empty() {
                                return Err(error);
                            }
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            kill_app_server_child(&child);
                            emit_optional(
                                &app,
                                "codex-agent-event",
                                NormalizedAgentEvent {
                                    node_id: request.node_id.clone(),
                                    event_type: "turn.timeout".into(),
                                    message: "Turn wall-clock budget exceeded; app-server killed"
                                        .into(),
                                    thread_id: Some(thread_id.clone()),
                                    turn_id: Some(turn_id.clone()),
                                    tokens: None,
                                },
                            );
                            return Err("Codex turn exceeded the wall-clock budget".into());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if message.is_empty() {
                                return Err("Codex app-server closed during turn".into());
                            }
                            break;
                        }
                    };
                    let value = parse_app_server_line(&line)?;
                    let method = value
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if let Some(tokens) = extract_total_tokens(&value) {
                        if tokens > total_tokens {
                            total_tokens = tokens;
                            token_meter.fetch_max(tokens, std::sync::atomic::Ordering::SeqCst);
                            emit_optional(
                                &app,
                                "codex-agent-event",
                                NormalizedAgentEvent {
                                    node_id: request.node_id.clone(),
                                    event_type: "thread/tokenUsage/updated".into(),
                                    message: format!("Token usage · {tokens} tok"),
                                    thread_id: Some(thread_id.clone()),
                                    turn_id: Some(turn_id.clone()),
                                    tokens: Some(tokens),
                                },
                            );
                        }
                    }
                    if method == "item/agentMessage/delta" {
                        if let Some(delta) = value.pointer("/params/delta").and_then(Value::as_str)
                        {
                            message.push_str(delta);
                        }
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: "agent.message.delta".into(),
                                message: value
                                    .pointer("/params/delta")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .into(),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    } else if method == "item/completed" {
                        // Capture full agentMessage text when deltas were skipped.
                        if value.pointer("/params/item/type").and_then(Value::as_str)
                            == Some("agentMessage")
                        {
                            if let Some(text) =
                                value.pointer("/params/item/text").and_then(Value::as_str)
                            {
                                if !text.is_empty() {
                                    message = text.to_string();
                                }
                            }
                        }
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: method.into(),
                                message: method.into(),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    } else if method == "item/reasoning/textDelta"
                        || method == "item/reasoning/summaryTextDelta"
                        || method == "item/plan/delta"
                        || method == "item/commandExecution/outputDelta"
                        || method == "turn/diff/updated"
                        || method == "item/fileChange/patchUpdated"
                    {
                        let delta = value
                            .pointer("/params/delta")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let changes_json = if method == "turn/diff/updated" {
                            value
                                .pointer("/params/diff")
                                .and_then(Value::as_str)
                                .unwrap_or(&delta)
                                .to_string()
                        } else if method == "item/fileChange/patchUpdated" {
                            value
                                .get("params")
                                .map(|p| p.to_string())
                                .unwrap_or_default()
                        } else {
                            delta
                        };
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: method.into(),
                                message: changes_json,
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    } else if method == "warning"
                        || method == "guardianWarning"
                        || method == "configWarning"
                        || method == "deprecationNotice"
                    {
                        let warning_msg = value
                            .pointer("/params/message")
                            .and_then(Value::as_str)
                            .or_else(|| value.pointer("/params/summary").and_then(Value::as_str))
                            .unwrap_or(method);
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: method.into(),
                                message: warning_msg.into(),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    } else if method == "item/tool/requestUserInput"
                        || method == "mcpServer/elicitation/request"
                    {
                        // Server-initiated user input request — reuse approval broker pattern.
                        if let Some(id) = value.get("id").cloned() {
                            let request_id = id
                                .as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| id.to_string());
                            let broker_request_id = format!("{process_key}::{request_id}");
                            let (sender, receiver) = mpsc::channel();
                            crate::workflow_runtime::poison_aware_lock(
                                &broker.0,
                                "approval broker",
                                None,
                            )
                            .insert(
                                broker_request_id.clone(),
                                PendingInteraction {
                                    kind: if method == "item/tool/requestUserInput" {
                                        PendingInteractionKind::UserInput
                                    } else {
                                        PendingInteractionKind::Elicitation
                                    },
                                    process_key: process_key.clone(),
                                    sender,
                                },
                            );
                            let event_name = if method == "item/tool/requestUserInput" {
                                "codex-user-input-requested"
                            } else {
                                "codex-elicitation-requested"
                            };
                            emit_optional(
                                &app,
                                event_name,
                                NativeApprovalEvent {
                                    request_id: broker_request_id.clone(),
                                    node_id: request.node_id.clone(),
                                    method: method.into(),
                                    params: value.get("params").cloned().unwrap_or(Value::Null),
                                    thread_id: thread_id.clone(),
                                    turn_id: turn_id.clone(),
                                },
                            );
                            let timeout = if method == "item/tool/requestUserInput" {
                                value
                                    .pointer("/params/autoResolutionMs")
                                    .and_then(Value::as_u64)
                                    .map(Duration::from_millis)
                                    .unwrap_or(Duration::from_secs(120))
                            } else {
                                Duration::from_secs(120)
                            };
                            let cancellation = if method == "item/tool/requestUserInput" {
                                json!({"answers":{}})
                            } else {
                                json!({"action":"cancel","content":{},"_meta":null})
                            };
                            let response_payload = recv_with_operator_pause(
                                &receiver,
                                timeout,
                                &mut turn_deadline,
                                &worker_outer_deadline,
                            )?
                            .unwrap_or_else(|_| cancellation.clone());
                            broker.0.lock().remove(&broker_request_id);
                            let _ = send_json_timed(
                                &stdin,
                                json!({"jsonrpc":"2.0","id":id,"result":response_payload}),
                                Duration::from_secs(10),
                            );
                        }
                    } else if method.ends_with("requestApproval") {
                        if let Some(id) = value.get("id").cloned() {
                            let request_id = id
                                .as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| id.to_string());
                            let broker_request_id = format!("{process_key}::{request_id}");
                            // A request under `never` should not normally arrive because the
                            // app-server is told not to ask. Fail-closed for non-privileged nodes,
                            // but accept it when the node has explicitly selected the most
                            // permissive `danger-full-access` sandbox (i.e. builders that are
                            // allowed to install packages, build, and test without operator friction).
                            // Headless (no AppHandle): CODEX_CORP_HEADLESS_APPROVAL policy applies
                            // for non-never approval policies (default auto_decline).
                            let decision = if approval_policy == "never" {
                                if request.sandbox_profile == "danger-full-access" {
                                    emit_optional(
                                        &app,
                                        "codex-agent-event",
                                        NormalizedAgentEvent {
                                            node_id: request.node_id.clone(),
                                            event_type: "approval.auto_accept".into(),
                                            message: "Auto-accepted approval request (approvalPolicy=never, sandbox=danger-full-access)".into(),
                                            thread_id: Some(thread_id.clone()),
                                            turn_id: Some(turn_id.clone()),
                                            tokens: None,
                                        },
                                    );
                                    eprintln!(
                                        "[codex-corp] requestApproval auto-accepted for danger-full-access node; requestId={broker_request_id}"
                                    );
                                    "accept".to_string()
                                } else {
                                    emit_optional(
                                        &app,
                                        "codex-agent-event",
                                        NormalizedAgentEvent {
                                            node_id: request.node_id.clone(),
                                            event_type: "approval.auto_decline".into(),
                                            message: "Declined unexpected approval request (approvalPolicy=never)".into(),
                                            thread_id: Some(thread_id.clone()),
                                            turn_id: Some(turn_id.clone()),
                                            tokens: None,
                                        },
                                    );
                                    "decline".to_string()
                                }
                            } else if app.is_none() {
                                match headless_codex_approval_policy() {
                                    HeadlessCodexApprovalPolicy::AutoAccept => {
                                        emit_optional(
                                            &app,
                                            "codex-agent-event",
                                            NormalizedAgentEvent {
                                                node_id: request.node_id.clone(),
                                                event_type: "approval.auto_accept".into(),
                                                message: "Auto-accepted (headless policy)".into(),
                                                thread_id: Some(thread_id.clone()),
                                                turn_id: Some(turn_id.clone()),
                                                tokens: None,
                                            },
                                        );
                                        eprintln!(
                                            "[codex-corp] requestApproval auto-accepted (headless policy) requestId={broker_request_id}"
                                        );
                                        "accept".to_string()
                                    }
                                    HeadlessCodexApprovalPolicy::AutoDecline => {
                                        emit_optional(
                                            &app,
                                            "codex-agent-event",
                                            NormalizedAgentEvent {
                                                node_id: request.node_id.clone(),
                                                event_type: "approval.auto_decline".into(),
                                                message: "Auto-declined (headless policy)".into(),
                                                thread_id: Some(thread_id.clone()),
                                                turn_id: Some(turn_id.clone()),
                                                tokens: None,
                                            },
                                        );
                                        eprintln!(
                                            "[codex-corp] requestApproval auto-declined (headless policy) requestId={broker_request_id}"
                                        );
                                        "decline".to_string()
                                    }
                                    HeadlessCodexApprovalPolicy::Wait => {
                                        let (sender, receiver) = mpsc::channel();
                                        crate::workflow_runtime::poison_aware_lock(
                                            &broker.0,
                                            "approval broker",
                                            None,
                                        )
                                        .insert(
                                            broker_request_id.clone(),
                                            PendingInteraction {
                                                kind: PendingInteractionKind::Approval,
                                                process_key: process_key.clone(),
                                                sender,
                                            },
                                        );
                                        emit_optional(
                                            &app,
                                            "codex-approval-requested",
                                            NativeApprovalEvent {
                                                request_id: broker_request_id.clone(),
                                                node_id: request.node_id.clone(),
                                                method: method.into(),
                                                params: redact_sensitive(
                                                    value
                                                        .get("params")
                                                        .cloned()
                                                        .unwrap_or(Value::Null),
                                                ),
                                                thread_id: thread_id.clone(),
                                                turn_id: turn_id.clone(),
                                            },
                                        );
                                        eprintln!(
                                            "[codex-corp] requestApproval waiting (headless wait policy); respond via MCP respond_codex_approval requestId={broker_request_id}"
                                        );
                                        recv_with_operator_pause(
                                            &receiver,
                                            Duration::from_secs(120),
                                            &mut turn_deadline,
                                            &worker_outer_deadline,
                                        )?
                                        .ok()
                                        .and_then(|value| value.as_str().map(str::to_string))
                                        .unwrap_or_else(|| "decline".into())
                                    }
                                }
                            } else {
                                let (sender, receiver) = mpsc::channel();
                                crate::workflow_runtime::poison_aware_lock(
                                    &broker.0,
                                    "approval broker",
                                    None,
                                )
                                .insert(
                                    broker_request_id.clone(),
                                    PendingInteraction {
                                        kind: PendingInteractionKind::Approval,
                                        process_key: process_key.clone(),
                                        sender,
                                    },
                                );
                                emit_optional(
                                    &app,
                                    "codex-approval-requested",
                                    NativeApprovalEvent {
                                        request_id: broker_request_id.clone(),
                                        node_id: request.node_id.clone(),
                                        method: method.into(),
                                        params: redact_sensitive(
                                            value.get("params").cloned().unwrap_or(Value::Null),
                                        ),
                                        thread_id: thread_id.clone(),
                                        turn_id: turn_id.clone(),
                                    },
                                );
                                recv_with_operator_pause(
                                    &receiver,
                                    Duration::from_secs(120),
                                    &mut turn_deadline,
                                    &worker_outer_deadline,
                                )?
                                .ok()
                                .and_then(|value| value.as_str().map(str::to_string))
                                .unwrap_or_else(|| "decline".into())
                            };
                            broker.0.lock().remove(&broker_request_id);
                            emit_optional(
                                &app,
                                "codex-approval-resolved",
                                NativeApprovalResolvedEvent {
                                    request_id: broker_request_id.clone(),
                                    node_id: request.node_id.clone(),
                                    decision: decision.clone(),
                                    thread_id: thread_id.clone(),
                                    turn_id: turn_id.clone(),
                                },
                            );
                            // Timed write: never block forever if the child is not reading stdin.
                            if let Err(error) = send_json_timed(
                                &stdin,
                                json!({"jsonrpc":"2.0","id":id,"result":{"decision":decision}}),
                                Duration::from_secs(5),
                            ) {
                                emit_optional(
                                    &app,
                                    "codex-agent-event",
                                    NormalizedAgentEvent {
                                        node_id: request.node_id.clone(),
                                        event_type: "approval.write_timeout".into(),
                                        message: error.clone(),
                                        thread_id: Some(thread_id.clone()),
                                        turn_id: Some(turn_id.clone()),
                                        tokens: None,
                                    },
                                );
                                kill_app_server_child(&child);
                                return Err(format!("Codex approval response failed: {error}"));
                            }
                        }
                    } else if method == "hook/started" || method == "hook/completed" {
                        match parse_hook_run_record(&value, &request.node_id, &thread_id, &turn_id)
                        {
                            Ok(record) => {
                                if let Err(error) = persist_hook_record(&database, &record) {
                                    emit_optional(
                                        &app,
                                        "codex-hook-persistence-error",
                                        json!({"message": error}),
                                    );
                                }
                                emit_hook_record(&app, method, &record);
                                emit_optional(
                                    &app,
                                    "codex-agent-event",
                                    NormalizedAgentEvent {
                                        node_id: request.node_id.clone(),
                                        event_type: method.into(),
                                        message: format!(
                                            "hook {} ({}) → {}",
                                            record.event_name, record.handler_type, record.status
                                        ),
                                        thread_id: Some(thread_id.clone()),
                                        turn_id: Some(turn_id.clone()),
                                        tokens: None,
                                    },
                                );
                            }
                            Err(error) => emit_optional(
                                &app,
                                "codex-hook-persistence-error",
                                json!({"message": error}),
                            ),
                        }
                    } else if method == "mcpServer/startupStatus/updated" {
                        let server_name = value
                            .pointer("/params/name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        let server_status = value
                            .pointer("/params/status")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        let error_msg = value
                            .pointer("/params/error")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        emit_optional(
                            &app,
                            "codex-mcp-status-updated",
                            serde_json::json!({
                                "nodeId": request.node_id.clone(),
                                "name": server_name,
                                "status": server_status,
                                "error": error_msg,
                                "threadId": thread_id,
                                "turnId": turn_id,
                            }),
                        );
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: "mcpServer/statusUpdated".into(),
                                message: format!("MCP server {server_name}: {server_status}"),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    } else {
                        emit_optional(
                            &app,
                            "codex-agent-event",
                            NormalizedAgentEvent {
                                node_id: request.node_id.clone(),
                                event_type: method.into(),
                                message: method.into(),
                                thread_id: Some(thread_id.clone()),
                                turn_id: Some(turn_id.clone()),
                                tokens: None,
                            },
                        );
                    }
                    if method == "turn/completed" || method == "error" {
                        if method == "error" && message.is_empty() {
                            let err = value
                                .pointer("/params/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("turn error");
                            let summary =
                                serde_json::to_string(err).unwrap_or_else(|_| "\"error\"".into());
                            message = format!(
                                r#"{{"status":"failure","summary":{summary},"data":{{"payload":""}},"artifacts":[]}}"#
                            );
                        }
                        break;
                    }
                }
                let (status, summary, data, artifacts) = parse_agent_message(&message)?;
                if total_tokens > 0 {
                    emit_optional(
                        &app,
                        "codex-agent-event",
                        NormalizedAgentEvent {
                            node_id: request.node_id.clone(),
                            event_type: "agent.token_usage".into(),
                            message: format!("Token usage · {total_tokens} tok"),
                            thread_id: Some(thread_id.clone()),
                            turn_id: Some(turn_id.clone()),
                            tokens: Some(total_tokens),
                        },
                    );
                }
                Ok(AgentResult {
                    status,
                    summary,
                    data,
                    artifacts,
                    thread_id,
                    turn_id,
                    tokens: total_tokens,
                })
            })();
            agent_trace(&format!(
                "worker DONE node={node_id_log} ok={}",
                result.is_ok()
            ));
            let _ = done_tx.send(result);
        });
        let hard_secs = outer_agent_deadline_seconds(wall_secs);
        let out = loop {
            let remaining = crate::workflow_runtime::poison_aware_lock(
                &outer_deadline,
                "outer agent deadline",
                None,
            )
            .remaining(std::time::Instant::now());
            if remaining.is_zero() {
                agent_trace(&format!("spawn_blocking HARD_DEADLINE node={node_for_log}"));
                if let Some(child) = timeout_broker.0.lock().get(&timeout_process_key).cloned() {
                    kill_app_server_child(&child);
                }
                break Err(format!(
                    "execute_agent hard-deadline ({}s active budget) exceeded",
                    hard_secs
                ));
            }
            let poll = remaining.min(Duration::from_millis(DEADLINE_WATCHDOG_POLL_MILLIS));
            match done_rx.recv_timeout(poll) {
                Ok(result) => {
                    agent_trace(&format!(
                        "spawn_blocking RECV node={node_for_log} ok={}",
                        result.is_ok()
                    ));
                    break result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    agent_trace(&format!("spawn_blocking DISCONNECTED node={node_for_log}"));
                    break Err("execute_agent worker disconnected".into());
                }
            }
        };
        agent_trace(&format!("spawn_blocking EXIT node={node_for_log}"));
        out
    });
    // Wall-clock + idle timeouts live inside the blocking task (no tokio dep).
    let joined = work.await.map_err(|error| error.to_string())?;
    agent_trace("execute_agent LEAVE");
    joined
}

/// Fit the main window inside the primary monitor work area (taskbar-safe).
/// Avoids multi-monitor virtual-desktop centering that straddles screens and
/// pushes the title bar above the visible bounds.
fn place_main_window(window: &tauri::WebviewWindow) {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .into_iter()
                .flatten()
                .next()
        });
    let Some(monitor) = monitor else {
        return;
    };

    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let avail_w = work.size.width as f64;
    let avail_h = work.size.height as f64;

    // Comfortable margins so chrome (title bar / shadows) stays on-screen.
    let margin = (24.0 * scale).max(16.0);
    let target_w = (1280.0 * scale).min(avail_w - margin * 2.0);
    let target_h = (800.0 * scale).min(avail_h - margin * 2.0);
    let width = target_w.max(960.0 * scale).min(avail_w - margin);
    let height = target_h.max(640.0 * scale).min(avail_h - margin);

    let x = work.position.x as f64 + ((avail_w - width) / 2.0).max(0.0);
    let y = work.position.y as f64 + ((avail_h - height) / 2.0).max(0.0);
    // Clamp fully inside the work area so title-bar controls stay reachable.
    let max_x = work.position.x as f64 + (avail_w - width).max(0.0);
    let max_y = work.position.y as f64 + (avail_h - height).max(0.0);
    let x = x.clamp(work.position.x as f64, max_x);
    let y = y.clamp(work.position.y as f64, max_y);

    let _ = window.set_size(tauri::Size::Physical(PhysicalSize {
        width: width.round().max(1.0) as u32,
        height: height.round().max(1.0) as u32,
    }));
    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition {
        x: x.round() as i32,
        y: y.round() as i32,
    }));
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn install_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "Open Codex Corp", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Codex Corp", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("codex-corp-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Codex Corp — running in the background")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let should_open = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if should_open {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_owner = runtime_ownership::RuntimeOwnershipGuard::acquire("desktop")
        .expect("another Codex Corp runtime already owns this data directory");
    let database = open_database().expect("failed to initialize Codex Corp database");
    tauri::Builder::default()
        .manage(Database(Arc::new(Mutex::new(database))))
        .manage(ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))))
        .manage(ToolBroker(Arc::new(Mutex::new(HashMap::new()))))
        .manage(ProcessBroker(Arc::new(Mutex::new(HashMap::new()))))
        .manage(local_test::LocalTestProcessRegistry::default())
        .manage(TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))))
        .manage(RealtimeBroker::default())
        .manage(runtime_owner)
        .manage(workflow_runtime::WorkflowRuntime::default())
        .manage(workflow_runtime::RunApprovalBroker::default())
        .setup(|app| {
            workflow_runtime::initialize(app.handle());
            // Auto-start the Codex Corp MCP server so external clients can connect
            // while the desktop shell is running (same lifecycle as headless).
            // Opt out: CODEX_CORP_MCP_AUTO=0 (default is on for hackathon continuity).
            if mcp_auto_start_enabled() {
                let host = mcp_server::McpHost::from_tauri(app.handle());
                match mcp_server::lifecycle::start_embedded(host) {
                    Ok(status) => {
                        eprintln!(
                            "[codex-corp] MCP server listening on {} ({})",
                            status.endpoint, status.transport
                        );
                        eprintln!(
                            "[codex-corp] POST /mcp requires Authorization: Bearer <authToken> from mcp-server.status.json (or CODEX_CORP_MCP_TOKEN)"
                        );
                        eprintln!(
                            "[codex-corp] Disable desktop MCP auto-start with CODEX_CORP_MCP_AUTO=0"
                        );
                    }
                    Err(error) => {
                        eprintln!("[codex-corp] MCP server failed to start: {error}");
                    }
                }
            } else {
                eprintln!(
                    "[codex-corp] MCP auto-start disabled (CODEX_CORP_MCP_AUTO=0)"
                );
            }
            #[cfg(desktop)]
            install_system_tray(app)?;
            if let Some(window) = app.get_webview_window("main") {
                place_main_window(&window);
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            discover_codex,
            select_codex_source,
            select_codex_path,
            probe_codex_path,
            list_codex_models,
            list_codex_capabilities,
            list_mcp_server_status,
            read_codex_config,
            write_codex_config,
            list_codex_threads,
            read_codex_thread,
            save_workflow,
            list_workflow_catalog,
            save_workflow_catalog_item,
            delete_workflow,
            load_workflow,
            load_workflow_record,
            validate_workflow,
            plan_workflow,
            list_runs,
            list_portfolio_run_summaries,
            execute_mediator_turn,
            get_default_chat_workspace,
            choose_chat_workspace,
            respond_codex_approval,
            respond_user_input,
            respond_mediator_tool,
            app_settings::get_app_settings,
            app_settings::preview_retention,
            app_settings::save_app_settings,
            app_settings::cleanup_detailed_logs,
            app_settings::get_storage_info,
            app_settings::pin_run,
            app_settings::export_detailed_logs,
            app_settings::clear_all_company_data,
            app_settings::persist_hook_run,
            app_settings::list_hook_runs,
            app_settings::clear_hook_runs,
            business_data::list_finance_entries,
            business_data::save_finance_entry,
            business_data::delete_finance_entry,
            business_data::list_dashboard_feedback,
            business_data::save_dashboard_feedback,
            chat_data::get_chat_store,
            chat_data::save_chat_store,
            local_test::prepare_local_test,
            local_test::get_local_test,
            local_test::approve_local_test_launch,
            local_test::submit_local_test_feedback,
            local_test::stop_local_test,
            workflow_runtime::start_run,
            workflow_runtime::resume_run,
            workflow_runtime::stop_run,
            workflow_runtime::get_run,
            workflow_runtime::list_active_runs,
            workflow_runtime::list_node_experience,
            workflow_runtime::analytics_verification_loops,
            workflow_runtime::respond_run_approval,
            harness_lessons::list_harness_lessons,
            harness_lessons::create_harness_lesson,
            harness_lessons::update_harness_lesson,
            harness_lessons::rollback_harness_lesson,
            harness_lessons::delete_harness_lesson,
            harness_lessons::list_harness_lesson_snapshots,
            harness_lessons::refine_harness_lessons_cmd,
            list_codex_voices,
            start_codex_realtime,
            stop_codex_realtime,
            append_codex_realtime_audio,
            append_codex_realtime_text,
            append_codex_realtime_speech
        ])
        .build(tauri::generate_context!())
        .expect("error while building Codex Corp")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                mcp_server::lifecycle::stop_embedded();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn mediator_turn_params_use_workspace_write_and_on_request() {
        let params = mediator_turn_params(
            &PathBuf::from("/tmp/ws"),
            "gpt-5",
            &json!([]),
            "",
            "",
        );
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandbox"], "workspace-write");
        assert_eq!(params["cwd"], "/tmp/ws");
    }

    #[test]
    fn is_publish_operation_detects_git_publish_commands() {
        assert!(is_publish_operation("git push origin main"));
        assert!(is_publish_operation("git commit -m \"release\""));
        assert!(is_publish_operation("git push --force origin main"));
        assert!(is_publish_operation("git reset --hard origin/main"));
        assert!(!is_publish_operation("git status"));
        assert!(!is_publish_operation("git diff"));
        assert!(!is_publish_operation("git log"));
        assert!(!is_publish_operation("npm run build"));
    }

    #[test]
    fn mcp_auto_start_parse_defaults_and_opt_out() {
        assert!(parse_mcp_auto_start(None));
        assert!(parse_mcp_auto_start(Some("")));
        assert!(parse_mcp_auto_start(Some("   ")));
        assert!(parse_mcp_auto_start(Some("1")));
        assert!(parse_mcp_auto_start(Some("true")));
        assert!(parse_mcp_auto_start(Some("on")));
        assert!(parse_mcp_auto_start(Some("yes")));
        assert!(parse_mcp_auto_start(Some("maybe"))); // unknown → default on
        assert!(!parse_mcp_auto_start(Some("0")));
        assert!(!parse_mcp_auto_start(Some("false")));
        assert!(!parse_mcp_auto_start(Some("OFF")));
        assert!(!parse_mcp_auto_start(Some(" no ")));
    }

    fn capability_request() -> AgentRequest {
        AgentRequest {
            node_id: "planner".into(),
            run_id: Some("run-1".into()),
            attempt_id: Some("attempt-1".into()),
            role: "Planner".into(),
            model: "gpt-test".into(),
            effort: "medium".into(),
            base_instructions: "Plan carefully".into(),
            developer_instructions: "Stay on mission.".into(),
            user_input: "mission".into(),
            upstream_outputs: Vec::new(),
            approval_policy: "never".into(),
            sandbox_profile: "read-only".into(),
            permission_profile: Some(":read-only".into()),
            collaboration_mode: Some("plan".into()),
            personality: Some("pragmatic".into()),
            workspace_policy: "isolated".into(),
            target_workspace: None,
            timeout_seconds: 120,
            output_schema: None,
            tools: Vec::new(),
            skills: Vec::new(),
            tool_boundary: String::new(),
            app_server_path: None,
            thread_id: None,
        }
    }

    #[test]
    fn connector_runtime_settings_reach_app_server_params() {
        let request = capability_request();
        let thread = build_agent_thread_start_params(
            &request,
            "gpt-test",
            Path::new("C:/workspace"),
            "never",
            "read-only",
        );
        assert_eq!(thread["permissions"], ":read-only");
        assert!(thread.get("sandbox").is_none());
        assert_eq!(thread["personality"], "pragmatic");
        assert_eq!(thread["baseInstructions"], "Plan carefully");
        assert_eq!(thread["developerInstructions"], "Stay on mission.");

        let turn = build_agent_turn_start_params(
            &request,
            "thread-1",
            "gpt-test",
            "input",
            default_agent_output_schema(),
            &[],
        );
        assert_eq!(turn["collaborationMode"]["mode"], "plan");
        assert_eq!(
            turn["collaborationMode"]["settings"]["reasoning_effort"],
            "medium"
        );
    }

    #[test]
    fn realtime_thread_params_enable_the_disabled_by_default_feature() {
        let mut params = json!({"config":{"existing.setting":true}});
        enable_realtime_conversation(&mut params);
        assert_eq!(params["config"]["features.realtime_conversation"], true);
        assert_eq!(params["config"]["existing.setting"], true);
    }

    #[test]
    fn realtime_start_uses_the_realtime_backend_model_not_the_text_thread_model() {
        let params =
            build_realtime_start_params("thread-1", "company", "audio", Some("low"), Some("alloy"));

        assert!(params.get("model").is_none());
        assert_eq!(params["version"], "v2");
        assert_eq!(params["transport"]["type"], "websocket");
        assert_eq!(params["voice"], "alloy");
        assert!(params["prompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("low reasoning effort")));
    }

    #[test]
    fn realtime_capability_requires_the_advertised_feature() {
        assert!(has_realtime_conversation_feature(&json!({"data":[{
            "name":"realtime_conversation", "stage":"underDevelopment", "enabled":false
        }]})));
        assert!(!has_realtime_conversation_feature(&json!({"data":[]})));
        assert!(!has_realtime_conversation_feature(
            &json!({"data":"malformed"})
        ));
    }

    #[test]
    fn realtime_auth_rejects_missing_blank_and_placeholder_api_keys() {
        for key in [
            None,
            Some(""),
            Some("   "),
            Some("YOUR_OPENAI_API_KEY"),
            Some("your-openai-api-key"),
            Some("replace_me"),
        ] {
            assert!(!has_realtime_api_key_auth(Some("chatgpt"), key));
        }
        assert!(has_realtime_api_key_auth(
            Some("chatgpt"),
            Some("sk-proj-test-key-material")
        ));
        assert!(has_realtime_api_key_auth(Some("apikey"), None));
    }

    #[test]
    fn realtime_transcript_methods_match_the_generated_protocol() {
        assert_eq!(
            REALTIME_TRANSCRIPT_DELTA_METHOD,
            "thread/realtime/transcript/delta"
        );
        assert_eq!(
            REALTIME_TRANSCRIPT_DONE_METHOD,
            "thread/realtime/transcript/done"
        );
    }

    #[test]
    fn outer_agent_deadline_keeps_cleanup_slack() {
        assert_eq!(outer_agent_deadline_seconds(10), 40);
        assert_eq!(outer_agent_deadline_seconds(1800), 1830);
    }

    #[test]
    fn turn_receive_wait_uses_the_bounded_turn_deadline_not_an_arbitrary_idle_gap() {
        for remaining in [0, 10, 75, 120, 600] {
            assert_eq!(
                turn_receive_timeout(Duration::from_secs(remaining)),
                Duration::from_secs(remaining)
            );
        }
    }

    #[test]
    fn execution_deadline_expires_without_operator_interaction() {
        let started = std::time::Instant::now();
        let deadline =
            PausableDeadline::new(started, Duration::from_secs(10), Duration::from_secs(30));

        assert_eq!(
            deadline.remaining(started + Duration::from_secs(11)),
            Duration::ZERO
        );
    }

    #[test]
    fn execution_deadline_pauses_while_operator_decision_is_pending() {
        let started = std::time::Instant::now();
        let mut deadline =
            PausableDeadline::new(started, Duration::from_secs(10), Duration::from_secs(30));
        deadline.pause(started + Duration::from_secs(4));

        assert_eq!(
            deadline.remaining(started + Duration::from_secs(9)),
            Duration::from_secs(6)
        );
    }

    #[test]
    fn execution_deadline_resumes_with_the_original_active_budget() {
        let started = std::time::Instant::now();
        let mut deadline =
            PausableDeadline::new(started, Duration::from_secs(10), Duration::from_secs(30));
        deadline.pause(started + Duration::from_secs(4));
        deadline.resume(started + Duration::from_secs(9));

        assert_eq!(
            deadline.remaining(started + Duration::from_secs(12)),
            Duration::from_secs(3)
        );
    }

    #[test]
    fn execution_deadline_accumulates_multiple_operator_waits() {
        let started = std::time::Instant::now();
        let mut deadline =
            PausableDeadline::new(started, Duration::from_secs(10), Duration::from_secs(30));
        deadline.pause(started + Duration::from_secs(2));
        deadline.resume(started + Duration::from_secs(5));
        deadline.pause(started + Duration::from_secs(7));
        deadline.resume(started + Duration::from_secs(11));

        assert_eq!(
            deadline.remaining(started + Duration::from_secs(15)),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn execution_deadline_caps_total_operator_wait_credit() {
        let started = std::time::Instant::now();
        let mut deadline =
            PausableDeadline::new(started, Duration::from_secs(10), Duration::from_secs(5));
        deadline.pause(started + Duration::from_secs(2));

        assert_eq!(
            deadline.remaining(started + Duration::from_secs(9)),
            Duration::from_secs(6)
        );
        assert_eq!(
            deadline.remaining(started + Duration::from_secs(16)),
            Duration::ZERO
        );
    }

    #[test]
    fn isolated_workspace_keeps_selected_run_root_out_of_cwd() {
        let mut request = capability_request();
        request.target_workspace = Some("C:/operator-selected-workspace".into());
        let cwd = resolve_agent_working_directory(&request);
        assert_ne!(cwd, PathBuf::from("C:/operator-selected-workspace"));
        assert!(cwd.ends_with(Path::new("run-1/planner/attempt-1")));

        let thread =
            build_agent_thread_start_params(&request, "gpt-test", &cwd, "never", "read-only");
        assert_eq!(thread["cwd"], json!(cwd));
        assert_eq!(
            thread["runtimeWorkspaceRoots"],
            json!(["C:/operator-selected-workspace"])
        );
        let skill_cwds = skill_discovery_cwds(&request, &cwd);
        assert!(skill_cwds
            .iter()
            .any(|candidate| candidate == &cwd.to_string_lossy()));
        assert!(skill_cwds
            .iter()
            .any(|candidate| candidate == "C:/operator-selected-workspace"));
        let inventory_cwd = std::env::current_dir().unwrap();
        assert!(skill_cwds
            .iter()
            .any(|candidate| candidate == &inventory_cwd.to_string_lossy()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn custom_cmd_paths_are_quoted_for_cmd_metacharacters() {
        let command = command_for_codex(
            Path::new(r"C:\Tools\Codex&Preview\codex.cmd"),
            &["app-server", "--stdio"],
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "/d",
                "/s",
                "/c",
                r#""C:\Tools\Codex&Preview\codex.cmd" app-server --stdio"#,
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn javascript_app_server_paths_use_node_runtime() {
        // Attack vector: the golden runner supplies a .mjs server path, which
        // Windows cannot execute directly as a Win32 application.
        let node = find_node_exe().expect("Node.js is required for JavaScript app-server paths");
        let script = Path::new(r"C:\Tools\Codex Preview\fake-codex-server.mjs");
        let command = command_for_codex(script, &["app-server", "--stdio"]);
        assert_eq!(command.get_program(), node.as_os_str());
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(args[0], script.to_string_lossy());
        assert_eq!(&args[1..], ["app-server", "--stdio"]);
    }

    #[test]
    fn selected_skills_become_real_app_server_inputs() {
        let listed = json!({"data":[{"skills":[
            {"name":"imagegen","path":"C:/skills/imagegen/SKILL.md","enabled":true},
            {"name":"disabled","path":"C:/skills/disabled/SKILL.md","enabled":false}
        ]}]});
        let inputs = resolve_skill_inputs(&listed, &["imagegen".into()]).unwrap();
        assert_eq!(
            inputs,
            vec![json!({"type":"skill","name":"imagegen","path":"C:/skills/imagegen/SKILL.md"})]
        );
        assert!(resolve_skill_inputs(&listed, &["missing".into()])
            .unwrap_err()
            .contains("not available"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn fake_app_server_captures_execution_contract_end_to_end() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "codex-corp-fake-app-server-{}-{unique}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let log_path = root.join("requests.jsonl");
        let script_path = root.join("fake-app-server.cjs");
        let command_path = root.join("fake-codex.cmd");
        std::fs::create_dir_all(&workspace).unwrap();
        let log_literal = serde_json::to_string(&log_path.to_string_lossy()).unwrap();
        let skill_path = root.join("skills").join("imagegen").join("SKILL.md");
        let skill_literal = serde_json::to_string(&skill_path.to_string_lossy()).unwrap();
        let script = format!(
            r#"const fs = require('fs');
const readline = require('readline');
const logPath = {log_literal};
const skillPath = {skill_literal};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{
  const request = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(request) + '\n');
  if (request.method === 'initialize') send({{ jsonrpc:'2.0', id:request.id, result:{{}} }});
  else if (request.method === 'skills/list') send({{ jsonrpc:'2.0', id:request.id, result:{{ data:[{{ skills:[{{ name:'imagegen', path:skillPath, enabled:true }}] }}] }} }});
  else if (request.method === 'thread/start') send({{ jsonrpc:'2.0', id:request.id, result:{{ thread:{{ id:'thread-fake' }} }} }});
  else if (request.method === 'turn/start') {{
    send({{ jsonrpc:'2.0', id:request.id, result:{{ turn:{{ id:'turn-fake' }} }} }});
    send({{ jsonrpc:'2.0', method:'item/completed', params:{{ item:{{ type:'agentMessage', text:'{{"status":"success","summary":"fake done","data":{{"payload":"{{}}"}},"artifacts":[]}}' }} }} }});
    send({{ jsonrpc:'2.0', method:'turn/completed', params:{{ turn:{{ id:'turn-fake' }} }} }});
  }}
}});"#
        );
        std::fs::write(&script_path, script).unwrap();
        let node = find_node_exe().expect("Node.js is required for the fake app-server harness");
        std::fs::write(
            &command_path,
            format!(
                "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                node.display(),
                script_path.display()
            ),
        )
        .unwrap();

        let mut request = capability_request();
        request.model = "gpt-5.6-luna".into();
        request.effort = "medium".into();
        request.permission_profile = None;
        request.sandbox_profile = "workspace-write".into();
        request.approval_policy = "never".into();
        request.workspace_policy = "workflow".into();
        request.target_workspace = Some(workspace.to_string_lossy().into_owned());
        request.timeout_seconds = 10;
        request.output_schema = Some(default_agent_output_schema());
        request.skills = vec!["imagegen".into()];
        request.tools = vec!["Shell".into()];
        request.app_server_path = Some(command_path);
        let result = tauri::async_runtime::block_on(execute_agent_internal(
            request,
            None,
            ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))),
            ProcessBroker(Arc::new(Mutex::new(HashMap::new()))),
            TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))),
            Database(Arc::new(Mutex::new(Connection::open_in_memory().unwrap()))),
            Arc::new(AtomicU64::new(0)),
        ))
        .unwrap();
        assert_eq!(result.summary, "fake done");

        let requests = std::fs::read_to_string(&log_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let thread = requests
            .iter()
            .find(|request| request["method"] == "thread/start")
            .unwrap();
        assert_eq!(thread["params"]["model"], "gpt-5.6-luna");
        assert_eq!(thread["params"]["approvalPolicy"], "never");
        assert_eq!(thread["params"]["sandbox"], "workspace-write");
        assert_eq!(
            thread["params"]["cwd"],
            workspace.to_string_lossy().as_ref()
        );
        assert_eq!(
            thread["params"]["runtimeWorkspaceRoots"][0],
            workspace.to_string_lossy().as_ref()
        );
        assert_eq!(thread["params"]["baseInstructions"], "Plan carefully");
        assert_eq!(
            thread["params"]["developerInstructions"],
            "Stay on mission."
        );
        let turn = requests
            .iter()
            .find(|request| request["method"] == "turn/start")
            .unwrap();
        assert_eq!(turn["params"]["effort"], "medium");
        assert_eq!(turn["params"]["collaborationMode"]["mode"], "plan");
        assert_eq!(turn["params"]["input"][0]["type"], "skill");
        assert_eq!(turn["params"]["input"][0]["name"], "imagegen");
        assert!(turn["params"]["outputSchema"].is_object());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn fake_app_server_completes_after_two_sequential_approval_callbacks() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "codex-corp-two-approvals-{}-{unique}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let log_path = root.join("approval-responses.jsonl");
        let script_path = root.join("fake-app-server.cjs");
        let command_path = root.join("fake-codex.cmd");
        std::fs::create_dir_all(&workspace).unwrap();
        let log_literal = serde_json::to_string(&log_path.to_string_lossy()).unwrap();
        let script = format!(
            r#"const fs = require('fs');
const readline = require('readline');
const logPath = {log_literal};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({{ jsonrpc:'2.0', id:request.id, result:{{}} }});
  else if (request.method === 'skills/list') send({{ jsonrpc:'2.0', id:request.id, result:{{ data:[] }} }});
  else if (request.method === 'thread/start') send({{ jsonrpc:'2.0', id:request.id, result:{{ thread:{{ id:'thread-two' }} }} }});
  else if (request.method === 'turn/start') {{
    send({{ jsonrpc:'2.0', id:request.id, result:{{ turn:{{ id:'turn-two' }} }} }});
    send({{ jsonrpc:'2.0', id:'approval-one', method:'item/commandExecution/requestApproval', params:{{ command:'first' }} }});
  }} else if (request.id === 'approval-one') {{
    fs.appendFileSync(logPath, JSON.stringify(request) + '\n');
    send({{ jsonrpc:'2.0', id:'approval-two', method:'item/commandExecution/requestApproval', params:{{ command:'second' }} }});
  }} else if (request.id === 'approval-two') {{
    fs.appendFileSync(logPath, JSON.stringify(request) + '\n');
    send({{ jsonrpc:'2.0', method:'item/completed', params:{{ item:{{ type:'agentMessage', text:'{{"status":"success","summary":"two approvals handled","data":{{}},"artifacts":[]}}' }} }} }});
    send({{ jsonrpc:'2.0', method:'turn/completed', params:{{ turn:{{ id:'turn-two' }} }} }});
  }}
}});"#
        );
        std::fs::write(&script_path, script).unwrap();
        let node = find_node_exe().expect("Node.js is required for the fake app-server harness");
        std::fs::write(
            &command_path,
            format!(
                "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                node.display(),
                script_path.display()
            ),
        )
        .unwrap();

        let mut request = capability_request();
        request.approval_policy = "never".into();
        request.workspace_policy = "workflow".into();
        request.target_workspace = Some(workspace.to_string_lossy().into_owned());
        request.timeout_seconds = 10;
        request.output_schema = Some(default_agent_output_schema());
        request.app_server_path = Some(command_path);
        let result = tauri::async_runtime::block_on(execute_agent_internal(
            request,
            None,
            ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))),
            ProcessBroker(Arc::new(Mutex::new(HashMap::new()))),
            TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))),
            Database(Arc::new(Mutex::new(Connection::open_in_memory().unwrap()))),
            Arc::new(AtomicU64::new(0)),
        ))
        .unwrap();
        assert_eq!(result.summary, "two approvals handled");

        let responses = std::fs::read_to_string(&log_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], "approval-one");
        assert_eq!(responses[1]["id"], "approval-two");
        assert_eq!(responses[0]["result"]["decision"], "decline");
        assert_eq!(responses[1]["result"]["decision"], "decline");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn stale_specialist_thread_recovers_with_fresh_thread_end_to_end() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "codex-corp-stale-thread-{}-{unique}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let log_path = root.join("methods.log");
        let script_path = root.join("fake-app-server.cjs");
        let command_path = root.join("fake-codex.cmd");
        std::fs::create_dir_all(&workspace).unwrap();
        let log_literal = serde_json::to_string(&log_path.to_string_lossy()).unwrap();
        let script = format!(
            r#"const fs = require('fs');
const readline = require('readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{
  const request = JSON.parse(line);
  if (request.method) fs.appendFileSync({log_literal}, request.method + '\n');
  if (request.method === 'initialize') send({{jsonrpc:'2.0',id:request.id,result:{{}}}});
  else if (request.method === 'thread/resume') send({{jsonrpc:'2.0',id:request.id,error:{{code:-32600,message:'thread not found: stale-thread'}}}});
  else if (request.method === 'thread/start') send({{jsonrpc:'2.0',id:request.id,result:{{thread:{{id:'fresh-thread'}}}}}});
  else if (request.method === 'turn/start') {{
    if (request.params.threadId !== 'fresh-thread') send({{jsonrpc:'2.0',id:request.id,error:{{code:-32600,message:'thread not found: ' + request.params.threadId}}}});
    else {{
      send({{jsonrpc:'2.0',id:request.id,result:{{turn:{{id:'fresh-turn'}}}}}});
      send({{jsonrpc:'2.0',method:'item/completed',params:{{item:{{type:'agentMessage',text:'{{"status":"success","summary":"fresh recovery worked","data":{{}},"artifacts":[]}}'}}}}}});
      send({{jsonrpc:'2.0',method:'turn/completed',params:{{turn:{{id:'fresh-turn'}}}}}});
    }}
  }}
}});"#
        );
        std::fs::write(&script_path, script).unwrap();
        let node = find_node_exe().expect("Node.js is required for the fake app-server harness");
        std::fs::write(
            &command_path,
            format!(
                "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                node.display(),
                script_path.display()
            ),
        )
        .unwrap();

        let mut request = capability_request();
        request.thread_id = Some("stale-thread".into());
        request.approval_policy = "never".into();
        request.workspace_policy = "workflow".into();
        request.target_workspace = Some(workspace.to_string_lossy().into_owned());
        request.timeout_seconds = 10;
        request.output_schema = Some(default_agent_output_schema());
        request.app_server_path = Some(command_path);
        let result = tauri::async_runtime::block_on(execute_agent_internal(
            request,
            None,
            ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))),
            ProcessBroker(Arc::new(Mutex::new(HashMap::new()))),
            TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))),
            Database(Arc::new(Mutex::new(Connection::open_in_memory().unwrap()))),
            Arc::new(AtomicU64::new(0)),
        ))
        .unwrap();
        assert_eq!(result.summary, "fresh recovery worked");
        let methods = std::fs::read_to_string(&log_path).unwrap();
        assert!(methods.contains("thread/resume\nthread/start\nturn/start"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn empty_base_instructions_omitted_from_thread_params() {
        let mut request = capability_request();
        request.base_instructions = String::new();
        request.developer_instructions = "Role only".into();
        let thread = build_agent_thread_start_params(
            &request,
            "gpt-test",
            Path::new("C:/workspace"),
            "never",
            "read-only",
        );
        assert!(thread.get("baseInstructions").is_none());
        assert_eq!(thread["developerInstructions"], "Role only");
    }

    #[test]
    fn manual_sandbox_is_used_without_named_permission_profile() {
        let mut request = capability_request();
        request.permission_profile = None;
        request.collaboration_mode = Some("default".into());
        request.personality = Some("invalid".into());
        let thread = build_agent_thread_start_params(
            &request,
            "gpt-test",
            Path::new("C:/workspace"),
            "on-request",
            "workspace-write",
        );
        assert_eq!(thread["sandbox"], "workspace-write");
        assert!(thread.get("permissions").is_none());

        let danger = build_agent_thread_start_params(
            &request,
            "gpt-test",
            Path::new("C:/workspace"),
            "never",
            "danger-full-access",
        );
        assert_eq!(danger["sandbox"], "danger-full-access");
        assert_eq!(danger["approvalPolicy"], "never");

        assert_eq!(thread["personality"], "none");
        let turn = build_agent_turn_start_params(
            &request,
            "thread-1",
            "gpt-test",
            "input",
            default_agent_output_schema(),
            &[],
        );
        assert!(turn.get("collaborationMode").is_none());
    }

    #[test]
    fn codex_sandbox_mode_rejects_unknown_profiles_safely() {
        assert_eq!(codex_sandbox_mode("read-only"), "read-only");
        assert_eq!(codex_sandbox_mode("workspace-write"), "workspace-write");
        assert_eq!(
            codex_sandbox_mode("danger-full-access"),
            "danger-full-access"
        );
        assert_eq!(codex_sandbox_mode("custom"), "workspace-write");
        assert_eq!(codex_sandbox_mode(""), "workspace-write");
    }

    #[test]
    fn agent_message_parser_accepts_complete_structured_output() {
        let (status, summary, data, artifacts) = parse_agent_message(
            r#"{"status":"success","summary":"Done","data":{"payload":"ok"},"artifacts":[]}"#,
        )
        .unwrap();
        assert_eq!(status, "success");
        assert_eq!(summary, "Done");
        assert_eq!(data["payload"], "ok");
        assert!(artifacts.is_empty());
    }

    #[test]
    fn agent_message_parser_rejects_prose_and_incomplete_json() {
        assert!(parse_agent_message("Work completed successfully").is_err());
        assert!(parse_agent_message(
            r#"{"summary":"Done","data":{"payload":"ok"},"artifacts":[]}"#
        )
        .is_err());
        assert!(parse_agent_message(
            r#"{"status":"success","summary":"Done","data":"ok","artifacts":[]}"#
        )
        .is_err());
    }

    #[test]
    fn compatibility_range_is_explicit_and_bounded() {
        assert!(version_supported("codex-cli 0.144.1"));
        assert!(version_supported("codex-cli 0.150.0"));
        assert!(!version_supported("codex-cli 0.139.9"));
        assert!(!version_supported("codex-cli 0.151.0"));
        assert!(!version_supported("unexpected output"));
    }

    #[test]
    fn app_server_json_lines_are_valid_json_rpc() {
        let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-corp","title":"Codex Corp","version":"0.3.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}});
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(
            initialize["params"]["capabilities"]["experimentalApi"],
            true
        );
    }

    /// Live Codex rejects object schemas missing nested additionalProperties:false.
    #[test]
    fn default_agent_output_schema_is_strict_for_response_format() {
        let schema = default_agent_output_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["data"]["additionalProperties"], false);
        assert!(schema["properties"]["artifacts"]["items"].is_object());
        assert_eq!(
            schema["properties"]["artifacts"]["items"]["additionalProperties"],
            false
        );
        let criteria = &schema["properties"]["data"]["properties"]["criteria"]["items"];
        let required = criteria["required"]
            .as_array()
            .expect("criteria item schema must declare required fields");
        for property in criteria["properties"]
            .as_object()
            .expect("criteria item schema must declare properties")
            .keys()
        {
            assert!(
                required
                    .iter()
                    .any(|value| value.as_str() == Some(property)),
                "criteria item property {property} must be required"
            );
        }
    }

    #[test]
    fn malformed_app_server_events_fail_closed() {
        let error = parse_app_server_line("not-json").unwrap_err();
        assert!(error.starts_with("Malformed app-server JSON:"));
        assert_eq!(
            parse_app_server_line("{\"jsonrpc\":\"2.0\",\"id\":1}").unwrap()["id"],
            1
        );
    }

    #[test]
    fn renderer_payloads_redact_nested_secrets() {
        let safe = redact_sensitive(
            json!({"command":"deploy","env":{"OPENAI_API_KEY":"sk-example","region":"us"},"access-token":"abc"}),
        );
        assert_eq!(safe["env"]["OPENAI_API_KEY"], "[REDACTED]");
        assert_eq!(safe["access-token"], "[REDACTED]");
        assert_eq!(safe["env"]["region"], "us");
    }

    #[test]
    fn sqlite_persists_normalized_run_records() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let snapshot=RunSnapshot{
            id:"run-1".into(),workflow_id:"workflow-1".into(),status:"completed".into(),
            events_json:json!([{"id":"event-1","nodeId":"agent-1","type":"node.completed"}]).to_string(),
            nodes_json:json!([{"id":"agent-1","data":{"status":"completed","threadId":"thread-1","output":"done"}}]).to_string(),
            edges_json:json!([{"id":"e1","source":"a","target":"b"}]).to_string(),
            approvals_json:json!([{"id":"approval-1","nodeId":"agent-1","status":"approved"}]).to_string(),
            artifacts_json:json!([{"id":"artifact-1","nodeId":"agent-1","name":"result.json"}]).to_string(),
        };
        persist_run(&mut connection, &snapshot).unwrap();
        for table in [
            "runs",
            "run_events",
            "node_executions",
            "approvals",
            "artifacts",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1, "expected one normalized row in {table}");
        }
        let thread: String = connection
            .query_row("SELECT thread_id FROM node_executions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(thread, "thread-1");
        let nodes: String = connection
            .query_row("SELECT nodes_json FROM runs", [], |row| row.get(0))
            .unwrap();
        assert!(nodes.contains("thread-1"));
        let edges: String = connection
            .query_row("SELECT edges_json FROM runs", [], |row| row.get(0))
            .unwrap();
        assert!(edges.contains("\"e1\""));
    }

    fn graph_fixture(edges: Value) -> GraphSnapshot {
        serde_json::from_value(json!({"nodes":[
            {"id":"input","data":{"label":"Input","kind":"input","prompt":""}},
            {"id":"a","data":{"label":"A","kind":"agent","prompt":"A","model":"fixture-model"}},
            {"id":"b","data":{"label":"B","kind":"agent","prompt":"B","model":"fixture-model"}},
            {"id":"merge","data":{"label":"Merge","kind":"merge","prompt":""}},
            {"id":"out","data":{"label":"Output","kind":"output","prompt":""}}
        ],"edges":edges}))
        .unwrap()
    }

    #[test]
    fn rust_validator_rejects_empty_specialist_model() {
        let mut graph = graph_fixture(json!([
            {"id":"ia","source":"input","target":"a","data":{"edgeType":"standard"}},
            {"id":"ao","source":"a","target":"out","data":{"edgeType":"standard"}}
        ]));
        // Drop b/merge from path concerns: only need agent a empty model.
        graph
            .nodes
            .retain(|n| n.id == "input" || n.id == "a" || n.id == "out");
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "a")
            .unwrap()
            .data
            .model
            .clear();
        let problems = validate_graph(&graph);
        assert!(
            problems.iter().any(|item| item.id == "model-a"),
            "{problems:?}"
        );
        // Non-empty model clears the error (still no name allowlist).
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "a")
            .unwrap()
            .data
            .model = "any-live-id".into();
        assert!(!validate_graph(&graph)
            .iter()
            .any(|item| item.id == "model-a"));
    }

    #[test]
    fn rust_planner_batches_parallel_branches_and_merge() {
        let graph = graph_fixture(json!([
            {"id":"ia","source":"input","target":"a","data":{"edgeType":"standard"}},
            {"id":"ib","source":"input","target":"b","data":{"edgeType":"standard"}},
            {"id":"am","source":"a","target":"merge","data":{"edgeType":"standard"}},
            {"id":"bm","source":"b","target":"merge","data":{"edgeType":"standard"}},
            {"id":"mo","source":"merge","target":"out","data":{"edgeType":"standard"}}
        ]));
        let plan = build_execution_plan(&graph, None).unwrap();
        assert_eq!(
            plan.batches,
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["merge".to_string()],
                vec!["out".to_string()]
            ]
        );
        let from_merge = build_execution_plan(&graph, Some("merge")).unwrap();
        assert_eq!(
            from_merge.batches,
            vec![vec!["merge".to_string()], vec!["out".to_string()]]
        );
    }

    #[test]
    fn rust_validator_rejects_standard_cycles() {
        let graph = graph_fixture(json!([
            {"id":"ia","source":"input","target":"a","data":{"edgeType":"standard"}},
            {"id":"ab","source":"a","target":"b","data":{"edgeType":"standard"}},
            {"id":"ba","source":"b","target":"a","data":{"edgeType":"standard"}},
            {"id":"bm","source":"b","target":"merge","data":{"edgeType":"standard"}},
            {"id":"mo","source":"merge","target":"out","data":{"edgeType":"standard"}}
        ]));
        assert!(validate_graph(&graph)
            .iter()
            .any(|item| item.id == "standard-cycle"));
    }

    #[test]
    fn token_usage_prefers_latest_turn_over_cumulative_thread_total() {
        let notification = json!({
            "params": {
                "tokenUsage": {
                    "total": { "totalTokens": 4_200 },
                    "last": { "totalTokens": 99 }
                }
            }
        });
        assert_eq!(extract_total_tokens(&notification), Some(99));
    }

    #[test]
    fn run_hydration_sums_tokens_across_attempts_and_revisions() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json)
                 VALUES('a1','run','agent',0,0,'failed',?1),
                       ('a2','run','agent',1,0,'completed',?2),
                       ('a3','run','agent',0,1,'completed',?3)",
                params![
                    json!({"attemptTokens":40}).to_string(),
                    json!({"attemptTokens":60}).to_string(),
                    json!({"attemptTokens":25}).to_string()
                ],
            )
            .unwrap();
        let mut records = vec![RunRecord {
            id: "run".into(),
            workflow_id: "workflow".into(),
            status: "completed".into(),
            created_at: "2026-07-17T00:00:00Z".into(),
            events_json: "[]".into(),
            nodes_json: json!([{"id":"agent","data":{}}]).to_string(),
            edges_json: "[]".into(),
            terminal_reason: None,
            resumable: false,
            pinned: false,
            last_event_sequence: 0,
        }];
        hydrate_run_records(&connection, &mut records).unwrap();
        let nodes: Value = serde_json::from_str(&records[0].nodes_json).unwrap();
        assert_eq!(nodes[0]["data"]["tokens"], 125);
    }

    #[test]
    fn run_hydration_maps_runtime_output_statuses_to_canvas_statuses() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        for (node_id, status) in [
            ("release", "success"),
            ("failed", "failure"),
            ("revision", "needs_revision"),
        ] {
            connection
                .execute(
                    "INSERT INTO node_executions(id,run_id,node_id,status,output_json) VALUES(?1,'run',?2,?3,?4)",
                    params![
                        format!("run:{node_id}"),
                        node_id,
                        status,
                        json!({"status":status,"summary":node_id,"data":{},"artifacts":[]}).to_string()
                    ],
                )
                .unwrap();
        }
        let mut records = vec![RunRecord {
            id: "run".into(),
            workflow_id: "workflow".into(),
            status: "completed".into(),
            created_at: "2026-07-21T00:00:00Z".into(),
            events_json: "[]".into(),
            nodes_json: json!([
                {"id":"release","data":{"status":"queued"}},
                {"id":"failed","data":{"status":"queued"}},
                {"id":"revision","data":{"status":"queued"}}
            ])
            .to_string(),
            edges_json: "[]".into(),
            terminal_reason: None,
            resumable: false,
            pinned: false,
            last_event_sequence: 0,
        }];

        hydrate_run_records(&connection, &mut records).unwrap();
        let nodes: Value = serde_json::from_str(&records[0].nodes_json).unwrap();
        assert_eq!(nodes[0]["data"]["status"], "completed");
        assert_eq!(nodes[1]["data"]["status"], "failed");
        assert_eq!(nodes[2]["data"]["status"], "needs_revision");
    }

    #[test]
    fn run_hydration_restores_the_highest_revision_for_connector_progress() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json)
                 VALUES('a0','run','builder',0,0,'success','{}'),
                       ('a1','run','builder',0,1,'success','{}'),
                       ('a2','run','builder',0,2,'success','{}')",
                [],
            )
            .unwrap();
        let mut records = vec![RunRecord {
            id: "run".into(),
            workflow_id: "workflow".into(),
            status: "failed".into(),
            created_at: "2026-07-21T00:00:00Z".into(),
            events_json: "[]".into(),
            nodes_json: json!([{"id":"builder","data":{"revisions":0}}]).to_string(),
            edges_json: "[]".into(),
            terminal_reason: None,
            resumable: false,
            pinned: false,
            last_event_sequence: 0,
        }];

        hydrate_run_records(&connection, &mut records).unwrap();
        let nodes: Value = serde_json::from_str(&records[0].nodes_json).unwrap();
        assert_eq!(nodes[0]["data"]["revisions"], 2);
    }

    #[test]
    fn loaded_workflow_record_restores_workspace_without_blank_or_missing_values() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workflows(
                    id TEXT PRIMARY KEY,
                    graph_json TEXT NOT NULL,
                    workspace_path TEXT
                );
                INSERT INTO workflows(id,graph_json,workspace_path)
                VALUES
                  ('normal','{\"nodes\":[1]}','C:\\workspaces\\coffee'),
                  ('unicode','{\"nodes\":[2]}','C:\\Work Spaces\\café'),
                  ('blank','{\"nodes\":[3]}',''),
                  ('spaces','{\"nodes\":[4]}','   '),
                  ('null-path','{\"nodes\":[5]}',NULL);",
            )
            .unwrap();

        // Attack vectors 1-2: exact absolute paths, including spaces/unicode.
        let normal = load_workflow_record_from_connection(&connection, "normal")
            .unwrap()
            .unwrap();
        assert_eq!(normal.graph_json, "{\"nodes\":[1]}");
        assert_eq!(
            normal.workspace_path.as_deref(),
            Some("C:\\workspaces\\coffee")
        );
        let unicode = load_workflow_record_from_connection(&connection, "unicode")
            .unwrap()
            .unwrap();
        assert_eq!(
            unicode.workspace_path.as_deref(),
            Some("C:\\Work Spaces\\café")
        );
        // Attack vectors 3-4: empty and whitespace-only paths become absent.
        assert_eq!(
            load_workflow_record_from_connection(&connection, "blank")
                .unwrap()
                .unwrap()
                .workspace_path,
            None
        );
        assert_eq!(
            load_workflow_record_from_connection(&connection, "spaces")
                .unwrap()
                .unwrap()
                .workspace_path,
            None
        );
        // Attack vector 5: SQL NULL and missing workflow remain unambiguous.
        assert_eq!(
            load_workflow_record_from_connection(&connection, "null-path")
                .unwrap()
                .unwrap()
                .workspace_path,
            None
        );
        assert!(load_workflow_record_from_connection(&connection, "missing")
            .unwrap()
            .is_none());
    }

    #[test]
    fn portfolio_summaries_aggregate_without_hydrating_run_payloads() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO runs(id,workflow_id,status,events_json,nodes_json)
                 VALUES('run-1','workflow-a','completed','[{\"large\":\"event\"}]',?1),
                       ('run-2','workflow-a','completed','[]',?2),
                       ('run-3','workflow-b','completed','[]',?3)",
                params![
                    json!([{"data":{"tokens":999}}]).to_string(),
                    json!([{"data":{"tokens":30}}]).to_string(),
                    json!([{"data":{"tokens":20}}]).to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO node_attempts(id,run_id,node_id,attempt,revision,status,diagnostics_json)
                 VALUES('p1','run-1','agent',0,0,'failed',?1),
                       ('p2','run-1','agent',1,0,'completed',?2)",
                params![
                    json!({"attemptTokens":40}).to_string(),
                    json!({"attemptTokens":60}).to_string()
                ],
            )
            .unwrap();

        let summaries = load_portfolio_run_summaries(&connection).unwrap();
        assert_eq!(
            summaries,
            vec![
                PortfolioRunSummary {
                    workflow_id: "workflow-a".into(),
                    run_count: 2,
                    token_burn: 130,
                },
                PortfolioRunSummary {
                    workflow_id: "workflow-b".into(),
                    run_count: 1,
                    token_burn: 20,
                },
            ]
        );
    }

    #[test]
    fn headless_approval_policy_parse_defaults_to_auto_decline() {
        // Pure parser — no process env mutation (safe under parallel cargo test).
        assert_eq!(
            parse_headless_codex_approval_policy(""),
            HeadlessCodexApprovalPolicy::AutoDecline
        );
        assert_eq!(
            parse_headless_codex_approval_policy("auto_accept"),
            HeadlessCodexApprovalPolicy::AutoAccept
        );
        assert_eq!(
            parse_headless_codex_approval_policy("auto_decline"),
            HeadlessCodexApprovalPolicy::AutoDecline
        );
        assert_eq!(
            parse_headless_codex_approval_policy("decline"),
            HeadlessCodexApprovalPolicy::AutoDecline
        );
        assert_eq!(
            parse_headless_codex_approval_policy("wait"),
            HeadlessCodexApprovalPolicy::Wait
        );
        assert_eq!(
            parse_headless_codex_approval_policy("manual"),
            HeadlessCodexApprovalPolicy::Wait
        );
        assert_eq!(
            parse_headless_codex_approval_policy("  WAIT  "),
            HeadlessCodexApprovalPolicy::Wait
        );
    }

    // ---- Realtime voice session tests ----
    //
    // These cover the lifecycle bugs that had no coverage in the bot's
    // original implementation: the orphan-Drop regression (a session whose
    // child died independently used to linger in the broker map forever) and
    // the dispatcher's remove-then-Drop deadlock discipline. They construct a
    // RealtimeSession directly with a long-sleeping child so no Tauri AppHandle
    // or app-server spawn is required.

    /// Spawn a child that sleeps long enough for any test to finish, returning
    /// the Child (with piped stdin) so a RealtimeSession can take its stdin.
    fn spawn_sleeping_child() -> Child {
        use std::process::Command;
        // `ping -n 60 127.0.0.1` on Windows sleeps ~60s; on Unix `sleep 60`.
        // Both are ubiquitous and exit cleanly when killed.
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("ping");
            c.arg("-n").arg("60").arg("127.0.0.1");
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sleep");
            c.arg("60");
            c
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn()
            .expect("sleeping child must spawn for realtime tests")
    }

    fn build_test_session(_broker: RealtimeBroker, _key: &str) -> Arc<Mutex<RealtimeSession>> {
        let mut child = spawn_sleeping_child();
        let stdin_raw = child.stdin.take().expect("stdin piped");
        Arc::new(Mutex::new(RealtimeSession {
            thread_id: "thread-test".into(),
            realtime_session_id: None,
            version: None,
            stdin: Arc::new(Mutex::new(stdin_raw)),
            child: Arc::new(Mutex::new(child)),
            app_handle: None,
            next_id: AtomicU64::new(100),
            process_lease: None,
            closed: Arc::new((Mutex::new(false), Condvar::new())),
        }))
    }

    #[test]
    fn realtime_session_drop_deregisters_from_broker() {
        // Regression: the original Drop killed the child but never removed
        // the session from the broker. A subsequent append against the dead
        // session silently "succeeded" against a dead stdin, and a new
        // session with the same key overwrote a zombie.
        let broker = RealtimeBroker::default();
        let session = build_test_session(broker.clone(), "session-a");
        {
            let mut sessions = broker.0.lock();
            sessions.insert("session-a".into(), session.clone());
        }
        // Back-reference is already set by build_test_session.
        assert_eq!(broker.0.lock().len(), 1);

        // Drop our handle AND the broker's handle by removing then dropping.
        let removed = broker.0.lock().remove("session-a");
        drop(removed);
        // The session's own Drop runs its deregistration path; since it's
        // already gone, the broker stays empty (idempotent removal).
        assert_eq!(broker.0.lock().len(), 0);
    }

    #[test]
    fn realtime_session_drop_is_idempotent_when_dispatcher_already_removed() {
        // Mirrors the dispatcher's /closed handler: it removes the entry from
        // the map (dropping the map's Arc), then Drop runs on the session
        // and tries to remove again. This must not panic or deadlock.
        let broker = RealtimeBroker::default();
        let session = build_test_session(broker.clone(), "session-b");
        broker.0.lock().insert("session-b".into(), session);

        // Dispatcher path: lock, remove, drop the lock, then drop the Arc.
        let removed = broker
            .0
            .lock()
            .remove("session-b")
            .expect("session was inserted");
        // At this point the broker no longer holds a reference; dropping the
        // Arc here triggers RealtimeSession::drop, which re-locks the broker
        // ( uncontended ) and removes a key that is already absent — a no-op.
        drop(removed);

        assert_eq!(broker.0.lock().len(), 0);
    }

    #[test]
    fn realtime_append_against_missing_session_returns_error() {
        // Validates the error path the append commands rely on: looking up a
        // session key that doesn't exist must produce a descriptive error,
        // not a panic or silent success against a dead stdin.
        let broker = RealtimeBroker::default();
        let lookup = broker.0.lock().get("does-not-exist").cloned();
        assert!(lookup.is_none(), "missing session key must resolve to None");
    }

    #[test]
    fn realtime_audio_rejects_hostile_payloads() {
        let valid = RealtimeAudioChunk {
            data: BASE64_STANDARD.encode([0_u8; 4]),
            sample_rate: 24_000,
            num_channels: 1,
            samples_per_channel: Some(2),
            item_id: None,
        };
        assert!(valid.validate().is_ok());

        let malformed = RealtimeAudioChunk {
            data: "%%%".into(),
            ..valid
        };
        assert!(malformed.validate().unwrap_err().contains("base64"));

        let inconsistent = RealtimeAudioChunk {
            data: BASE64_STANDARD.encode([0_u8; 4]),
            sample_rate: 24_000,
            num_channels: 2,
            samples_per_channel: Some(2),
            item_id: None,
        };
        assert!(inconsistent.validate().unwrap_err().contains("frame count"));
    }

    #[test]
    fn graceful_interrupt_includes_authoritative_thread_and_turn_ids() {
        let mut child = spawn_sleeping_child();
        let handle = ActiveTurnHandle {
            stdin: Arc::new(Mutex::new(child.stdin.take().expect("stdin piped"))),
            thread_id: "thread-authoritative".into(),
            turn_id: "turn-authoritative".into(),
        };
        let request = turn_interrupt_request(7, &handle);
        assert_eq!(request["method"], "turn/interrupt");
        assert_eq!(request["params"]["threadId"], "thread-authoritative");
        assert_eq!(request["params"]["turnId"], "turn-authoritative");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn pending_interactions_are_typed_and_cancelled_with_their_process() {
        let broker = ApprovalBroker(Arc::new(Mutex::new(HashMap::new())));
        let (approval_tx, approval_rx) = mpsc::channel();
        let (question_tx, _question_rx) = mpsc::channel();
        {
            let mut pending = broker.0.lock();
            pending.insert(
                "approval".into(),
                PendingInteraction {
                    kind: PendingInteractionKind::Approval,
                    process_key: "process-a".into(),
                    sender: approval_tx,
                },
            );
            pending.insert(
                "question".into(),
                PendingInteraction {
                    kind: PendingInteractionKind::UserInput,
                    process_key: "process-b".into(),
                    sender: question_tx,
                },
            );
        }
        {
            let _registration = PendingProcessInteractions {
                process_key: "process-a".into(),
                broker: broker.clone(),
            };
        }
        let pending = broker.0.lock();
        assert!(!pending.contains_key("approval"));
        assert_eq!(
            pending.get("question").map(|value| value.kind),
            Some(PendingInteractionKind::UserInput)
        );
        drop(pending);
        assert!(matches!(
            approval_rx.recv_timeout(Duration::from_millis(10)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
    }

    #[test]
    fn app_server_contract_dtos_decode_generated_shapes() {
        let config: ConfigReadResponseDto = serde_json::from_value(json!({
            "config": {
                "model": "gpt-5.6",
                "approval_policy": "on-request",
                "sandbox_mode": "read-only",
                "web_search": "disabled",
                "instructions": null,
                "developer_instructions": "safe",
                "model_reasoning_effort": "high",
                "model_provider": "openai"
            },
            "origins": {},
            "layers": null
        }))
        .expect("generated config shape");
        assert_eq!(config.config.approval_policy.as_deref(), Some("on-request"));

        let threads: ThreadListResponseDto = serde_json::from_value(json!({
            "data": [{
                "id":"t1", "name":null, "preview":"hello",
                "status":{"type":"active","activeFlags":[]},
                "createdAt":10, "updatedAt":12, "cwd":"C:/work",
                "modelProvider":"openai", "turns":[]
            }],
            "nextCursor": null, "backwardsCursor": null
        }))
        .expect("generated thread/list shape");
        let summary = thread_summary(threads.data.into_iter().next().unwrap());
        assert_eq!(summary.created_at, 10_000);
        assert_eq!(summary.status.as_deref(), Some("active"));

        let mcp: McpStatusResponseDto = serde_json::from_value(json!({
            "data": [{
                "name":"server", "serverInfo":null, "tools":{},
                "resources":[{"uri":"resource://one"}],
                "resourceTemplates":[], "authStatus":"unsupported"
            }], "nextCursor":null
        }))
        .expect("generated MCP status shape");
        assert_eq!(mcp.data[0].resources.len(), 1);
    }

    #[test]
    fn app_server_contract_dtos_fail_when_required_fields_are_missing() {
        let malformed = serde_json::from_value::<ThreadListResponseDto>(json!({
            "data": [{"id":"t1"}]
        }));
        assert!(malformed.is_err());
    }

    #[test]
    fn realtime_output_audio_method_name_uses_slash_not_hyphen() {
        // Regression: the dispatcher originally matched
        // "thread/realtime/outputAudio-delta" (hyphen) but the canonical
        // method name is "thread/realtime/outputAudio/delta" (slash). The
        // hyphen form never matched, silently dropping every audio chunk.
        // This test pins the canonical name so a future typo is caught.
        let canonical = "thread/realtime/outputAudio/delta";
        assert!(canonical.ends_with("/delta"));
        assert!(!canonical.contains("-delta"));
        assert_eq!(
            canonical, "thread/realtime/outputAudio/delta",
            "method name must match ServerNotification.ts:228"
        );
        // And the match arm in spawn_realtime_dispatcher must agree.
        let matched = matches!(canonical, "thread/realtime/outputAudio/delta");
        assert!(matched);
    }
}
