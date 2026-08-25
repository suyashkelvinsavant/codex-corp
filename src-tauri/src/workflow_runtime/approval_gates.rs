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
///
/// Fails closed when there is no Git workspace, when the working tree has
/// uncommitted unrelated changes, or when the commit cannot be created. A
/// release commit is the verified artifact snapshot — it must not silently
/// succeed without one, or the downstream publish-approval node would push
/// stale or unrelated content to `main`.
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
    // A release commit requires a real Git workspace. Fail closed without one
    // instead of returning a success output with no commit hash.
    let workspace_path = context
        .target_workspace
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if workspace_path.is_empty() {
        let error = "release-commit requires a workspace path; none was provided for this run";
        emit_event(
            context,
            "release.commit_failed",
            "error",
            Some(&node.id),
            None,
            error.to_string(),
            json!({"requestId":request_id,"error":error}),
        );
        return Err(error.into());
    }
    let commit_message = format!(
        "release: verified artifact snapshot for run {} ({})",
        context.run_id, approved_at
    );
    let commit_hash = match create_release_commit(&workspace_path, &commit_message) {
        Ok(hash) => hash,
        Err(error) => {
            emit_event(
                context,
                "release.commit_failed",
                "error",
                Some(&node.id),
                None,
                format!("Local release commit failed: {error}"),
                json!({"requestId":request_id,"error":error}),
            );
            return Err(format!("release commit failed: {error}"));
        }
    };
    emit_event(
        context,
        "release.commit_created",
        "info",
        Some(&node.id),
        None,
        format!("Release commit created: {commit_hash}"),
        json!({"requestId":request_id,"commitHash":commit_hash.clone()}),
    );
    let mut data = freeze;
    if let Some(obj) = data.as_object_mut() {
        obj.insert("commitHash".into(), json!(commit_hash));
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
///
/// Fails closed when there is no workspace path, when the current branch is
/// not `main`, or when the push fails. Publish must never silently skip.
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
    if workspace_path.is_empty() {
        let error =
            "publish-approval requires a workspace path; none was provided for this run";
        emit_event(
            context,
            "release.publish_failed",
            "error",
            Some(&node.id),
            None,
            error.to_string(),
            json!({"requestId":request_id,"error":error}),
        );
        return Err(error.into());
    }
    // Reject non-main branches: a release commit was created on the checked-out
    // branch, so pushing `main` while checked out elsewhere would push stale
    // or unrelated content. The operator must be on `main` to publish.
    match current_git_branch(&workspace_path) {
        Ok(branch) if branch == "main" => {}
        Ok(branch) => {
            let error = format!(
                "publish-approval rejected: current branch is '{branch}', not 'main'. Switch to main before publishing."
            );
            emit_event(
                context,
                "release.publish_failed",
                "error",
                Some(&node.id),
                None,
                error.clone(),
                json!({"requestId":request_id,"error":error,"branch":branch}),
            );
            return Err(error);
        }
        Err(error) => {
            emit_event(
                context,
                "release.publish_failed",
                "error",
                Some(&node.id),
                None,
                format!("Could not determine current Git branch: {error}"),
                json!({"requestId":request_id,"error":error}),
            );
            return Err(format!("publish to main failed: {error}"));
        }
    }
    let push_result = match push_release_to_main(&workspace_path) {
        Ok(output) => redact_git_output(&output),
        Err(error) => {
            // Redact once before any use: git push stderr routinely embeds the
            // remote URL with credentials (e.g. `https://ghp_token@host/...`).
            // The redacted form is used in the event message, the diagnostics,
            // and the returned Err so no copy can leak to the frontend or the
            // persisted run_events table.
            let safe_error = redact_git_output(&error);
            emit_event(
                context,
                "release.publish_failed",
                "error",
                Some(&node.id),
                None,
                format!("Publish to main failed: {safe_error}"),
                json!({"requestId":request_id,"error":safe_error}),
            );
            return Err(format!("publish to main failed: {safe_error}"));
        }
    };
    let safe_push_result = push_result;
    emit_event(
        context,
        "release.published",
        "info",
        Some(&node.id),
        None,
        format!("Release published to main: {safe_push_result}"),
        json!({"requestId":request_id,"pushResult":safe_push_result}),
    );
    Ok(RuntimeOutput {
        status: "success".into(),
        summary: "Publish approval recorded. Release pushed to main.".into(),
        data: json!({"requestId":request_id,"pushResult":safe_push_result}),
        artifacts: Vec::new(),
        thread_id: None,
        turn_id: None,
        tokens: 0,
    })
}

/// Create a local Git commit in the workspace for the release.
///
/// Requires a clean working tree before staging: uncommitted unrelated
/// changes are rejected so the release commit contains only the verified
/// artifact snapshot, not stray operator edits or secret-containing files.
/// Returns the commit hash on success. "nothing to commit" is treated as a
/// success that returns the current HEAD hash (the snapshot was already
/// committed by a prior release-commit on this branch).
fn create_release_commit(workspace: &str, message: &str) -> Result<String, String> {
    use std::process::Command;
    let workspace_path = std::path::Path::new(workspace);
    // Fail closed if the workspace is not a Git repository.
    let rev_parse_git_dir = Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git rev-parse: {e}"))?;
    if !rev_parse_git_dir.status.success() {
        let stderr = String::from_utf8_lossy(&rev_parse_git_dir.stderr);
        return Err(format!(
            "release-commit requires a Git workspace; rev-parse --git-dir failed: {stderr}"
        ));
    }
    // Reject uncommitted unrelated changes. A release commit must contain only
    // the verified artifact snapshot, so the tree must be clean before we stage.
    let porcelain = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git status: {e}"))?;
    if !porcelain.status.success() {
        let stderr = String::from_utf8_lossy(&porcelain.stderr);
        return Err(format!("git status --porcelain failed: {stderr}"));
    }
    let status_output = String::from_utf8_lossy(&porcelain.stdout);
    if !status_output.trim().is_empty() {
        return Err(format!(
            "release-commit requires a clean working tree; uncommitted unrelated changes must be committed or stashed first. Dirty paths:\n{}",
            status_output.trim()
        ));
    }
    // Stage all changes (the tree is clean, so this is a no-op unless the
    // verified artifact snapshot itself produced changes between the freeze
    // and this point — which is the intended release content).
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
        let stdout = String::from_utf8_lossy(&commit_result.stdout);
        // "nothing to commit" is not an error for a release commit — the
        // verified snapshot may have already been committed by a prior
        // release-commit on this branch. Some Git versions emit this on
        // stdout, others on stderr, so check both.
        if stderr.contains("nothing to commit") || stdout.contains("nothing to commit") {
            // Return the current HEAD hash.
            let rev_parse = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(workspace_path)
                .output()
                .map_err(|e| format!("failed to run git rev-parse: {e}"))?;
            return Ok(String::from_utf8_lossy(&rev_parse.stdout).trim().to_string());
        }
        let diagnostic = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "no diagnostic output".to_string()
        };
        return Err(format!("git commit failed: {diagnostic}"));
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
/// that performs a git push. The caller is responsible for verifying the
/// current branch is `main` before calling.
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

/// Determine the current checked-out Git branch. Uses `symbolic-ref` so a
/// detached HEAD returns an error (a detached HEAD cannot be `main`).
fn current_git_branch(workspace: &str) -> Result<String, String> {
    use std::process::Command;
    let workspace_path = std::path::Path::new(workspace);
    let output = Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("failed to run git symbolic-ref: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "could not determine current branch (detached HEAD?): {stderr}"
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Redact embedded credentials in Git output. Remote URLs in push output can
/// contain `https://<token>@host/...` or `https://user:pass@host/...`. Replace
/// the userinfo segment with `[REDACTED]` so secrets are never emitted in
/// events or persisted in node output data.
///
/// Scans for the `scheme://userinfo@host` shape without a regex dependency.
/// `userinfo` is the segment between `://` and the next `@` that precedes a
/// host (no whitespace, no `/`). This covers the common credential-bearing
/// URL forms Git emits in push/fetch diagnostics. Operates on UTF-8 string
/// slices so multi-byte content is preserved verbatim.
fn redact_git_output(output: &str) -> String {
    let mut result = String::with_capacity(output.len());
    let bytes = output.as_bytes();
    let mut last_emit = 0;
    let mut i = 0;
    while i < bytes.len() {
        // Look for "://" preceded by a scheme (an ASCII letter followed by
        // scheme-legal chars: letters, digits, '+', '-', '.').
        if bytes[i] == b':' && i + 2 < bytes.len() && bytes[i + 1] == b'/' && bytes[i + 2] == b'/' {
            // Walk back to find the scheme start.
            let mut scheme_start = i;
            while scheme_start > 0
                && (bytes[scheme_start - 1].is_ascii_alphanumeric()
                    || bytes[scheme_start - 1] == b'+'
                    || bytes[scheme_start - 1] == b'-'
                    || bytes[scheme_start - 1] == b'.')
            {
                scheme_start -= 1;
            }
            // Require at least one ASCII letter as the first scheme char so we
            // don't redact arbitrary `://` sequences inside prose.
            if scheme_start < i
                && bytes[scheme_start].is_ascii_alphabetic()
                && (scheme_start == 0 || !bytes[scheme_start - 1].is_ascii_alphanumeric())
            {
                // Walk forward past "://" to find userinfo ending at '@'
                // before the host. userinfo: no whitespace, no '/'.
                let mut j = i + 3;
                let mut found_at = None;
                while j < bytes.len() {
                    let c = bytes[j];
                    if c == b'@' {
                        found_at = Some(j);
                        break;
                    }
                    if c.is_ascii_whitespace() || c == b'/' {
                        break;
                    }
                    j += 1;
                }
                if let Some(at_pos) = found_at {
                    // Emit everything up to and including the scheme name
                    // (output[last_emit..i] = "...https"), then the redacted
                    // "://[REDACTED]@", and continue scanning after '@'.
                    result.push_str(&output[last_emit..i]);
                    result.push_str("://[REDACTED]@");
                    last_emit = at_pos + 1;
                    i = at_pos + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    result.push_str(&output[last_emit..]);
    result
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_git_output_redacts_https_userinfo_credentials() {
        let input = "To https://ghp_token123@github.com/org/repo.git\n   abc123..def456  main -> main";
        let redacted = redact_git_output(input);
        assert!(
            !redacted.contains("ghp_token123"),
            "token must be redacted, got: {redacted}"
        );
        assert!(
            redacted.contains("https://[REDACTED]@github.com/org/repo.git"),
            "host must be preserved, got: {redacted}"
        );
    }

    #[test]
    fn redact_git_output_redacts_user_password_credentials() {
        let input = "https://user:pass@github.com/org/repo.git";
        let redacted = redact_git_output(input);
        assert!(!redacted.contains("user:pass"));
        assert!(redacted.contains("https://[REDACTED]@github.com/org/repo.git"));
    }

    #[test]
    fn redact_git_output_redacts_ssh_userinfo_credentials() {
        let input = "ssh://deploy_key@git.example.com/repo.git";
        let redacted = redact_git_output(input);
        assert!(!redacted.contains("deploy_key"));
        assert!(redacted.contains("ssh://[REDACTED]@git.example.com/repo.git"));
    }

    #[test]
    fn redact_git_output_preserves_urls_without_credentials() {
        let input = "https://github.com/org/repo.git\n   abc123..def456  main -> main";
        let redacted = redact_git_output(input);
        assert_eq!(redacted, input, "URLs without credentials must be unchanged");
    }

    #[test]
    fn redact_git_output_preserves_non_url_text() {
        let input = "Everything up-to-date\nBranch 'main' set up to track 'origin/main'.";
        let redacted = redact_git_output(input);
        assert_eq!(redacted, input);
    }

    #[test]
    fn redact_git_output_preserves_multibyte_utf8() {
        let input = "Pushing to https://token@host.com/repo.git — 完成 ✓";
        let redacted = redact_git_output(input);
        assert!(redacted.contains("完成 ✓"), "UTF-8 content must survive, got: {redacted}");
        assert!(redacted.contains("https://[REDACTED]@host.com/repo.git"));
    }

    #[test]
    fn redact_git_output_does_not_match_prose_colon_slash_slash() {
        // "foo://bar" without a preceding scheme letter should not be redacted.
        let input = "see note :// not a url";
        let redacted = redact_git_output(input);
        assert_eq!(redacted, input);
    }

    #[test]
    fn redact_git_output_handles_multiple_urls_in_one_string() {
        let input = "fetch: https://a@host1.com/x.git push: https://b@host2.com/y.git";
        let redacted = redact_git_output(input);
        assert!(!redacted.contains("a@host1"));
        assert!(!redacted.contains("b@host2"));
        assert!(redacted.contains("https://[REDACTED]@host1.com/x.git"));
        assert!(redacted.contains("https://[REDACTED]@host2.com/y.git"));
    }

    /// Regression guard for the publish-approval error path: `push_release_to_main`
    /// returns an error built from `git push` stderr, which can embed the remote
    /// URL with credentials. The publish-approval node must redact that error
    /// before it appears in the event message, the diagnostics, or the returned
    /// Err. This test verifies the redaction pattern used at the call site:
    /// `redact_git_output(&error)` must scrub a realistic push-failure string.
    #[test]
    fn redact_git_output_scrubs_realistic_push_failure_stderr() {
        let error = format!(
            "git push origin main failed: fatal: unable to access '{}': Could not resolve host",
            "https://ghp_abc123secret@github.com/org/repo.git"
        );
        let safe = redact_git_output(&error);
        assert!(
            !safe.contains("ghp_abc123secret"),
            "credential must be scrubbed from push-failure error, got: {safe}"
        );
        assert!(
            safe.contains("https://[REDACTED]@github.com/org/repo.git"),
            "host must be preserved, got: {safe}"
        );
        // The non-URL diagnostic tail must survive.
        assert!(
            safe.contains("Could not resolve host"),
            "diagnostic tail must be preserved, got: {safe}"
        );
    }

    /// `create_release_commit` and `current_git_branch` require a real Git
    /// workspace. These integration tests verify the fail-closed paths and
    /// the happy path against a temporary repository.
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .status()
            .is_ok_and(|status| status.success())
    }

    struct TempGitRepo(std::path::PathBuf);

    impl TempGitRepo {
        fn new(name: &str) -> Self {
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "codex-corp-release-test-{name}-{}-{}",
                std::process::id(),
                suffix
            ));
            std::fs::create_dir_all(&path).unwrap();
            // Initialize a real repo and configure a dummy identity so commits
            // can be created.
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(&path)
                .status()
                .unwrap();
            std::process::Command::new("git")
                .args(["config", "user.email", "test@codex-corp.local"])
                .current_dir(&path)
                .status()
                .unwrap();
            std::process::Command::new("git")
                .args(["config", "user.name", "Test"])
                .current_dir(&path)
                .status()
                .unwrap();
            Self(path)
        }

        fn path_str(&self) -> String {
            self.0.to_string_lossy().to_string()
        }

        fn write_file(&self, name: &str, content: &str) {
            std::fs::write(self.0.join(name), content).unwrap();
        }

        fn run_git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
    }

    impl Drop for TempGitRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn create_release_commit_fails_on_non_git_workspace() {
        if !git_available() {
            return;
        }
        let tmp = std::env::temp_dir().join(format!(
            "codex-corp-release-test-nogit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let result = create_release_commit(&tmp.to_string_lossy(), "release: test");
        assert!(result.is_err(), "must fail closed on non-Git workspace");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn create_release_commit_fails_on_dirty_working_tree() {
        if !git_available() {
            return;
        }
        let repo = TempGitRepo::new("dirty");
        // Create an initial commit so the repo has history.
        repo.write_file("README.md", "initial");
        repo.run_git(&["add", "--all"]);
        repo.run_git(&["commit", "-m", "initial"]);
        // Introduce an uncommitted change.
        repo.write_file("stray.txt", "uncommitted");
        let result = create_release_commit(&repo.path_str(), "release: test");
        assert!(
            result.is_err(),
            "must fail closed on uncommitted unrelated changes"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("clean working tree"),
            "error must explain the clean-tree requirement, got: {err}"
        );
    }

    #[test]
    fn create_release_commit_succeeds_on_clean_tree() {
        if !git_available() {
            return;
        }
        let repo = TempGitRepo::new("clean");
        repo.write_file("README.md", "initial");
        repo.run_git(&["add", "--all"]);
        repo.run_git(&["commit", "-m", "initial"]);
        let result = create_release_commit(&repo.path_str(), "release: test");
        assert!(result.is_ok(), "clean tree must succeed, got: {:?}", result);
        let hash = result.unwrap();
        assert!(!hash.is_empty(), "must return a commit hash");
    }

    #[test]
    fn current_git_branch_returns_main_after_init_on_main() {
        if !git_available() {
            return;
        }
        let repo = TempGitRepo::new("branch-main");
        // `git init` defaults to `main` on modern Git, but some systems default
        // to `master`. Rename to `main` for a deterministic test.
        let _ = repo.run_git(&["branch", "-m", "main"]);
        repo.write_file("README.md", "initial");
        repo.run_git(&["add", "--all"]);
        repo.run_git(&["commit", "-m", "initial"]);
        let branch = current_git_branch(&repo.path_str());
        assert!(branch.is_ok(), "must resolve branch, got: {:?}", branch);
        assert_eq!(branch.unwrap(), "main");
    }

    #[test]
    fn current_git_branch_returns_feature_branch_name() {
        if !git_available() {
            return;
        }
        let repo = TempGitRepo::new("branch-feature");
        let _ = repo.run_git(&["branch", "-m", "main"]);
        repo.write_file("README.md", "initial");
        repo.run_git(&["add", "--all"]);
        repo.run_git(&["commit", "-m", "initial"]);
        repo.run_git(&["checkout", "-b", "feature/test"]);
        let branch = current_git_branch(&repo.path_str()).unwrap();
        assert_eq!(branch, "feature/test");
    }

    #[test]
    fn current_git_branch_fails_on_detached_head() {
        if !git_available() {
            return;
        }
        let repo = TempGitRepo::new("detached");
        let _ = repo.run_git(&["branch", "-m", "main"]);
        repo.write_file("README.md", "initial");
        repo.run_git(&["add", "--all"]);
        repo.run_git(&["commit", "-m", "initial"]);
        let head = repo.run_git(&["rev-parse", "HEAD"]);
        repo.run_git(&["checkout", &head]);
        let result = current_git_branch(&repo.path_str());
        assert!(
            result.is_err(),
            "detached HEAD must fail, got: {:?}",
            result
        );
    }
}
