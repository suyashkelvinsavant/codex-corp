//! Command verifier — allowlisted host commands only (fail-closed).

use std::io::Read;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::platform_process::background_command;

/// Allowlisted command templates (plan III.6).
pub const COMMAND_TEMPLATES: &[&str] = &[
    "npm_test",
    "npm_run_build",
    "cargo_test",
    "cargo_check",
    "node_script",
];

pub fn is_allowed_template(template_id: &str) -> bool {
    COMMAND_TEMPLATES.contains(&template_id)
}

pub trait CommandRunner: Send + Sync {
    fn run(
        &self,
        program: &str,
        args: &[&str],
        cwd: &Path,
        stop: &AtomicBool,
    ) -> Result<CommandOutcome, String>;
}

#[derive(Debug, Clone)]
pub struct CommandOutcome {
    pub exit_code: i32,
    #[allow(dead_code)] // reserved for richer verifier detail / logs
    pub stdout: String,
    pub stderr: String,
}

/// Real process runner with stop-token polling and PATH-confined cwd.
pub struct ProcessCommandRunner {
    pub timeout: Duration,
}

impl Default for ProcessCommandRunner {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(120),
        }
    }
}

impl CommandRunner for ProcessCommandRunner {
    fn run(
        &self,
        program: &str,
        args: &[&str],
        cwd: &Path,
        stop: &AtomicBool,
    ) -> Result<CommandOutcome, String> {
        if stop.load(Ordering::SeqCst) {
            return Err("run interrupted before command".into());
        }
        if !cwd.is_dir() {
            return Err(format!("command cwd is not a directory: {}", cwd.display()));
        }
        // Path-confine: resolve and ensure cwd stays under itself (no .. escape at start).
        let cwd = cwd
            .canonicalize()
            .map_err(|e| format!("command cwd resolve failed: {e}"))?;

        let mut cmd = background_command(program);
        cmd.args(args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        // Inherits parent env (required for PATH-based toolchain discovery of npm/cargo/node).
        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {program}: {e}"))?;
        let process_tree = ProcessTreeGuard::attach(&child);
        let output = wait_with_stop(child, process_tree, stop, self.timeout)?;
        Ok(CommandOutcome {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn wait_with_stop(
    mut child: std::process::Child,
    process_tree: ProcessTreeGuard,
    stop: &AtomicBool,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    const CAPTURE_LIMIT: usize = 1024 * 1024;
    let stdout = child.stdout.take().ok_or("command stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("command stderr pipe missing")?;
    let stdout_reader = std::thread::spawn(move || drain_bounded(stdout, CAPTURE_LIMIT));
    let stderr_reader = std::thread::spawn(move || drain_bounded(stderr, CAPTURE_LIMIT));
    let start = std::time::Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            process_tree.terminate(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err("run interrupted during command".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader.join().unwrap_or_default();
                let stderr = stderr_reader.join().unwrap_or_default();
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    process_tree.terminate(&mut child);
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err("command timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("command poll failed: {e}")),
        }
    }
}

fn drain_bounded(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let remaining = limit.saturating_sub(captured.len());
                captured.extend_from_slice(&chunk[..n.min(remaining)]);
            }
        }
    }
    captured
}

pub(crate) struct ProcessTreeGuard {
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl ProcessTreeGuard {
    pub(crate) fn attach(child: &std::process::Child) -> Self {
        Self {
            #[cfg(windows)]
            job: WindowsJob::assign(child.id()),
        }
    }

    pub(crate) fn terminate(&self, child: &mut std::process::Child) {
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                job.terminate();
            } else {
                // Last-resort fallback when the parent process job policy rejects nesting.
                let _ = background_command("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{}", child.id())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
    }
}

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// Windows kernel job handles are process-independent owned handles. The guard
// is held behind synchronization before any operation, so transferring the
// owned handle between worker threads is safe.
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn assign(pid: u32) -> Option<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == FALSE
            {
                CloseHandle(job);
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }
            let assigned = AssignProcessToJobObject(job, process) != FALSE;
            CloseHandle(process);
            if !assigned {
                CloseHandle(job);
                return None;
            }
            Some(Self(job))
        }
    }

    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Resolve allowlisted template to (program, args).
pub fn resolve_template(
    template_id: &str,
    instruction: Option<&str>,
) -> Result<(String, Vec<String>), String> {
    if !is_allowed_template(template_id) {
        return Err(format!("command template not allowlisted: {template_id}"));
    }
    #[cfg(windows)]
    let npm = "npm.cmd".to_string();
    #[cfg(not(windows))]
    let npm = "npm".to_string();

    match template_id {
        // Generic project test script — do not pass runner-specific flags (e.g. vitest --run).
        // Operators should set "test": "vitest run" (or equivalent) in package.json.
        "npm_test" => Ok((npm, vec!["test".into()])),
        "npm_run_build" => Ok((npm, vec!["run".into(), "build".into()])),
        // Let cargo discover the manifest from the runner cwd (workflow workspace root).
        // Operators enabling cargo_* must have a Cargo.toml discoverable from that cwd
        // (nested monorepos like this product's src-tauri/ layout need a root manifest
        // or a future path-confined cargoManifest field — not hardcoded here).
        "cargo_test" => Ok(("cargo".into(), vec!["test".into()])),
        "cargo_check" => Ok(("cargo".into(), vec!["check".into()])),
        "node_script" => {
            let script = instruction
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "node_script requires instruction path to a trusted script".to_string()
                })?;
            // Only relative paths under cwd; reject absolute and parent traversal.
            if Path::new(script).is_absolute() || script.contains("..") || script.starts_with('~') {
                return Err("node_script path must be relative and path-confined".into());
            }
            Ok(("node".into(), vec![script.to_string()]))
        }
        other => Err(format!("unknown command template: {other}")),
    }
}

/// Evaluate command criterion. Returns true if failed.
pub fn command_failed(
    runner: &dyn CommandRunner,
    template_id: Option<&str>,
    instruction: Option<&str>,
    cwd: &Path,
    stop: &AtomicBool,
) -> (bool, String) {
    let Some(template_id) = template_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return (true, "command criterion missing templateId".into());
    };
    let (program, args) = match resolve_template(template_id, instruction) {
        Ok(v) => v,
        Err(e) => return (true, e),
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match runner.run(&program, &arg_refs, cwd, stop) {
        Ok(outcome) if outcome.exit_code == 0 => (false, format!("{template_id} exited 0")),
        Ok(outcome) => (
            true,
            format!(
                "{template_id} exited {} — {}",
                outcome.exit_code,
                truncate(&outcome.stderr, 400)
            ),
        ),
        Err(e) => (true, e),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        return t.to_string();
    }
    // Floor to a char boundary so multi-byte UTF-8 never panics mid-codepoint.
    let mut end = max.min(t.len());
    while end > 0 && !t.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &t[..end])
}

/// In-memory fake for unit tests.
#[cfg(test)]
pub struct FakeCommandRunner {
    pub outcomes: std::sync::Mutex<std::collections::HashMap<String, CommandOutcome>>,
    pub default_exit: i32,
}

#[cfg(test)]
impl FakeCommandRunner {
    pub fn new(default_exit: i32) -> Self {
        Self {
            outcomes: std::sync::Mutex::new(std::collections::HashMap::new()),
            default_exit,
        }
    }
}

#[cfg(test)]
impl CommandRunner for FakeCommandRunner {
    fn run(
        &self,
        program: &str,
        args: &[&str],
        _cwd: &Path,
        stop: &AtomicBool,
    ) -> Result<CommandOutcome, String> {
        if stop.load(Ordering::SeqCst) {
            return Err("run interrupted".into());
        }
        let key = format!("{program} {}", args.join(" "));
        let map = self.outcomes.lock().unwrap();
        if let Some(o) = map.get(program).or_else(|| map.get(&key)) {
            return Ok(o.clone());
        }
        Ok(CommandOutcome {
            exit_code: self.default_exit,
            stdout: String::new(),
            stderr: if self.default_exit == 0 {
                String::new()
            } else {
                "default fail".into()
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_rejects_unknown() {
        assert!(resolve_template("rm_rf", None).is_err());
    }

    #[test]
    fn command_exit_0_pass() {
        let fake = FakeCommandRunner::new(0);
        let stop = AtomicBool::new(false);
        let (failed, _) = command_failed(&fake, Some("npm_test"), None, Path::new("."), &stop);
        assert!(!failed);
    }

    #[test]
    fn command_exit_1_fail() {
        let fake = FakeCommandRunner::new(1);
        let stop = AtomicBool::new(false);
        let (failed, detail) = command_failed(&fake, Some("npm_test"), None, Path::new("."), &stop);
        assert!(failed);
        assert!(detail.contains("exited") || detail.contains("fail"));
    }

    #[test]
    fn node_script_rejects_parent_traversal() {
        assert!(resolve_template("node_script", Some("../evil.js")).is_err());
    }

    #[test]
    fn npm_test_is_generic_test_script_without_runner_flags() {
        let (program, args) = resolve_template("npm_test", None).expect("npm_test allowlisted");
        assert!(program == "npm" || program == "npm.cmd");
        assert_eq!(args, vec!["test".to_string()]);
        assert!(
            !args.iter().any(|a| a == "--run" || a == "--"),
            "npm_test must not bake vitest/jest runner flags: {args:?}"
        );
    }

    #[test]
    fn truncate_handles_multibyte_at_boundary() {
        let s = "é".repeat(300);
        let out = truncate(&s, 10);
        assert!(out.ends_with('…'));
        // Must not panic; result is valid UTF-8 shorter/equal than max+ellipsis.
        assert!(out.is_char_boundary(out.len() - '…'.len_utf8()));
    }

    #[test]
    fn cargo_test_does_not_hardcode_monorepo_manifest() {
        let (program, args) = resolve_template("cargo_test", None).expect("cargo_test allowlisted");
        assert_eq!(program, "cargo");
        assert_eq!(args, vec!["test".to_string()]);
        assert!(
            !args
                .iter()
                .any(|a| a.contains("src-tauri") || a.contains("manifest-path")),
            "cargo_test must not hardcode this monorepo path: {args:?}"
        );
        let (program, args) =
            resolve_template("cargo_check", None).expect("cargo_check allowlisted");
        assert_eq!(program, "cargo");
        assert_eq!(args, vec!["check".to_string()]);
        assert!(
            !args
                .iter()
                .any(|a| a.contains("src-tauri") || a.contains("manifest-path")),
            "cargo_check must not hardcode this monorepo path: {args:?}"
        );
    }

    #[test]
    fn real_runner_drains_large_stdout_and_stderr() {
        let runner = ProcessCommandRunner {
            timeout: Duration::from_secs(15),
        };
        let stop = AtomicBool::new(false);
        #[cfg(windows)]
        let (program, args) = (
            "powershell",
            vec![
                "-NoProfile",
                "-Command",
                "$s='x'*131072; [Console]::Out.Write($s); [Console]::Error.Write($s)",
            ],
        );
        #[cfg(unix)]
        let (program, args) = (
            "sh",
            vec!["-c", "yes x | head -c 131072; yes y | head -c 131072 >&2"],
        );
        let out = runner.run(program, &args, Path::new("."), &stop).unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.len() >= 128 * 1024);
        assert!(out.stderr.len() >= 128 * 1024);
    }
}
