//! Cross-platform child-process construction for non-interactive background work.
//!
//! The desktop binary uses the Windows GUI subsystem, so console-subsystem child
//! processes must be explicitly created without a console window. Keeping that
//! policy here prevents new background launch paths from reintroducing flashes.

use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Construct a command intended for captured, piped, or otherwise non-interactive
/// background execution.
pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    hide_console_window(&mut command);
    command
}

/// Apply the platform policy to a command that needs additional construction.
pub(crate) fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_command_remains_spawnable() {
        #[cfg(windows)]
        let output = background_command("cmd.exe")
            .args(["/d", "/c", "exit", "0"])
            .output()
            .expect("background Windows command should spawn");

        #[cfg(unix)]
        let output = background_command("sh")
            .args(["-c", "exit 0"])
            .output()
            .expect("background Unix command should spawn");

        assert!(output.status.success());
    }
}
