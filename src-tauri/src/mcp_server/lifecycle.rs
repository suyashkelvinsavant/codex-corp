//! MCP server process lifecycle: start / stop / status (embedded + external PID file).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::host::McpHost;
use super::socket_addr;
use super::transport;
use super::McpServerConfig;
use crate::{app_data_dir, mcp_stop_file_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub endpoint: String,
    pub transport: String,
    pub host: String,
    pub port: u16,
    pub pid: u32,
    pub mode: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub owner_id: String,
    /// Bearer token for HTTP POST /mcp (empty when not running).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub auth_token: String,
    /// Operator-facing note (e.g. stop ownership when MCP is desktop-embedded).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

struct EmbeddedState {
    stop: Arc<AtomicBool>,
    config: McpServerConfig,
    mode: String,
    owner_id: String,
    listener: Option<JoinHandle<()>>,
}

static EMBEDDED: OnceLock<Mutex<Option<EmbeddedState>>> = OnceLock::new();

fn embedded_slot() -> &'static Mutex<Option<EmbeddedState>> {
    EMBEDDED.get_or_init(|| Mutex::new(None))
}

fn pid_path() -> PathBuf {
    app_data_dir().join("mcp-server.pid")
}

fn status_path() -> PathBuf {
    app_data_dir().join("mcp-server.status.json")
}

/// Hard-kill of a peer PID is only safe for standalone headless processes.
/// Desktop embeds MCP in the Tauri process; killing that PID kills the UI.
pub(crate) fn hard_kill_allowed(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("headless")
}

fn ownership_matches_status(
    owner: &crate::runtime_ownership::RuntimeOwnerInfo,
    status: &ServerStatus,
) -> bool {
    owner.mode.eq_ignore_ascii_case("headless")
        && owner.pid == status.pid
        && owner.owner_id == status.owner_id
}

/// Start the embedded HTTP MCP server (idempotent if already running on same bind).
pub fn start_embedded(host: McpHost) -> Result<ServerStatus, String> {
    start_embedded_with_config(host, McpServerConfig::default(), "embedded")
}

pub fn start_embedded_with_config(
    host: McpHost,
    mut config: McpServerConfig,
    mode: &str,
) -> Result<ServerStatus, String> {
    let owner_id = host.owner_id().to_string();
    // Prefer env token when present so operators can pin it across restarts.
    if let Ok(token) = std::env::var("CODEX_CORP_MCP_TOKEN") {
        let token = token.trim();
        if !token.is_empty() {
            config.auth_token = token.to_string();
        }
    }

    let mut guard = embedded_slot()
        .lock()
        .map_err(|_| "mcp lifecycle lock poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        if !existing.stop.load(Ordering::SeqCst) {
            if existing.config.same_bind(&config) {
                return Ok(status_from_config(
                    &existing.config,
                    &existing.mode,
                    &existing.owner_id,
                    true,
                ));
            }
            return Err(format!(
                "MCP server already running on {} (requested {})",
                existing.config.endpoint(),
                config.endpoint()
            ));
        }
    }

    // Single runtime owner: refuse when any live peer is recorded, regardless of bind.
    // Same-bind gets a precise message; different-bind still fails to avoid overwriting
    // PID/status and interrupting the peer's in-flight runs via recovery on start.
    if let Some(peer) = peer_running_status(status_path()) {
        let mode_label = if peer.mode.is_empty() {
            "unknown"
        } else {
            peer.mode.as_str()
        };
        if peer.host == config.host && peer.port == config.port {
            return Err(format!(
                "MCP already running on {} (pid {}, mode={})",
                peer.endpoint, peer.pid, mode_label
            ));
        }
        return Err(format!(
            "MCP already running (pid {}, mode={}, endpoint={}); only one runtime owner is supported (stop it before starting another bind)",
            peer.pid, mode_label, peer.endpoint
        ));
    }
    // Also refuse when only a live pid file exists (status missing/corrupt).
    if let Some(pid) = live_peer_pid_from_pid_file() {
        return Err(format!(
            "MCP already running (pid {pid}); only one runtime owner is supported (stop it before starting)"
        ));
    }
    // Stale PID/status from a dead process — clear before rebinding.
    clear_stale_runtime_files();

    // Ensure data dir exists before bind so bookkeeping cannot fail after listen.
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    restrict_data_dir_permissions(&dir);

    let stop = Arc::new(AtomicBool::new(false));
    let listener = spawn_http_with_retry(host, config.clone(), stop.clone())?;

    let state = EmbeddedState {
        stop,
        config: config.clone(),
        mode: mode.to_string(),
        owner_id,
        listener: Some(listener),
    };
    let status = status_from_config(&state.config, &state.mode, &state.owner_id, true);
    if let Err(error) = write_runtime_files(&status) {
        // Roll back: stop accept loop and join so the port is released.
        state.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = state.listener {
            let _ = handle.join();
        }
        let _ = fs::remove_file(pid_path());
        let _ = fs::remove_file(status_path());
        return Err(error);
    }
    *guard = Some(state);
    Ok(status)
}

fn spawn_http_with_retry(
    host: McpHost,
    config: McpServerConfig,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    let mut last_error = String::new();
    for attempt in 0..8 {
        match transport::spawn_http(host.clone(), config.clone(), stop.clone()) {
            Ok(handle) => return Ok(handle),
            Err(error) => {
                last_error = error;
                // Brief backoff for stop→start port release races.
                std::thread::sleep(Duration::from_millis(40 + attempt * 30));
            }
        }
    }
    Err(last_error)
}

/// Stop the embedded MCP listener and clear PID/status files written by this process.
///
/// Does **not** delete the cooperative stop file unless this process actually
/// owned an embedded listener. The external CLI must leave `mcp-server.stop` in
/// place so a peer headless server can observe it; the server poller removes the
/// file after tripping.
pub fn stop_embedded() {
    let maybe_state = embedded_slot()
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let stopped_local = if let Some(state) = maybe_state {
        state.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = state.listener {
            // Accept loop polls every 50ms; join so restart can rebind promptly.
            let _ = handle.join();
        }
        true
    } else {
        false
    };
    // Only the process that owned the listener may clear PID/status/stop files.
    // External CLI `stop` must not wipe a peer desktop's bookkeeping files.
    if stopped_local {
        let _ = fs::remove_file(pid_path());
        let _ = fs::remove_file(status_path());
        let _ = fs::remove_file(mcp_stop_file_path());
    }
}

pub fn status_embedded() -> ServerStatus {
    if let Ok(guard) = embedded_slot().lock() {
        if let Some(state) = guard.as_ref() {
            if !state.stop.load(Ordering::SeqCst) {
                return status_from_config(&state.config, &state.mode, &state.owner_id, true);
            }
        }
    }
    // Fall back to on-disk status (another process may own the server).
    if let Ok(text) = fs::read_to_string(status_path()) {
        if let Ok(status) = serde_json::from_str::<ServerStatus>(&text) {
            if status.running && status.pid != 0 && process_alive(status.pid) {
                return status;
            }
        }
    }
    let config = McpServerConfig::default();
    status_from_config(&config, "stopped", "", false)
}

fn status_from_config(
    config: &McpServerConfig,
    mode: &str,
    owner_id: &str,
    running: bool,
) -> ServerStatus {
    ServerStatus {
        running,
        endpoint: config.endpoint(),
        transport: if config.stdio {
            "stdio+http".into()
        } else {
            "streamable-http".into()
        },
        host: config.host.clone(),
        port: config.port,
        pid: if running { std::process::id() } else { 0 },
        mode: mode.into(),
        owner_id: if running {
            owner_id.into()
        } else {
            String::new()
        },
        auth_token: if running {
            config.auth_token.clone()
        } else {
            String::new()
        },
        message: String::new(),
    }
}

fn write_runtime_files(status: &ServerStatus) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    restrict_data_dir_permissions(&dir);
    fs::write(pid_path(), status.pid.to_string()).map_err(|error| error.to_string())?;
    let text = serde_json::to_string_pretty(status).map_err(|error| error.to_string())?;
    fs::write(status_path(), text).map_err(|error| error.to_string())?;
    restrict_file_permissions(&pid_path());
    restrict_file_permissions(&status_path());
    Ok(())
}

pub(crate) fn restrict_data_dir_permissions(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(dir) {
            let mut perms = meta.permissions();
            perms.set_mode(0o700);
            let _ = fs::set_permissions(dir, perms);
        }
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        restrict_windows_acl(dir, true);
    }
}

pub(crate) fn restrict_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        restrict_windows_acl(path, false);
    }
}

#[cfg(windows)]
fn current_windows_sid() -> Option<String> {
    let output = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let start = text.find("S-1-")?;
    let sid: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    (!sid.is_empty()).then_some(sid)
}

#[cfg(windows)]
fn restrict_windows_acl(path: &Path, directory: bool) {
    let Some(sid) = current_windows_sid() else {
        eprintln!(
            "[codex-corp-mcp] warning: could not determine current Windows SID for ACL hardening"
        );
        return;
    };
    let grant = if directory {
        format!("*{sid}:(OI)(CI)F")
    } else {
        format!("*{sid}:F")
    };
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &grant])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if !status.is_ok_and(|s| s.success()) {
        eprintln!(
            "[codex-corp-mcp] warning: failed to restrict ACL on {}",
            path.display()
        );
    }
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use std::process::Command;
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        match output {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                text.contains(&pid.to_string())
            }
            Err(_) => false,
        }
    }
    #[cfg(unix)]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
            || std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

/// Read on-disk status if the recorded peer PID is still alive (and not this process).
pub(crate) fn peer_running_status(path: impl AsRef<Path>) -> Option<ServerStatus> {
    let text = fs::read_to_string(path.as_ref()).ok()?;
    let status = serde_json::from_str::<ServerStatus>(&text).ok()?;
    if !status.running || status.pid == 0 || status.pid == std::process::id() {
        return None;
    }
    if process_alive(status.pid) {
        Some(status)
    } else {
        None
    }
}

fn live_peer_pid_from_pid_file() -> Option<u32> {
    let text = fs::read_to_string(pid_path()).ok()?;
    let pid = text.trim().parse::<u32>().ok()?;
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    if process_alive(pid) {
        Some(pid)
    } else {
        None
    }
}

fn clear_stale_runtime_files() {
    if let Ok(text) = fs::read_to_string(status_path()) {
        if let Ok(status) = serde_json::from_str::<ServerStatus>(&text) {
            if status.pid != 0 && status.pid != std::process::id() && process_alive(status.pid) {
                return;
            }
        }
    }
    if live_peer_pid_from_pid_file().is_some() {
        return;
    }
    let _ = fs::remove_file(pid_path());
    let _ = fs::remove_file(status_path());
}

/// Hard-kill a peer PID. Unix: SIGTERM → wait → SIGKILL. Windows: taskkill /F.
/// Returns true when the process is no longer alive after the attempt.
fn hard_kill_pid(pid: u32) -> bool {
    if pid == 0 || !process_alive(pid) {
        return true;
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
        // Brief settle so tasklist reflects exit.
        for _ in 0..20 {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        !process_alive(pid)
    }
    #[cfg(unix)]
    {
        // SIGTERM first (graceful for peers that ignored the stop file).
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        for _ in 0..20 {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Escalate to SIGKILL if still alive.
        if process_alive(pid) {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
            for _ in 0..20 {
                if !process_alive(pid) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        !process_alive(pid)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

/// Poll until no peer PID is alive or the deadline elapses.
fn wait_for_peers_exit(pids: &[u32], total: Duration) -> bool {
    let deadline = std::time::Instant::now() + total;
    loop {
        let any_alive = pids.iter().copied().any(process_alive);
        if !any_alive {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// External stop: cooperative stop file + optional hard-kill for headless peers only.
pub fn stop_external() -> Result<ServerStatus, String> {
    // Snapshot peer ownership before clearing local embedded state / files.
    let disk_status = fs::read_to_string(status_path())
        .ok()
        .and_then(|text| serde_json::from_str::<ServerStatus>(&text).ok());
    let peer_pid = fs::read_to_string(pid_path())
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .filter(|pid| *pid != 0 && *pid != std::process::id());
    let status_pid = disk_status
        .as_ref()
        .map(|status| status.pid)
        .filter(|pid| *pid != 0 && *pid != std::process::id());
    let mode = disk_status
        .as_ref()
        .map(|status| status.mode.clone())
        .unwrap_or_default();
    let live_owner = crate::runtime_ownership::live_owner();
    let ownership_matches = live_owner.as_ref().is_some_and(|owner| {
        disk_status
            .as_ref()
            .is_some_and(|status| ownership_matches_status(owner, status))
    });
    let allow_hard_kill = hard_kill_allowed(&mode) && ownership_matches;

    // Cooperative stop signal for peer headless poll loops. Must remain on disk
    // until the server observes it — do not delete from this CLI process.
    let _ = fs::write(mcp_stop_file_path(), b"1");
    // Local embedded listener only (no-op in the stop CLI process).
    stop_embedded();

    if !allow_hard_kill {
        if live_owner.is_none() {
            let _ = fs::remove_file(pid_path());
            let _ = fs::remove_file(status_path());
            let _ = fs::remove_file(mcp_stop_file_path());
            let mut status = status_embedded();
            status.message = "No live Codex Corp runtime owner; stale MCP bookkeeping was cleared without signaling the recorded PID.".into();
            return Ok(status);
        }
        // Not headless mode: never taskkill the process (desktop PID = whole UI).
        // Cooperative stop file was written above; leave peer PID/status intact.
        // Message is returned on ServerStatus.message for the CLI to print once.
        let pid = status_pid.or(peer_pid).unwrap_or(0);
        let mut status = status_embedded();
        if pid != 0 && process_alive(pid) {
            let msg = if mode.eq_ignore_ascii_case("embedded") || mode.is_empty() {
                format!(
                    "MCP is embedded in the desktop app (pid {pid}). Close/quit the desktop app to stop MCP; headless stop will not kill the UI process."
                )
            } else {
                format!(
                    "MCP process still running (pid {pid}, mode={mode}); hard-kill is only used for mode=headless. Cooperative stop file written."
                )
            };
            if let Some(mut disk) = disk_status.filter(|s| s.pid == pid) {
                disk.message = msg;
                status = disk;
            } else {
                status.message = msg;
            }
        } else {
            // Stale files / already stopped — safe to clear leftovers.
            let _ = fs::remove_file(pid_path());
            let _ = fs::remove_file(status_path());
            let _ = fs::remove_file(mcp_stop_file_path());
            status = status_embedded();
            if status.message.is_empty() {
                status.message = "No live headless MCP process to stop (desktop embedded MCP is not hard-killed).".into();
            }
        }
        return Ok(status);
    }

    // Headless peer: allow cooperative exit via stop file (poller ~300ms + main
    // loop ~250ms) before escalating. 3s covers several poll cycles.
    let peer_pids: Vec<u32> = [peer_pid, status_pid]
        .into_iter()
        .flatten()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let peers_exited = wait_for_peers_exit(&peer_pids, Duration::from_secs(3));
    if !peers_exited {
        for pid in &peer_pids {
            let _ = hard_kill_pid(*pid);
        }
    }
    // Final liveness check — only clear bookkeeping when the peer is actually gone
    // so status cannot report "not running" while an orphan still holds the port.
    let all_gone = peer_pids.iter().copied().all(|pid| !process_alive(pid));

    if all_gone {
        let _ = fs::remove_file(pid_path());
        let _ = fs::remove_file(status_path());
        let _ = fs::remove_file(mcp_stop_file_path());
        Ok(status_embedded())
    } else {
        let mut status = status_embedded();
        let alive: Vec<u32> = peer_pids
            .iter()
            .copied()
            .filter(|pid| process_alive(*pid))
            .collect();
        status.message = format!(
            "Headless MCP peer still alive after hard-kill (pids {alive:?}); left PID/status files in place"
        );
        if let Some(disk) = disk_status {
            if alive.contains(&disk.pid) {
                let mut disk = disk;
                disk.message = status.message.clone();
                status = disk;
            }
        }
        Ok(status)
    }
}

/// Absolute path to the on-disk status file (for operator banners).
pub fn status_file_path() -> PathBuf {
    status_path()
}

/// First 8 characters of the token for logs/banners (not a secret substitute).
pub fn token_fingerprint(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Prefer hex body after "cc-" prefix when present.
    let body = trimmed.strip_prefix("cc-").unwrap_or(trimmed);
    body.chars().take(8).collect()
}

/// Format bind endpoint for diagnostics (IPv6-safe host:port).
#[allow(dead_code)]
pub(crate) fn bind_socket_addr(host: &str, port: u16) -> String {
    socket_addr(host, port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_kill_allowed_only_for_headless() {
        assert!(hard_kill_allowed("headless"));
        assert!(hard_kill_allowed("Headless"));
        assert!(!hard_kill_allowed("embedded"));
        assert!(!hard_kill_allowed("desktop"));
        assert!(!hard_kill_allowed(""));
        assert!(!hard_kill_allowed("stopped"));
    }

    #[test]
    fn default_status_is_not_running_when_idle() {
        let status = status_embedded();
        assert!(!status.endpoint.is_empty());
        assert!(status.port > 0);
        if !status.running {
            assert_eq!(status.pid, 0);
            assert!(status.auth_token.is_empty());
        }
    }

    #[test]
    fn config_endpoint_format() {
        let config = McpServerConfig {
            host: "127.0.0.1".into(),
            port: 8742,
            stdio: false,
            auth_token: "test".into(),
        };
        assert_eq!(config.endpoint(), "http://127.0.0.1:8742/mcp");
    }

    #[test]
    fn same_bind_ignores_token() {
        let a = McpServerConfig {
            host: "127.0.0.1".into(),
            port: 8742,
            stdio: false,
            auth_token: "a".into(),
        };
        let mut b = a.clone();
        b.auth_token = "b".into();
        assert!(a.same_bind(&b));
        b.port = 9;
        assert!(!a.same_bind(&b));
    }

    #[test]
    fn token_fingerprint_truncates() {
        assert_eq!(token_fingerprint("cc-abcdef0123456789"), "abcdef01");
        assert_eq!(token_fingerprint("short"), "short");
        assert!(token_fingerprint("").is_empty());
    }

    #[test]
    fn peer_running_status_none_for_missing_file() {
        let path = std::env::temp_dir().join(format!(
            "codex-corp-mcp-peer-status-missing-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        assert!(peer_running_status(&path).is_none());
    }

    #[test]
    fn peer_running_status_none_for_dead_pid() {
        let path = std::env::temp_dir().join(format!(
            "codex-corp-mcp-peer-status-dead-{}.json",
            std::process::id()
        ));
        let status = ServerStatus {
            running: true,
            endpoint: "http://127.0.0.1:8742/mcp".into(),
            transport: "streamable-http".into(),
            host: "127.0.0.1".into(),
            port: 8742,
            // Extremely unlikely to be a live PID on test hosts.
            pid: u32::MAX - 17,
            mode: "headless".into(),
            owner_id: "owner-test".into(),
            auth_token: String::new(),
            message: String::new(),
        };
        fs::write(&path, serde_json::to_string(&status).unwrap()).unwrap();
        assert!(peer_running_status(&path).is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn peer_running_status_some_for_self_skipped() {
        // Status with our own pid must not count as a peer (start would never proceed).
        let path = std::env::temp_dir().join(format!(
            "codex-corp-mcp-peer-status-self-{}.json",
            std::process::id()
        ));
        let status = ServerStatus {
            running: true,
            endpoint: "http://127.0.0.1:8742/mcp".into(),
            transport: "streamable-http".into(),
            host: "127.0.0.1".into(),
            port: 8742,
            pid: std::process::id(),
            mode: "headless".into(),
            owner_id: "owner-test".into(),
            auth_token: String::new(),
            message: String::new(),
        };
        fs::write(&path, serde_json::to_string(&status).unwrap()).unwrap();
        assert!(peer_running_status(&path).is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn reused_pid_without_the_matching_owner_nonce_cannot_be_hard_killed() {
        let status = ServerStatus {
            running: true,
            endpoint: "http://127.0.0.1:8742/mcp".into(),
            transport: "streamable-http".into(),
            host: "127.0.0.1".into(),
            port: 8742,
            pid: 4242,
            mode: "headless".into(),
            owner_id: "old-owner".into(),
            auth_token: String::new(),
            message: String::new(),
        };
        let reused = crate::runtime_ownership::RuntimeOwnerInfo {
            owner_id: "new-owner".into(),
            pid: 4242,
            mode: "headless".into(),
        };
        assert!(!ownership_matches_status(&reused, &status));

        let matching = crate::runtime_ownership::RuntimeOwnerInfo {
            owner_id: "old-owner".into(),
            ..reused
        };
        assert!(ownership_matches_status(&matching, &status));
    }

    #[cfg(windows)]
    #[test]
    fn windows_permission_helpers_leave_only_the_current_sid_explicitly_granted() {
        let dir = std::env::temp_dir().join(format!(
            "codex-acl-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("secret.json");
        fs::write(&file, b"secret").unwrap();
        restrict_data_dir_permissions(&dir);
        restrict_file_permissions(&file);
        assert_eq!(fs::read(&file).unwrap(), b"secret");

        let _sid = current_windows_sid().expect("current SID");
        let output = std::process::Command::new("icacls")
            .arg(&file)
            .output()
            .expect("icacls query");
        let listing = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{listing}");
        assert!(
            listing.contains("(F)"),
            "ACL must grant full access: {listing}"
        );
        assert!(
            !listing.to_ascii_lowercase().contains("everyone"),
            "{listing}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
