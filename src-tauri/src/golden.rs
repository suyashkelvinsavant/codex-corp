//! Mission-level golden runner (P4).
//!
//! Drives `start_run_headless` end-to-end for each `evals/golden/*.json`
//! *mission* fixture against a scripted fake Codex app-server, then asserts the
//! run's terminal status and the delivery node's `data.verification` /
//! `bundleHash`. Classification-only fixtures (verifier-level shapes exercised
//! by the Rust `golden_evals` unit test) are reported as `skipped` so the
//! runner still "loads each" fixture and returns one row per fixture.
//!
//! CI-runnable without GTK: the fake server is protocol-level JSON-RPC over
//! stdio; the run uses the same headless `workflow_runtime` code path as MCP.
//!
//! Isolated per run: fresh `CODEX_CORP_DATA_DIR` (new SQLite), fresh workspace,
//! and `CODEX_CORP_ACTIVE_PATH` pointed at the scripted fake server.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::params;
use serde_json::{json, Value};

use crate::workflow_runtime::{start_run_headless, RunApprovalBroker, WorkflowRuntime};
use crate::{open_shared_database, ApprovalBroker, Database, ProcessBroker, TurnStdinBroker};

/// Max wall-clock for a single mission run (fake server answers in ms).
const MISSION_TIMEOUT: Duration = Duration::from_secs(120);
/// Poll interval for status / approval scans.
const POLL_INTERVAL: Duration = Duration::from_millis(100);
static GOLDEN_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Run one golden fixture as a mission. Returns a per-fixture JSON row ready
/// for `evals/runner.mjs` aggregation into the result table.
pub fn run_golden_mission(fixture_path: &str, fake_server_path: &str) -> Result<Value, String> {
    let fixture_text =
        std::fs::read_to_string(fixture_path).map_err(|error| format!("read fixture: {error}"))?;
    let fixture: Value =
        serde_json::from_str(&fixture_text).map_err(|error| format!("parse fixture: {error}"))?;
    let id = fixture["id"].as_str().unwrap_or("unknown").to_string();

    if fixture["runMode"].as_str() != Some("mission") {
        return Ok(json!({
            "id": id,
            "runMode": "skipped",
            "reason": "classification-only fixture; covered by the Rust golden_evals unit test",
        }));
    }

    let _environment_guard = GOLDEN_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "golden environment lock poisoned".to_string())?;
    // Validate all fixture-controlled process settings before creating files
    // or mutating the parent process environment.
    let fixture_env = fixture_env_overrides(&fixture)?;
    let root = golden_temp_root()?;
    let data_dir = root.join("data");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("create golden data dir: {error}"))?;
    std::fs::create_dir_all(&workspace)
        .map_err(|error| format!("create golden workspace: {error}"))?;
    // Seed host-verifiable workspace files (command scripts, wrong-layer sources,
    // native markers) so verification-failure missions run against real state.
    for (rel, content) in fixture_workspace_files(&fixture) {
        let target = workspace_target(&workspace, &rel)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create workspace file parent {rel}: {error}"))?;
        }
        std::fs::write(&target, content)
            .map_err(|error| format!("write workspace file {rel}: {error}"))?;
    }
    // Write the scripted builder output where the fake server will read it.
    let outputs_file = root.join("scripted-outputs.json");
    let scripted = fixture["scriptedOutputs"].clone();
    let scripted = if scripted.is_array() {
        scripted
    } else {
        json!([])
    };
    std::fs::write(
        &outputs_file,
        serde_json::to_string(&scripted).unwrap_or_default(),
    )
    .map_err(|error| format!("write scripted outputs: {error}"))?;
    // The fake server advances a shared on-disk cursor so per-attempt outputs
    // work across the fresh app-server process each specialist turn spawns.
    let cursor_file = root.join("scripted-outputs.cursor");
    std::fs::write(&cursor_file, "0")
        .map_err(|error| format!("write scripted outputs cursor: {error}"))?;

    // Per-run env isolation (fresh DB + fake codex path). Restored on every
    // exit path so consecutive runs stay hermetic.
    let prior_data_dir = std::env::var_os("CODEX_CORP_DATA_DIR");
    let prior_codex_override = std::env::var_os("CODEX_CORP_ACTIVE_PATH");
    let prior_outputs_file = std::env::var_os("CODEX_CORP_GOLDEN_OUTPUTS_FILE");
    let prior_cursor_file = std::env::var_os("CODEX_CORP_GOLDEN_OUTPUTS_CURSOR");
    std::env::set_var("CODEX_CORP_DATA_DIR", &data_dir);
    std::env::set_var("CODEX_CORP_ACTIVE_PATH", fake_server_path);
    std::env::set_var("CODEX_CORP_GOLDEN_OUTPUTS_FILE", &outputs_file);
    std::env::set_var("CODEX_CORP_GOLDEN_OUTPUTS_CURSOR", &cursor_file);

    // Fixture-scoped env (e.g. a short needs_human timeout for the
    // mission-capability-gate-times-out variant). Captured for restore.
    let fixture_env_prior: Vec<(String, Option<std::ffi::OsString>)> = fixture_env
        .iter()
        .map(|(name, value)| {
            let prior = std::env::var_os(name);
            std::env::set_var(name, value);
            (name.clone(), prior)
        })
        .collect();

    let result = run_mission_isolated(&fixture, &workspace, &id);

    for (name, prior) in fixture_env_prior {
        match prior {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    let restore = |name: &str, prior: Option<std::ffi::OsString>| match prior {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    };
    restore("CODEX_CORP_DATA_DIR", prior_data_dir);
    restore("CODEX_CORP_ACTIVE_PATH", prior_codex_override);
    restore("CODEX_CORP_GOLDEN_OUTPUTS_FILE", prior_outputs_file);
    restore("CODEX_CORP_GOLDEN_OUTPUTS_CURSOR", prior_cursor_file);
    // Best-effort cleanup of the isolated temp root.
    let _ = std::fs::remove_dir_all(&root);

    result
}

/// Read `fixture["mission"]["workspaceFiles"]` (object of relative-path →
/// content) plus `fixture["workspaceFiles"]` (same shape).
fn fixture_workspace_files(fixture: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for source in [
        fixture["workspaceFiles"].clone(),
        fixture["mission"]["workspaceFiles"].clone(),
    ] {
        if let Some(map) = source.as_object() {
            for (rel, content) in map {
                if let Some(text) = content.as_str() {
                    out.push((rel.clone(), text.to_string()));
                }
            }
        }
    }
    out
}

/// Create a fresh temp root without incorporating untrusted fixture metadata
/// into the path. `create_dir` prevents an existing path or symlink from being
/// reused as the run root.
fn golden_temp_root() -> Result<PathBuf, String> {
    let base = std::env::temp_dir();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("read temp-root clock: {error}"))?
        .as_nanos();
    for attempt in 0..16_u8 {
        let root = base.join(format!(
            "codex-corp-golden-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&root) {
            Ok(()) => return Ok(root),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create golden temp root: {error}")),
        }
    }
    Err("could not allocate a unique golden temp root".into())
}

/// Resolve a fixture workspace file only when its key is a relative path that
/// cannot escape the fresh workspace directory.
fn workspace_target(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "fixture workspace path must be relative and contained: {relative}"
        ));
    }
    let target = workspace.join(path);
    if !target.starts_with(workspace) {
        return Err(format!(
            "fixture workspace path escapes workspace: {relative}"
        ));
    }
    Ok(target)
}

const ALLOWED_FIXTURE_ENV: &[&str] = &["CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS"];

/// Fixture metadata may tune the deterministic timeout only. It must not be
/// able to inject credentials, redirect the database, or replace the server
/// executable inherited by the mission process.
fn fixture_env_overrides(fixture: &Value) -> Result<Vec<(String, String)>, String> {
    let Some(map) = fixture["env"].as_object() else {
        return Ok(Vec::new());
    };
    map.iter()
        .map(|(name, value)| {
            if !ALLOWED_FIXTURE_ENV.contains(&name.as_str()) {
                return Err(format!(
                    "fixture environment override is not allowed: {name}"
                ));
            }
            let value = value
                .as_str()
                .ok_or_else(|| format!("fixture environment value must be a string: {name}"))?;
            if value.len() > 128 || value.contains('\0') {
                return Err(format!("fixture environment value is invalid: {name}"));
            }
            Ok((name.clone(), value.to_string()))
        })
        .collect()
}

fn run_mission_isolated(fixture: &Value, workspace: &Path, id: &str) -> Result<Value, String> {
    let database = open_shared_database()?;
    let graph = build_mission_graph(fixture)?;
    let graph_json = serde_json::to_string(&graph).map_err(|error| error.to_string())?;
    let workflow_id = format!("golden-wf-{id}");
    {
        let connection = database.0.lock().map_err(|_| "database lock poisoned")?;
        connection
            .execute(
                "INSERT OR REPLACE INTO workflows(id,name,graph_json,template_json,updated_at) VALUES(?1,?2,?3,NULL,CURRENT_TIMESTAMP)",
                params![&workflow_id, format!("Golden {id}"), graph_json],
            )
            .map_err(|error| error.to_string())?;
    }

    let run_approvals = RunApprovalBroker::default();
    let record = tauri::async_runtime::block_on(start_run_headless(
        workflow_id.clone(),
        None,
        Some(workspace.to_string_lossy().into_owned()),
        database.clone(),
        WorkflowRuntime::default(),
        run_approvals.clone(),
        ApprovalBroker(Arc::new(Mutex::new(HashMap::new()))),
        ProcessBroker(Arc::new(Mutex::new(HashMap::new()))),
        TurnStdinBroker(Arc::new(Mutex::new(HashMap::new()))),
    ))?;
    let record_json = serde_json::to_value(&record).map_err(|e| e.to_string())?;
    let run_id = record_json["id"]
        .as_str()
        .ok_or("golden run missing id")?
        .to_string();

    let (status, terminal_reason) =
        await_terminal_run(&database, &run_approvals, &run_id, id, fixture)?;

    let delivery_meta = read_delivery_meta(&database, &run_id);
    let builder_verification = read_builder_verification(&database, &run_id);
    let verification_attempts = count_verification_attempt_records(&database, &run_id);

    let expected = fixture["expect"].clone();
    let expect_status = expected["runStatus"].as_str().unwrap_or("completed");
    let expect_bundle = expected["delivery"]["bundleHash"]
        .as_str()
        .unwrap_or("present");
    let expect_verification = expected["delivery"]["verification"]
        .as_str()
        .unwrap_or("present");

    let bundle_present = delivery_meta["bundleHash"]
        .as_str()
        .map(|hash| !hash.is_empty())
        .unwrap_or(false);
    // "delivery node data.verification" = the assembled bundle's upstream
    // verificationSummary (absent when no trusted delivery was produced).
    let verification_present = delivery_meta["verificationSummaryPresent"] == Value::Bool(true);

    let status_ok = status == expect_status;
    let bundle_ok = (expect_bundle == "present") == bundle_present;
    let verification_ok = (expect_verification == "present") == verification_present;
    let reason_ok = expected["terminalReasonContains"].as_str().map(|needle| {
        terminal_reason
            .as_deref()
            .is_some_and(|reason| reason.contains(needle))
    });
    let revisions_ok = expected["persistedVerificationAttempts"]
        .as_u64()
        .map(|min| verification_attempts >= min);
    let passed = status_ok
        && bundle_ok
        && verification_ok
        && reason_ok.unwrap_or(true)
        && revisions_ok.unwrap_or(true);

    Ok(json!({
        "id": id,
        "runMode": "mission",
        "runStatus": status,
        "terminalReason": terminal_reason,
        "delivery": {
            "bundleHash": delivery_meta["bundleHash"],
            "verificationSummaryPresent": delivery_meta["verificationSummaryPresent"],
            "builderPassBitOwner": builder_verification.get("passBitOwner").cloned().unwrap_or(Value::Null),
        },
        "verificationAttempts": verification_attempts,
        "expected": expected,
        "checks": {
            "runStatus": status_ok,
            "deliveryBundleHash": bundle_ok,
            "deliveryVerification": verification_ok,
            "terminalReason": reason_ok,
            "persistedVerificationAttempts": revisions_ok,
        },
        "passed": passed,
    }))
}

/// Poll the run until a terminal status appears, auto-approving run gates
/// (approval node / needs_human) so headless missions make progress — unless
/// the fixture sets `autoApproveGates: false`, in which case gates resolve
/// naturally (e.g. a needs_human gate times out fail-closed).
fn await_terminal_run(
    database: &Database,
    run_approvals: &RunApprovalBroker,
    run_id: &str,
    id: &str,
    fixture: &Value,
) -> Result<(String, Option<String>), String> {
    let auto_approve = fixture["autoApproveGates"] != Value::Bool(false);
    let deadline = Instant::now() + MISSION_TIMEOUT;
    loop {
        // Auto-approve any run gate for this run (approval node and any
        // needs_human gate). Mirrors respond_run_approval's key contract.
        if auto_approve {
            if let Ok(mut pending) = run_approvals.0.lock() {
                let keys: Vec<String> = pending
                    .keys()
                    .filter(|key| key.starts_with(&format!("{run_id}::")))
                    .cloned()
                    .collect();
                for key in keys {
                    if let Some(sender) = pending.remove(&key) {
                        let _ = sender.send(true);
                    }
                }
            }
        }

        let snapshot: Option<(String, Option<String>)> =
            database.0.lock().ok().and_then(|connection| {
                connection
                    .query_row(
                        "SELECT status, terminal_reason FROM runs WHERE id=?1",
                        params![run_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                    .ok()
            });
        if let Some((status, reason)) = snapshot.as_ref() {
            if matches!(
                status.as_str(),
                "completed" | "failed" | "interrupted" | "cancelled"
            ) {
                return Ok((status.clone(), reason.clone()));
            }
        }
        if deadline.elapsed() >= MISSION_TIMEOUT {
            let last = snapshot
                .map(|(status, _)| status)
                .unwrap_or_else(|| "none".into());
            return Err(format!(
                "golden mission {id} timed out (last status {last})"
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Count persisted verification attempt records (P3 routing rows carry
/// `failureClass:"verification"` + criterion ids on `node_attempts`).
fn count_verification_attempt_records(database: &Database, run_id: &str) -> u64 {
    database
        .0
        .lock()
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM node_attempts
                     WHERE run_id=?1
                       AND json_extract(diagnostics_json,'$.failureClass')='verification'
                       AND json_extract(diagnostics_json,'$.gate')='verification'",
                    params![run_id],
                    |row| row.get::<_, i64>(0),
                )
                .ok()
        })
        .unwrap_or(0) as u64
}

fn read_delivery_meta(database: &Database, run_id: &str) -> Value {
    let Some(bundle) = node_output_json(database, run_id, "output") else {
        return json!({"verificationSummaryPresent": false});
    };
    let data = bundle.get("data").cloned().unwrap_or(Value::Null);
    json!({
        "bundleHash": data.get("bundleHash").cloned().unwrap_or(Value::Null),
        "verificationSummaryPresent": data
            .get("verificationSummary")
            .map(|summary| summary.is_array() && !summary.as_array().unwrap().is_empty())
            .unwrap_or(false),
    })
}

fn read_builder_verification(database: &Database, run_id: &str) -> Value {
    let Some(output) = node_output_json(database, run_id, "builder") else {
        return Value::Null;
    };
    output
        .get("data")
        .and_then(|data| data.get("verification"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// Read a node's persisted output_json (RuntimeOutput serialized camelCase).
fn node_output_json(database: &Database, run_id: &str, node_id: &str) -> Option<Value> {
    let connection = database.0.lock().ok()?;
    let raw: String = connection
        .query_row(
            "SELECT output_json FROM node_executions WHERE run_id=?1 AND node_id=?2",
            params![run_id, node_id],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str(&raw).ok()
}

/// Build the canonical mission graph from fixture metadata. The graph shape
/// matches `workflow_runtime::parse_graph` (camelCase node data).
///
/// Mission topology:
///   plain        input → builder → approval → output
///   revision     input → producer → builder┄┄┄┄┄┄→ approval → output
///                                    (revision edge back to producer)
///   post-approval input → builder → approval → enhancement → output
///
/// The builder holds `mission.builderCriteria`; a revision producer / a
/// post-approval enhancement agent are added when their fixture blocks exist.
fn build_mission_graph(fixture: &Value) -> Result<Value, String> {
    let mission_text = fixture["mission"]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("Golden mission")
        .to_string();
    let builder_role = fixture["mission"]["builderRole"]
        .as_str()
        .unwrap_or("Builder")
        .to_string();
    let criteria = fixture["mission"]
        .get("builderCriteria")
        .cloned()
        .unwrap_or_else(|| json!([]));

    let agent_node = |id: &str, label: &str, role: &str, completion_criteria: Value| {
        json!({
            "id": id,
            "data": {
                "label": label,
                "role": role,
                "kind": "agent",
                "prompt": "",
                "developerInstructions": "You are a specialist agent for Codex Corp. Return concise JSON with keys status, summary, data, artifacts only. Do not include hidden reasoning.",
                "completionCriteria": completion_criteria,
                "maxRetries": 1,
                "approvalPolicy": "on-request",
                "sandboxProfile": "workspace-write"
            }
        })
    };

    let mut nodes = json!([
        {
            "id": "input",
            "data": {
                "label": "Mission",
                "role": "Input",
                "kind": "input",
                "prompt": "",
                "output": mission_text
            }
        },
        agent_node("builder", "Builder", &builder_role, criteria),
        {
            "id": "approval",
            "data": {
                "label": "Release Approval",
                "role": "Human",
                "kind": "approval",
                "prompt": ""
            }
        },
        {
            "id": "output",
            "data": {
                "label": "Release Bundle",
                "role": "Verified handoff",
                "kind": "output",
                "prompt": ""
            }
        }
    ]);
    if let Some(nodes_arr) = nodes.as_array_mut() {
        // Revision producer injected upstream of the reviewer-builder: the
        // builder (reviewer) routes revision feedback back to it via the
        // revision edge, mirroring real graphs (qa → builder revision).
        let revision_target = fixture["mission"].get("revisionTarget").cloned();
        if let Some(target) = revision_target {
            let producer_criteria = target
                .get("completionCriteria")
                .cloned()
                .unwrap_or_else(|| json!([]));
            nodes_arr.insert(
                1,
                agent_node("producer", "Producer", "Producer", producer_criteria),
            );
        }
        // Post-approval agent injected between Release Approval and delivery so
        // its (unfrozen) artifacts arrive in the live set after the approval
        // snapshot — a legitimate stale-handoff shape for the pair-compare gate.
        if fixture["mission"].get("postApprovalAgent").is_some() {
            let enhancement_criteria = fixture["mission"]["postApprovalAgent"]
                .get("completionCriteria")
                .cloned()
                .unwrap_or_else(|| json!([]));
            nodes_arr.push(agent_node(
                "enhancement",
                "Post-approval Enhancement",
                "Enhancer",
                enhancement_criteria,
            ));
        }
    }

    let has_revision = fixture["mission"].get("revisionTarget").is_some();
    let has_post_approval = fixture["mission"].get("postApprovalAgent").is_some();

    let mut edges = Vec::new();
    if has_revision {
        edges.push(json!({"id": "e0", "source": "input", "target": "producer", "data": {"edgeType": "standard"}}));
        edges.push(json!({"id": "e1", "source": "producer", "target": "builder", "data": {"edgeType": "standard"}}));
    } else {
        edges.push(json!({"id": "e1", "source": "input", "target": "builder", "data": {"edgeType": "standard"}}));
    }
    edges.push(json!({"id": "e2", "source": "builder", "target": "approval", "data": {"edgeType": "standard"}}));
    if has_post_approval {
        edges.push(json!({"id": "e3", "source": "approval", "target": "enhancement", "data": {"edgeType": "standard"}}));
        edges.push(json!({"id": "e4", "source": "enhancement", "target": "output", "data": {"edgeType": "standard"}}));
    } else {
        edges.push(json!({"id": "e3", "source": "approval", "target": "output", "data": {"edgeType": "standard"}}));
    }
    if has_revision {
        let max_revisions = fixture["mission"]
            .get("maxRevisions")
            .and_then(Value::as_u64)
            .unwrap_or(2);
        edges.push(json!({
            "id": "rev", "source": "builder", "target": "producer",
            "data": {"edgeType": "revision", "maxRevisions": max_revisions}
        }));
    }
    Ok(json!({ "nodes": nodes, "edges": edges }))
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn fixture_workspace_rejects_parent_escape() {
        let workspace = Path::new("C:\\golden\\workspace");
        assert!(workspace_target(workspace, "..\\outside.txt").is_err());
        assert!(workspace_target(workspace, "nested/../../outside.txt").is_err());
    }

    #[test]
    fn fixture_workspace_rejects_absolute_paths() {
        let workspace = Path::new("C:\\golden\\workspace");
        assert!(workspace_target(workspace, "C:\\Users\\Public\\outside.txt").is_err());
        assert!(workspace_target(workspace, "/tmp/outside.txt").is_err());
    }

    #[test]
    fn fixture_workspace_accepts_normal_relative_paths() {
        let workspace = Path::new("C:\\golden\\workspace");
        let target = workspace_target(workspace, "src\\scheduler\\job_runner.ts")
            .expect("normal fixture path");
        assert!(target.starts_with(workspace));
    }

    #[test]
    fn fixture_env_rejects_unapproved_process_overrides() {
        let fixture = json!({
            "env": {
                "OPENAI_API_KEY": "must-not-be-injected",
                "CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS": "3"
            }
        });
        let error = fixture_env_overrides(&fixture).expect_err("secret env must be rejected");
        assert!(error.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn golden_temp_root_is_not_derived_from_fixture_id() {
        let root = golden_temp_root().expect("isolated root");
        assert_eq!(root.parent(), std::env::temp_dir().as_path().into());
        assert!(!root.to_string_lossy().contains("outside"));
        let _ = std::fs::remove_dir_all(root);
    }
}
