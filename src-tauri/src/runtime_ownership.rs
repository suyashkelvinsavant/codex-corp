//! Cross-process ownership for the shared Codex Corp data directory.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Arc;

use crate::app_data_dir;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeOwnerInfo {
    pub owner_id: String,
    pub pid: u32,
    pub mode: String,
}

#[derive(Debug)]
pub(crate) struct RuntimeOwnershipGuard {
    file: File,
    info: RuntimeOwnerInfo,
    info_path: std::path::PathBuf,
}

impl RuntimeOwnershipGuard {
    pub(crate) fn acquire(mode: &str) -> Result<Arc<Self>, String> {
        Self::acquire_at(&app_data_dir(), mode)
    }

    fn acquire_at(dir: &Path, mode: &str) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::mcp_server::lifecycle::restrict_data_dir_permissions(dir);
        let path = dir.join("runtime-owner.lock");
        let info_path = dir.join("runtime-owner.json");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("open runtime ownership lock {}: {e}", path.display()))?;
        crate::mcp_server::lifecycle::restrict_file_permissions(&path);
        file.try_lock_exclusive().map_err(|_| {
            let owner = read_info_path(&info_path)
                .map(|o| format!("{} pid {}", o.mode, o.pid))
                .unwrap_or_else(|| "another Codex Corp process".into());
            format!("Codex Corp data directory is already owned by {owner}")
        })?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let info = RuntimeOwnerInfo {
            owner_id: format!("owner-{}-{nonce:x}", std::process::id()),
            pid: std::process::id(),
            mode: mode.to_string(),
        };
        let mut info_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&info_path)
            .map_err(|e| format!("open runtime owner metadata {}: {e}", info_path.display()))?;
        write_info(&mut info_file, &info)?;
        crate::mcp_server::lifecycle::restrict_file_permissions(&info_path);
        Ok(Arc::new(Self {
            file,
            info,
            info_path,
        }))
    }

    pub(crate) fn info(&self) -> &RuntimeOwnerInfo {
        &self.info
    }
}

impl Drop for RuntimeOwnershipGuard {
    fn drop(&mut self) {
        if read_info_path(&self.info_path)
            .is_some_and(|recorded| recorded.owner_id == self.info.owner_id)
        {
            let _ = fs::remove_file(&self.info_path);
        }
        let _ = self.file.unlock();
    }
}

fn write_info(file: &mut File, info: &RuntimeOwnerInfo) -> Result<(), String> {
    let bytes = serde_json::to_vec(info).map_err(|e| e.to_string())?;
    file.set_len(0).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())
}

fn read_info(file: &mut File) -> Option<RuntimeOwnerInfo> {
    let _ = file.seek(SeekFrom::Start(0));
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_info_path(path: &Path) -> Option<RuntimeOwnerInfo> {
    let mut file = OpenOptions::new().read(true).open(path).ok()?;
    read_info(&mut file)
}

/// Return metadata only while another process actually holds the OS lock.
pub(crate) fn live_owner() -> Option<RuntimeOwnerInfo> {
    live_owner_at(&app_data_dir())
}

fn live_owner_at(dir: &Path) -> Option<RuntimeOwnerInfo> {
    let path = dir.join("runtime-owner.lock");
    let info_path = dir.join("runtime-owner.json");
    let file = OpenOptions::new().read(true).write(true).open(path).ok()?;
    match file.try_lock_exclusive() {
        Ok(()) => {
            let _ = file.unlock();
            None
        }
        Err(_) => read_info_path(&info_path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_info_round_trips() {
        let info = RuntimeOwnerInfo {
            owner_id: "x".into(),
            pid: 7,
            mode: "headless".into(),
        };
        let text = serde_json::to_string(&info).unwrap();
        assert_eq!(
            serde_json::from_str::<RuntimeOwnerInfo>(&text).unwrap(),
            info
        );
    }

    #[test]
    fn a_second_runtime_cannot_acquire_the_same_data_directory() {
        const CHILD_MARKER: &str = "CODEX_CORP_OWNERSHIP_TEST_CHILD";
        const CHILD_DIR: &str = "CODEX_CORP_OWNERSHIP_TEST_DIR";
        if std::env::var_os(CHILD_MARKER).is_some() {
            let dir = std::path::PathBuf::from(std::env::var_os(CHILD_DIR).unwrap());
            let _guard = RuntimeOwnershipGuard::acquire_at(&dir, "desktop").unwrap();
            fs::write(dir.join("ready"), b"1").unwrap();
            std::thread::sleep(std::time::Duration::from_secs(10));
            return;
        }

        let dir = std::env::temp_dir().join(format!(
            "codex-runtime-owner-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime_ownership::tests::a_second_runtime_cannot_acquire_the_same_data_directory",
                "--nocapture",
            ])
            .env(CHILD_MARKER, "1")
            .env(CHILD_DIR, &dir)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !dir.join("ready").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(
            dir.join("ready").exists(),
            "lock-holder child did not become ready"
        );
        let owner = live_owner_at(&dir).expect("child must hold the OS lock");
        assert_eq!(owner.mode, "desktop");
        assert!(RuntimeOwnershipGuard::acquire_at(&dir, "headless").is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        let second = RuntimeOwnershipGuard::acquire_at(&dir, "headless").unwrap();
        drop(second);
        let _ = fs::remove_dir_all(&dir);
    }
}
