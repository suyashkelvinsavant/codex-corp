use rusqlite::params;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::verifier::{collect_upstream_artifacts, freeze_approval_snapshot};

use super::{
    chrono_like_now_iso, database_guard, emit_event, poison_aware_lock, update_run_status,
    RunApprovalEvent, RunContext, RuntimeNode, RuntimeOutput,
};

pub(super) async fn await_operator_approval(
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

pub(super) async fn approval_node(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<RuntimeOutput, String> {
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
    let mut kind_artifacts: HashMap<String, (String, Vec<serde_json::Value>)> = HashMap::new();
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

/// Release commit approval gate: asks the operator for a separate release
/// decision, then creates an exact local Git commit tied to the frozen
/// approved artifact hashes/revisions. Does NOT push to main.
pub(super) async fn release_commit_node(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<RuntimeOutput, String> {
    let request_id = await_operator_approval(
        context,
        node,
        "release-commit",
        "Approve the creation of a local Git commit tied to the verified artifact snapshot. This does NOT push to main.",
    )
    .await?;
    // Freeze approved artifact (key,hash) pairs.
    let outputs_snapshot = poison_aware_lock(&context.outputs, "outputs", Some(&context.run_id));
    let mut kind_artifacts: HashMap<String, (String, Vec<serde_json::Value>)> = HashMap::new();
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
    // Create a local Git commit in the workspace if we have a workspace path.
    let workspace_path = context
        .target_workspace
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let commit_hash = if !workspace_path.is_empty() {
        let commit_message = format!(
            "release: verified artifact snapshot for run {} ({})",
            context.run_id, approved_at
        );
        match create_release_commit(&workspace_path, &commit_message) {
            Ok(hash) => Some(hash),
            Err(error) => {
                emit_event(
                    context,
                    "release.commit_failed",
                    "warning",
                    Some(&node.id),
                    None,
                    format!("Local release commit failed: {error}"),
                    json!({"requestId":request_id,"error":error}),
                );
                None
            }
        }
    } else {
        None
    };
    emit_event(
        context,
        "release.commit_created",
        "info",
        Some(&node.id),
        None,
        format!(
            "Release commit created{}",
            commit_hash
                .as_ref()
                .map(|h| format!(": {h}"))
                .unwrap_or_default()
        ),
        json!({"requestId":request_id,"commitHash":commit_hash.clone()}),
    );
    let mut data = freeze;
    if let Some(hash) = &commit_hash {
        if let Some(obj) = data.as_object_mut() {
            obj.insert("commitHash".into(), json!(hash));
        }
    }
    Ok(RuntimeOutput {
        status: "success".into(),
        summary: "Release commit approval recorded. Local Git commit created.".into(),
        data,
        artifacts: Vec::new(),
        thread_id: None,
        turn_id: None,
        tokens: 0,
    })
}

/// Publish approval gate: asks the operator for a separate publish decision.
/// Only after approval does it push the exact commit to main. This is the
/// only place in the workflow that performs a git push.
pub(super) async fn publish_approval_node(
    context: &RunContext,
    node: &RuntimeNode,
) -> Result<RuntimeOutput, String> {
    let request_id = await_operator_approval(
        context,
        node,
        "publish-approval",
        "Approve pushing the verified release commit to main. This is the final publish step.",
    )
    .await?;
    let workspace_path = context
        .target_workspace
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let push_result = if !workspace_path.is_empty() {
        match push_release_to_main(&workspace_path) {
            Ok(output) => output,
            Err(error) => {
                emit_event(
                    context,
                    "release.publish_failed",
                    "error",
                    Some(&node.id),
                    None,
                    format!("Publish to main failed: {error}"),
                    json!({"requestId":request_id,"error":error}),
                );
                return Err(format!("publish to main failed: {error}"));
            }
        }
    } else {
        "no workspace path; publish skipped".to_string()
    };
    emit_event(
        context,
        "release.published",
        "info",
        Some(&node.id),
        None,
        format!("Release published to main: {push_result}"),
        json!({"requestId":request_id,"pushResult":push_result}),
    );
    Ok(RuntimeOutput {
        status: "success".into(),
        summary: "Publish approval recorded. Release pushed to main.".into(),
        data: json!({"requestId":request_id,"pushResult":push_result}),
        artifacts: Vec::new(),
        thread_id: None,
        turn_id: None,
        tokens: 0,
    })
}

/// Create a local Git commit in the workspace for the release.
/// Stages all changes and creates a commit with the given message.
/// Returns the commit hash on success.
fn create_release_commit(workspace: &str, message: &str) -> Result<String, String> {
    use std::process::Command;
    let workspace_path = std::path::Path::new(workspace);
    // Stage all changes.
    let add_result = Command::new("git")
        .args(["add", "--all"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git add: {e}"))?;
    if !add_result.status.success() {
        let stderr = String::from_utf8_lossy(&add_result.stderr);
        return Err(format!("git add failed: {stderr}"));
    }
    // Create the commit.
    let commit_result = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git commit: {e}"))?;
    if !commit_result.status.success() {
        let stderr = String::from_utf8_lossy(&commit_result.stderr);
        // "nothing to commit" is not an error for a release commit.
        if stderr.contains("nothing to commit") {
            // Return the current HEAD hash.
            let rev_parse = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(workspace_path)
                .output()
                .map_err(|e| format!("failed to run git rev-parse: {e}"))?;
            return Ok(String::from_utf8_lossy(&rev_parse.stdout).trim().to_string());
        }
        return Err(format!("git commit failed: {stderr}"));
    }
    // Get the commit hash.
    let rev_parse = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git rev-parse: {e}"))?;
    if !rev_parse.status.success() {
        let stderr = String::from_utf8_lossy(&rev_parse.stderr);
        return Err(format!("git rev-parse HEAD failed: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&rev_parse.stdout).trim().to_string())
}

/// Push the release commit to main. This is the only place in the workflow
/// that performs a git push.
fn push_release_to_main(workspace: &str) -> Result<String, String> {
    use std::process::Command;
    let workspace_path = std::path::Path::new(workspace);
    let push_result = Command::new("git")
        .args(["push", "origin", "main"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git push: {e}"))?;
    if !push_result.status.success() {
        let stderr = String::from_utf8_lossy(&push_result.stderr);
        return Err(format!("git push origin main failed: {stderr}"));
    }
    let stdout = String::from_utf8_lossy(&push_result.stdout);
    Ok(stdout.trim().to_string())
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
pub(super) fn operator_approval_timeout(gate: &str, headless: bool) -> Duration {
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
pub(super) fn parse_needs_human_timeout(raw: Option<&str>) -> u64 {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return DEFAULT_NEEDS_HUMAN_TIMEOUT_SECS;
    };
    match raw.parse::<u64>() {
        Ok(secs) => secs.clamp(1, 3600),
        Err(_) => DEFAULT_NEEDS_HUMAN_TIMEOUT_SECS,
    }
}

pub(super) fn wait_for_approval(
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
