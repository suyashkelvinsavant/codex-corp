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

    if policy != POLICY_NATIVE_RUNTIME_OWNERSHIP_V1 {
        return ArchitectureResult {
            failed: true,
            detail: format!("unknown architecture policy: {policy}"),
            residual_risks: vec!["unknown_architecture_policy".into()],
            used_producer_path_fallback: false,
        };
    }

    let (paths, residual, producer_fallback) = collect_paths(workspace);
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

fn collect_paths(workspace: &Path) -> (Vec<String>, Vec<String>, bool) {
    let mut residual = Vec::new();
    // git-first: always scan tracked ∪ dirty so committed suspects stay visible
    // even when the worktree has unrelated dirty files.
    if let Some(paths) = git_policy_paths(workspace) {
        return (paths, residual, false);
    }
    residual.push("architecture_git_unavailable_producer_path_fallback".into());
    // Fallback: shallow walk of common roots only (bounded).
    let mut paths = Vec::new();
    for root in ["src", "src-tauri", "packages", "lib"] {
        let dir = workspace.join(root);
        if dir.is_dir() {
            walk_shallow(&dir, workspace, &mut paths, 0, 3);
        }
    }
    (paths, residual, true)
}

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
    if depth > max_depth || out.len() > 2000 {
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
