//! Architecture policy verifier — git-first native runtime ownership check.

use std::collections::BTreeSet;
use std::path::Path;

use crate::platform_process::background_command;

/// Built-in policy: native Tauri/Rust runtime ownership patterns.
///
/// **Pattern-scoped (N4):** this policy only flags known scheduling/runtime path
/// shapes (`SUSPECT_GLOBS`) and checks for native markers under `src-tauri/`.
/// Unanticipated names (e.g. `src/scheduler/`, `job_runner.ts`) are not detected —
/// a pass means "no known-bad placement," not "every possible runtime is native."
/// Residual risks surface when markers are absent or git is unavailable.
pub const POLICY_NATIVE_RUNTIME_OWNERSHIP_V1: &str = "native_runtime_ownership_v1";

/// Built-in policy: **structural** wrong-layer detection by shape, not by deny-list.
///
/// **Pattern-scoped (N4)** `v1` only flags fixed `SUSPECT_GLOBS`; an
/// unanticipated shortcut (`src/scheduler/job_runner.ts`) passes clean. `v2`
/// closes that gap by detecting producer-side scheduler/workflow ownership from
/// **shape**:
///
/// 1. **Control flow by shape** — a producer-root path that reads like a
///    runtime/scheduler/executor/worker module *and* whose content contains
///    retry/tick/schedule control flow (`setInterval`, `setTimeout`, poll loops,
///    `while(true)`, `retry(`, `backoff`, `cron`, `schedule`, …).
/// 2. **Import provenance** — producer-root content that imports/requires a
///    runtime-owned module (`workflow_runtime`, `agent_runtime`, `agent-runtime`,
///    `workflow-executor`, `/runtime`, `src-tauri`), i.e. TS pulling the runtime
///    into the producer layer.
///
/// Like `v1`, a pass still requires a native marker under `src-tauri/` (fail
/// closed when absent). Detection is read-only and bounded (no index/hooks).
pub const POLICY_NATIVE_RUNTIME_OWNERSHIP_V2: &str = "native_runtime_ownership_v2";

/// Paths that must not appear under wrong ownership (suspect producer-side runtime).
/// Intentionally narrow — see policy doc comment on pattern-scoped coverage.
const SUSPECT_GLOBS: &[&str] = &[
    "src/runtime/",
    "src/agent-runtime/",
    "src/workflow-executor/",
    "packages/runtime/",
    "lib/workflow_runtime.",
    "lib/agent_executor.",
];

/// Producer-side runtime/scheduler/executor infixes. A path under a producer
/// root that contains one of these "reads" like a scheduling/workflow layer —
/// v2 then confirms with content control-flow markers (shape, not name).
const SUSPECT_LAYER_INFIX: &[&str] = &[
    "scheduler",
    "job_runner",
    "job-runner",
    "jobrunner",
    "workflow-executor",
    "workflow_executor",
    "workflow-engine",
    "workflow_engine",
    "agent-runtime",
    "agent_runtime",
    "orchestrat",
    "dispatcher",
    "retry-loop",
    "retry_loop",
    "poll-loop",
    "poll_loop",
    "tick-loop",
    "tick_loop",
    "jobqueue",
    "job-queue",
    "job_queue",
    "process-queue",
    "process_queue",
    "runtime/index",
    "runtime/engine",
    "runtime/runner",
    "runtime/orchestrat",
    "worker/pool",
    "worker_pool",
];

/// Content control-flow markers confirming an infix path is really a
/// retry/tick/schedule loop (secondary guard against false positives).
const CONTROL_FLOW_MARKERS: &[&str] = &[
    "setinterval(",
    "settimeout(",
    "while (true)",
    "while(true)",
    "requestanimationframe",
    "retry(",
    "backoff",
    "schedule(",
    "scheduler.",
    "cron",
    "poll(",
    "dispatch(",
    ".tick(",
    "tick(",
];

/// Import specifiers that pull runtime ownership into a producer TS module.
const SUSPECT_IMPORT_SPECIFIERS: &[&str] = &[
    "workflow_runtime",
    "workflow-runtime",
    "agent_runtime",
    "agent-runtime",
    "workflow-executor",
    "workflow_executor",
    "/runtime",
    "runtime/index",
    "runtime/dispatch",
    "lib/runtime",
    "src-tauri",
    "scheduler",
];

/// Producer roots that must never own runtime behavior (`src-tauri` is native).
const PRODUCER_ROOTS: &[&str] = &["src/", "packages/", "lib/"];

/// Hard cap on scanned bytes per file (protection against huge vendored files).
const MAX_SHAPE_BYTES: usize = 1_048_576;

/// Paths that indicate correct native ownership (presence is good signal).
const NATIVE_MARKERS: &[&str] = &[
    "src-tauri/src/workflow_runtime.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/Cargo.toml",
];

#[derive(Debug, Clone)]
pub struct ArchitectureResult {
    pub failed: bool,
    pub detail: String,
    pub residual_risks: Vec<String>,
    #[allow(dead_code)]
    pub used_producer_path_fallback: bool,
}

/// Evaluate architecture policy. Prefer git porcelain paths; fall back to walk.
pub fn architecture_policy_failed(policy_id: Option<&str>, workspace: &Path) -> ArchitectureResult {
    let policy = policy_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(POLICY_NATIVE_RUNTIME_OWNERSHIP_V1);

    if !matches!(
        policy,
        POLICY_NATIVE_RUNTIME_OWNERSHIP_V1 | POLICY_NATIVE_RUNTIME_OWNERSHIP_V2
    ) {
        return ArchitectureResult {
            failed: true,
            detail: format!("unknown architecture policy: {policy}"),
            residual_risks: vec!["unknown_architecture_policy".into()],
            used_producer_path_fallback: false,
        };
    }

    let (paths, residual, producer_fallback) = collect_paths(workspace);
    if policy == POLICY_NATIVE_RUNTIME_OWNERSHIP_V2 {
        return architecture_policy_failed_v2(workspace, &paths, residual, producer_fallback);
    }

    let mut hits = Vec::new();
    for path in &paths {
        let normalized = path.replace('\\', "/");
        for suspect in SUSPECT_GLOBS {
            if normalized.contains(suspect) {
                hits.push(normalized.clone());
                break;
            }
        }
    }

    if !hits.is_empty() {
        return ArchitectureResult {
            failed: true,
            detail: format!(
                "architecture_policy {}: suspect runtime ownership paths: {}",
                policy,
                hits.into_iter().take(5).collect::<Vec<_>>().join(", ")
            ),
            residual_risks: residual,
            used_producer_path_fallback: producer_fallback,
        };
    }

    // Soft pass when native markers exist or no suspects found.
    let has_native = NATIVE_MARKERS.iter().any(|m| workspace.join(m).exists());
    if !has_native {
        let mut risks = residual;
        risks.push("architecture_native_markers_absent".into());
        return ArchitectureResult {
            // Pattern-scoped claim: without markers, fail closed for required policy.
            failed: true,
            detail: format!(
                "architecture_policy {policy}: no native runtime markers under src-tauri/"
            ),
            residual_risks: risks,
            used_producer_path_fallback: producer_fallback,
        };
    }

    ArchitectureResult {
        failed: false,
        detail: format!("architecture_policy {policy}: native markers present; no suspect paths"),
        residual_risks: residual,
        used_producer_path_fallback: producer_fallback,
    }
}

/// v2: structural wrong-layer detection by shape (control flow + import
/// provenance under producer roots) with the same native-marker fail-closed.
fn architecture_policy_failed_v2(
    workspace: &Path,
    paths: &[String],
    mut residual: Vec<String>,
    producer_fallback: bool,
) -> ArchitectureResult {
    let mut shape_hits = Vec::new();
    for path in paths {
        let normalized = path.replace('\\', "/");
        // Only producer roots can host a wrong-layer runtime; src-tauri is native.
        if !PRODUCER_ROOTS
            .iter()
            .any(|root| normalized.starts_with(root))
        {
            continue;
        }
        // Generated protocol stubs (codex app-server TS client) are never a
        // producer-side runtime — and are out of scope by convention.
        if normalized.starts_with("src/generated/") {
            continue;
        }
        let rel = normalized.trim_start_matches("./");
        let infix_hit = SUSPECT_LAYER_INFIX
            .iter()
            .any(|infix| rel.to_ascii_lowercase().contains(infix));
        let Some(content) = read_bounded(workspace, rel) else {
            continue;
        };
        if infix_hit && has_control_flow(&content) {
            shape_hits.push(format!("{rel} (scheduler/workflow control flow by shape)"));
        } else if import_provenance_suspect(&content) {
            shape_hits.push(format!("{rel} (imports runtime-owned module)"));
        }
    }

    if !shape_hits.is_empty() {
        return ArchitectureResult {
            failed: true,
            detail: format!(
                "architecture_policy {}: producer-side scheduler/workflow ownership by shape: {}",
                POLICY_NATIVE_RUNTIME_OWNERSHIP_V2,
                shape_hits
                    .into_iter()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            residual_risks: residual,
            used_producer_path_fallback: producer_fallback,
        };
    }

    let has_native = NATIVE_MARKERS.iter().any(|m| workspace.join(m).exists());
    if !has_native {
        residual.push("architecture_native_markers_absent".into());
        return ArchitectureResult {
            failed: true,
            detail: format!(
                "architecture_policy {POLICY_NATIVE_RUNTIME_OWNERSHIP_V2}: no native runtime markers under src-tauri/"
            ),
            residual_risks: residual,
            used_producer_path_fallback: producer_fallback,
        };
    }

    ArchitectureResult {
        failed: false,
        detail: format!(
            "architecture_policy {POLICY_NATIVE_RUNTIME_OWNERSHIP_V2}: native markers present; no wrong-layer scheduler/workflow shape"
        ),
        residual_risks: residual,
        used_producer_path_fallback: producer_fallback,
    }
}

/// Read a repo-root-relative file, bounded to MAX_SHAPE_BYTES. None when
/// missing/unreadable/oversized (a dense binary or vendored blob is not a
/// producer runtime module — do not inspect it).
fn read_bounded(workspace: &Path, rel: &str) -> Option<String> {
    let path = workspace.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SHAPE_BYTES as u64 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// True when content contains retry/tick/schedule control flow (lowercased);
/// used only to confirm an infix path that already reads like a runtime layer.
fn has_control_flow(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    CONTROL_FLOW_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// True when an import/require statement pulls runtime-owned provenance into a
/// producer module (line-scoped to avoid matching prose/comments elsewhere and
/// file reads like `read("src-tauri/...")`).
fn import_provenance_suspect(content: &str) -> bool {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        // Only actual import/require constructs; a bare `const/let/var` with a
        // file read must not look like provenance.
        let is_import_statement =
            lower.starts_with("import") || lower.contains("require(") || lower.contains("import(");
        if !is_import_statement {
            continue;
        }
        if SUSPECT_IMPORT_SPECIFIERS
            .iter()
            .any(|specifier| lower.contains(specifier))
        {
            return true;
        }
    }
    false
}

fn collect_paths(workspace: &Path) -> (Vec<String>, Vec<String>, bool) {
    let mut residual = Vec::new();
    // git-first: always scan tracked ∪ dirty so committed suspects stay visible
    // even when the worktree has unrelated dirty files.
    if let Some(paths) = git_policy_paths(workspace) {
        return (paths, residual, false);
    }
    residual.push("architecture_git_unavailable_producer_path_fallback".into());
    // Fallback: shallow walk of common roots only (bounded by MAX_FALLBACK_PATHS).
    // Depth 6 reaches deep producer-nested runtimes like
    // `packages/foo/src/runtime/engine/loop.ts` that depth 3 missed (P6).
    let mut paths = Vec::new();
    for root in ["src", "src-tauri", "packages", "lib"] {
        let dir = workspace.join(root);
        if dir.is_dir() {
            walk_shallow(&dir, workspace, &mut paths, 0, FALLBACK_WALK_MAX_DEPTH);
        }
    }
    (paths, residual, true)
}

/// Fallback walk depth (no git). Chosen to reach producer runtimes nested up to
/// `packages/foo/src/runtime/engine/*` while staying bounded by path count.
const FALLBACK_WALK_MAX_DEPTH: usize = 6;
/// Hard cap on fallback-walked entries so a huge tarball cannot blow up memory.
const MAX_FALLBACK_PATHS: usize = 4000;

/// Union tracked (`ls-files`) with dirty/untracked porcelain paths.
/// Dirty-only is never the full policy universe (would miss committed suspects).
fn union_policy_paths(tracked: Vec<String>, dirty: Vec<String>) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for p in tracked.into_iter().chain(dirty) {
        let t = p.trim();
        if !t.is_empty() {
            set.insert(t.replace('\\', "/"));
        }
    }
    set.into_iter().collect()
}

fn git_ls_files(workspace: &Path) -> Option<Vec<String>> {
    let tracked = background_command("git")
        .args(["-C"])
        .arg(workspace)
        .args(["ls-files"])
        .output()
        .ok()?;
    if !tracked.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&tracked.stdout);
    Some(
        text.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
    )
}

fn git_status_porcelain_paths(workspace: &Path) -> Option<Vec<String>> {
    let output = background_command("git")
        .args(["-C"])
        .arg(workspace)
        .args(["status", "--porcelain", "-uall"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(
        text.lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.len() < 4 {
                    return None;
                }
                // porcelain: XY path (optionally " -> " for renames)
                Some(line[3..].trim().replace(" -> ", " ").to_string())
            })
            .filter(|p| !p.is_empty())
            .collect(),
    )
}

fn git_policy_paths(workspace: &Path) -> Option<Vec<String>> {
    let tracked = git_ls_files(workspace)?;
    let dirty = git_status_porcelain_paths(workspace).unwrap_or_default();
    Some(union_policy_paths(tracked, dirty))
}

fn walk_shallow(dir: &Path, root: &Path, out: &mut Vec<String>, depth: usize, max_depth: usize) {
    if depth > max_depth || out.len() > MAX_FALLBACK_PATHS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
        if path.is_dir() {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name == "node_modules" || name == "target" || name == ".git" {
                continue;
            }
            walk_shallow(&path, root, out, depth + 1, max_depth);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn native_workspace_passes() {
        // This repo itself should pass when run from workspace root.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let result = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V1), root);
        assert!(!result.failed, "{}", result.detail);
    }

    #[test]
    fn unknown_policy_fails() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = architecture_policy_failed(Some("nope_v9"), root);
        assert!(result.failed);
    }

    #[test]
    fn native_workspace_passes_v2() {
        // Structural policy must not false-positive on this repository's own
        // TS producer code (UI helpers, cron-trigger, workflow-architect, …).
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let result = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V2), root);
        assert!(!result.failed, "{}", result.detail);
    }

    #[test]
    fn unexpected_wrong_layer_shape_fails_v2_but_passes_v1() {
        let tmp = std::env::temp_dir().join(format!("arch-pol-v2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        // Native marker present (required for a soft v1 pass).
        fs::create_dir_all(tmp.join("src-tauri/src")).unwrap();
        fs::write(tmp.join("src-tauri/src/workflow_runtime.rs"), "x").unwrap();
        // Unanticipated wrong-layer scheduler: name is NOT in v1 SUSPECT_GLOBS,
        // but shape (path infix + retry/tick control flow) must trip v2.
        fs::create_dir_all(tmp.join("src/scheduler")).unwrap();
        fs::write(
            tmp.join("src/scheduler/job_runner.ts"),
            "export function start() {\n  const queue: Job[] = [];\n  setInterval(() => { retry(queue); }, 5000);\n}",
        )
        .unwrap();
        // v1: no glob match + native marker present → passes clean (the gap).
        let v1 = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V1), &tmp);
        assert!(
            !v1.failed,
            "v1 must not catch unanticipated names: {}",
            v1.detail
        );
        // v2: structural shape detection fails closed.
        let v2 = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V2), &tmp);
        assert!(v2.failed, "v2 must catch wrong-layer shape: {}", v2.detail);
        assert!(
            v2.detail.contains("src/scheduler/job_runner.ts"),
            "v2 detail should name the offending module: {}",
            v2.detail
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn import_provenance_wrong_layer_fails_v2() {
        let tmp = std::env::temp_dir().join(format!("arch-pol-v2-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src-tauri/src")).unwrap();
        fs::write(tmp.join("src-tauri/src/workflow_runtime.rs"), "x").unwrap();
        fs::create_dir_all(tmp.join("src/flow")).unwrap();
        fs::write(
            tmp.join("src/flow/dispatch.ts"),
            "import { dispatchTurn } from '../workflow_runtime';\nexport const run = () => dispatchTurn();",
        )
        .unwrap();
        let v2 = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V2), &tmp);
        assert!(
            v2.failed,
            "v2 must catch runtime import provenance: {}",
            v2.detail
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn deep_unanticipated_layer_fails_v2_under_no_git_fallback() {
        // P6: the no-git fallback walk must reach a deeply nested producer
        // runtime (`packages/foo/src/runtime/engine/loop.ts`, depth 5) that a
        // depth-3 walk previously missed — the tarball-audit blind spot.
        let tmp = std::env::temp_dir().join(format!("arch-pol-v2-deep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        // Native marker present so a pass would be a clean v2 pass otherwise.
        fs::create_dir_all(tmp.join("src-tauri/src")).unwrap();
        fs::write(tmp.join("src-tauri/src/workflow_runtime.rs"), "x").unwrap();
        // Deep, unanticipated layer: name shape is not in v1 SUSPECT_GLOBS and
        // sits 5 levels under `packages/`.
        let deep = tmp.join("packages/foo/src/runtime/engine/loop.ts");
        fs::create_dir_all(deep.parent().unwrap()).unwrap();
        fs::write(
            &deep,
            "export function start() {\n  setInterval(() => { retry(pump); }, 1000);\n  while(true) { tick(); }\n}",
        )
        .unwrap();
        let result = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V2), &tmp);
        assert!(
            result.failed,
            "v2 must catch the deep wrong-layer runtime under the no-git fallback: {}",
            result.detail
        );
        assert!(
            result
                .detail
                .contains("packages/foo/src/runtime/engine/loop.ts"),
            "v2 detail must name the deep offending module: {}",
            result.detail
        );
        assert!(
            result
                .residual_risks
                .iter()
                .any(|risk| risk == "architecture_git_unavailable_producer_path_fallback"),
            "the no-git fallback residual must be recorded: {:?}",
            result.residual_risks
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn producer_helper_without_control_flow_does_not_fail_v2() {
        // A UI helper under an infix path (e.g. `worker` label) with no
        // scheduling control flow must not trip the shape detector.
        let tmp = std::env::temp_dir().join(format!("arch-pol-v2-ok-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src-tauri/src")).unwrap();
        fs::write(tmp.join("src-tauri/src/workflow_runtime.rs"), "x").unwrap();
        fs::create_dir_all(tmp.join("src/worker-pool-ui")).unwrap();
        fs::write(
            tmp.join("src/worker-pool-ui/card.tsx"),
            "export function WorkerCard() { return <div>status</div>; }",
        )
        .unwrap();
        let v2 = architecture_policy_failed(Some(POLICY_NATIVE_RUNTIME_OWNERSHIP_V2), &tmp);
        assert!(!v2.failed, "no control flow must pass v2: {}", v2.detail);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn suspect_path_detection() {
        let tmp = std::env::temp_dir().join(format!("arch-pol-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src/runtime")).unwrap();
        fs::write(tmp.join("src/runtime/exec.ts"), "x").unwrap();
        // No git → fallback walk; suspects should hit.
        let result = architecture_policy_failed(None, &tmp);
        assert!(result.failed, "{}", result.detail);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn union_keeps_tracked_suspect_when_unrelated_dirty() {
        let tracked = vec!["src/runtime/exec.ts".into(), "src-tauri/src/lib.rs".into()];
        let dirty = vec!["README.md".into()];
        let paths = union_policy_paths(tracked, dirty);
        assert!(
            paths.iter().any(|p| p.contains("src/runtime/")),
            "tracked suspect must remain in policy universe: {paths:?}"
        );
        assert!(paths.iter().any(|p| p == "README.md"));
    }

    #[test]
    fn dirty_only_without_tracked_union_would_miss_suspect() {
        // Documents the bug: dirty-only universe lacks committed suspects.
        let dirty_only = vec!["README.md".to_string()];
        assert!(!dirty_only.iter().any(|p| p.contains("src/runtime/")));
        let fixed = union_policy_paths(vec!["src/runtime/exec.ts".into()], dirty_only);
        assert!(fixed.iter().any(|p| p.contains("src/runtime/")));
    }
}
