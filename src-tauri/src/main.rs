// Hide the host console that Windows attaches to GUI apps (debug + release).
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    codex_corp_lib::run();
}
