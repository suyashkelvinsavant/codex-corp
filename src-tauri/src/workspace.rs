use std::{fs, path::Path, process::Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceGitState {
    Existing,
    Initialized,
    Skipped,
}

pub(crate) fn prepare_workspace_git(
    workspace: &Path,
    initialize: bool,
) -> Result<WorkspaceGitState, String> {
    if !workspace.is_dir() {
        return Err("selected workspace is not a folder".into());
    }
    if !initialize {
        return Ok(WorkspaceGitState::Skipped);
    }
    if git_is_repository(workspace)? {
        return Ok(WorkspaceGitState::Existing);
    }

    let git_path = workspace.join(".git");
    if git_path.exists() {
        let metadata = fs::symlink_metadata(&git_path)
            .map_err(|error| format!("could not inspect invalid .git entry: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !directory_is_empty(&git_path)?
        {
            return Err(
                "workspace has an invalid .git entry; refusing to overwrite existing data".into(),
            );
        }
        fs::remove_dir(&git_path)
            .map_err(|error| format!("could not remove empty invalid .git entry: {error}"))?;
    }

    let output = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("Git is required for a new workspace: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git init failed: {}",
            bounded_command_output(&output.stderr)
        ));
    }
    if !git_is_repository(workspace)? {
        return Err("git init completed without creating a valid repository".into());
    }
    Ok(WorkspaceGitState::Initialized)
}

fn git_is_repository(workspace: &Path) -> Result<bool, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("Git is required for a new workspace: {error}"))?;
    Ok(output.status.success())
}

fn directory_is_empty(path: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("could not inspect invalid .git entry: {error}"))?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|error| error.to_string())?
        .is_none())
}

fn bounded_command_output(bytes: &[u8]) -> String {
    let output = String::from_utf8_lossy(bytes).trim().to_string();
    if output.is_empty() {
        return "no diagnostic output".into();
    }
    output.chars().take(600).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempWorkspace(PathBuf);

    impl TempWorkspace {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be available")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "codex-corp-workspace-{name}-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test workspace should be creatable");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .status()
            .is_ok_and(|status| status.success())
    }

    fn valid_git_repository(path: &Path) -> bool {
        Command::new("git")
            .args([
                "-C",
                path.to_string_lossy().as_ref(),
                "rev-parse",
                "--git-dir",
            ])
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[test]
    fn greenfield_workspace_initializes_a_real_repository() {
        if !git_available() {
            return;
        }
        let workspace = TempWorkspace::new("greenfield");
        fs::write(workspace.path().join("package.json"), "{}").expect("fixture should be writable");

        let state = prepare_workspace_git(workspace.path(), true).expect("git init should pass");

        assert_eq!(state, WorkspaceGitState::Initialized);
        assert!(valid_git_repository(workspace.path()));
    }

    #[test]
    fn existing_repository_is_idempotent_and_not_reinitialized() {
        if !git_available() {
            return;
        }
        let workspace = TempWorkspace::new("existing");
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(workspace.path())
            .status()
            .expect("git should be executable");
        assert!(init.success());

        let state = prepare_workspace_git(workspace.path(), true).expect("valid repo is safe");

        assert_eq!(state, WorkspaceGitState::Existing);
        assert!(valid_git_repository(workspace.path()));
    }

    #[test]
    fn empty_git_placeholder_is_repaired_without_touching_project_files() {
        if !git_available() {
            return;
        }
        let workspace = TempWorkspace::new("empty-git");
        let source = workspace.path().join("src");
        fs::create_dir_all(&source).expect("source fixture should be creatable");
        fs::write(source.join("main.ts"), "export {};").expect("source fixture should be writable");
        fs::create_dir(workspace.path().join(".git")).expect("placeholder should be creatable");

        let state = prepare_workspace_git(workspace.path(), true)
            .expect("an empty placeholder is safe to repair");

        assert_eq!(state, WorkspaceGitState::Initialized);
        assert!(valid_git_repository(workspace.path()));
        assert_eq!(
            fs::read_to_string(source.join("main.ts")).unwrap(),
            "export {};"
        );
    }

    #[test]
    fn nonempty_invalid_git_entry_fails_closed_and_is_preserved() {
        let workspace = TempWorkspace::new("invalid-git");
        let git_dir = workspace.path().join(".git");
        fs::create_dir(&git_dir).expect("placeholder should be creatable");
        let marker = git_dir.join("operator-data");
        fs::write(&marker, "preserve me").expect("marker should be writable");

        let error = prepare_workspace_git(workspace.path(), true)
            .expect_err("unknown .git contents must not be overwritten");

        assert!(error.contains("invalid .git"));
        assert_eq!(fs::read_to_string(marker).unwrap(), "preserve me");
    }

    #[test]
    fn existing_project_mode_never_creates_or_repairs_git() {
        let workspace = TempWorkspace::new("existing-mode");

        let state = prepare_workspace_git(workspace.path(), false)
            .expect("existing projects should be left unchanged");

        assert_eq!(state, WorkspaceGitState::Skipped);
        assert!(!workspace.path().join(".git").exists());
    }
}
