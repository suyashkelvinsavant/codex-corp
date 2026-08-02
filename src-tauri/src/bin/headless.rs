//! Headless Codex Corp entrypoint — no GUI / WebView.
//!
//! Runs core services (SQLite, workflow runtime handles, Live Codex probes) and
//! the embedded MCP server for VM / CI / remote operator use.

use std::env;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use codex_corp_lib::mcp_server::{
    discover_codex_json, lifecycle, status_file_path, token_fingerprint, transport, McpHost,
    McpServerConfig, ServerStatus,
};
use codex_corp_lib::mcp_stop_file_path;

fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_help();
        return ExitCode::FAILURE;
    }
    let command = args.remove(0);
    match command.as_str() {
        "help" | "-h" | "--help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "start" | "serve" => match cmd_serve(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("error: {error}");
                ExitCode::FAILURE
            }
        },
        "stop" => match cmd_stop() {
            Ok(status) => {
                if !status.message.is_empty() {
                    eprintln!("{}", status.message);
                }
                let printable = printable_status(&status, env_truthy("CODEX_CORP_MCP_PRINT_TOKEN"));
                println!(
                    "{}",
                    serde_json::to_string_pretty(&printable).unwrap_or_default()
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("error: {error}");
                ExitCode::FAILURE
            }
        },
        "status" => exit_status(lifecycle::status_embedded()),
        "golden" => match cmd_golden(&args) {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("error: {error}");
                ExitCode::FAILURE
            }
        },
        "discover-codex" => match cmd_discover() {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("error: {error}");
                ExitCode::FAILURE
            }
        },
        "mcp" => {
            if args.is_empty() {
                eprintln!("usage: codex-corp-headless mcp <start|stop|status>");
                return ExitCode::FAILURE;
            }
            let sub = args.remove(0);
            match sub.as_str() {
                "start" => match cmd_serve(&args) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("error: {error}");
                        ExitCode::FAILURE
                    }
                },
                "stop" => match cmd_stop() {
                    Ok(status) => {
                        if !status.message.is_empty() {
                            eprintln!("{}", status.message);
                        }
                        let printable =
                            printable_status(&status, env_truthy("CODEX_CORP_MCP_PRINT_TOKEN"));
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&printable).unwrap_or_default()
                        );
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        eprintln!("error: {error}");
                        ExitCode::FAILURE
                    }
                },
                "status" => exit_status(lifecycle::status_embedded()),
                other => {
                    eprintln!("unknown mcp subcommand: {other}");
                    ExitCode::FAILURE
                }
            }
        }
        other => {
            eprintln!("unknown command: {other}");
            print_help();
            ExitCode::FAILURE
        }
    }
}

fn exit_status(status: ServerStatus) -> ExitCode {
    let printable = printable_status(&status, env_truthy("CODEX_CORP_MCP_PRINT_TOKEN"));
    println!(
        "{}",
        serde_json::to_string_pretty(&printable).unwrap_or_default()
    );
    if status.running {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    }
}

fn printable_status(status: &ServerStatus, reveal_token: bool) -> ServerStatus {
    let mut printable = status.clone();
    if !reveal_token && !printable.auth_token.is_empty() {
        printable.auth_token = format!(
            "{}… (redacted; see status file)",
            token_fingerprint(&status.auth_token)
        );
    }
    printable
}

fn print_help() {
    eprintln!(
        r#"Codex Corp headless runtime

USAGE:
  codex-corp-headless <command> [options]

COMMANDS:
  start | serve [--port N] [--host ADDR] [--stdio]
      Start core services + MCP server in the foreground (Ctrl+C / SIGTERM to stop).
  stop
      Stop a running headless MCP process. Does not kill the desktop app when MCP
      is embedded (mode=embedded); quit the desktop app instead.
  status
      Print MCP server status JSON (exit 0 if running, 3 if not).
  golden <fixture.json> [fake-app-server]
      Run one evals/golden/*.json mission end-to-end against a scripted fake
      Codex app-server and print the per-fixture result JSON (used by
      evals/runner.mjs). Needs no GTK / real Codex install.
  discover-codex
      Probe local Codex CLI / app-server (JSON).
  mcp start|stop|status
      Aliases for the MCP lifecycle commands (same exit codes as top-level).
  help
      Show this help.

ENVIRONMENT:
  CODEX_CORP_MCP_HOST   bind address (default 127.0.0.1; non-loopback requires opt-in)
  CODEX_CORP_MCP_PORT   bind port (default 8742)
  CODEX_CORP_MCP_TOKEN  optional fixed bearer token for HTTP POST /mcp
  CODEX_CORP_MCP_PRINT_TOKEN=1  print full bearer token on start (default: fingerprint only)
  CODEX_CORP_HEADLESS_APPROVAL  auto_decline (default) | auto_accept | wait
  CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS  seconds a needs_human gate waits before failing
      closed when no operator responds (default 30). Batch/CI runs should keep it
      short; interactive operators can raise it.
  CODEX_CORP_DATA_DIR   override app data directory (SQLite, PID, stop file)
  CODEX_CORP_CODEX_PATH optional path to codex executable
  CODEX_CORP_MCP_ALLOW_NON_LOOPBACK=1  allow binding outside loopback

MCP TRANSPORT:
  Streamable HTTP JSON-RPC at http://HOST:PORT/mcp
  Authorization: Bearer <authToken> required on POST (token in status file)
  Optional stdio JSON-RPC with --stdio (Content-Length or line-delimited)

EXAMPLES:
  npm run headless -- start
  npm run headless -- status
  curl -s http://127.0.0.1:8742/mcp
"#
    );
}

fn parse_serve_flags(args: &[String]) -> Result<McpServerConfig, String> {
    let mut config = McpServerConfig::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                let port = args
                    .get(i)
                    .ok_or("--port requires a value")?
                    .parse::<u16>()
                    .map_err(|error| format!("invalid --port: {error}"))?;
                config.port = port;
            }
            "--host" => {
                i += 1;
                config.host = args.get(i).ok_or("--host requires a value")?.clone();
            }
            "--stdio" => {
                config.stdio = true;
            }
            "--daemon" | "-d" => {
                return Err(
                    "--daemon is not supported; run in the foreground or under a process supervisor"
                        .into(),
                );
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    Ok(config)
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes"))
        .unwrap_or(false)
}

fn print_start_banner(status: &ServerStatus) {
    let status_path = status_file_path();
    println!(
        "[codex-corp-headless] MCP listening on {} ({})",
        status.endpoint, status.transport
    );
    println!(
        "[codex-corp-headless] mode={} pid={} statusFile={}",
        status.mode,
        status.pid,
        status_path.display()
    );
    if !status.auth_token.is_empty() {
        if env_truthy("CODEX_CORP_MCP_PRINT_TOKEN") {
            println!(
                "[codex-corp-headless] POST /mcp requires Authorization: Bearer {}",
                status.auth_token
            );
        } else {
            let fp = token_fingerprint(&status.auth_token);
            println!(
                "[codex-corp-headless] authTokenFingerprint={fp} (full token in status file; set CODEX_CORP_MCP_PRINT_TOKEN=1 to print)"
            );
        }
    }
    // Status JSON redacts the token by default. Machine consumers that need the
    // secret should read the protected status file, or explicitly opt in.
    let printable = printable_status(status, env_truthy("CODEX_CORP_MCP_PRINT_TOKEN"));
    if let Ok(text) = serde_json::to_string_pretty(&printable) {
        println!("{text}");
    }
}

fn cmd_serve(args: &[String]) -> Result<(), String> {
    let config = parse_serve_flags(args)?;
    let host = McpHost::headless()?;
    let status = lifecycle::start_embedded_with_config(host.clone(), config.clone(), "headless")?;
    print_start_banner(&status);

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        install_stop_signals(stop);
    }

    // Ensure HTTP embedded listener is torn down on signal even when the main
    // path is blocked in stdio (or any future long wait). Idempotent with the
    // post-loop stop_embedded call.
    {
        let stop_watch = stop.clone();
        thread::spawn(move || {
            while !stop_watch.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
            }
            lifecycle::stop_embedded();
        });
    }

    if config.stdio {
        let result = transport::serve_stdio(host, stop.clone());
        stop.store(true, Ordering::SeqCst);
        lifecycle::stop_embedded();
        println!("[codex-corp-headless] stopped");
        return result;
    }

    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(250));
    }
    lifecycle::stop_embedded();
    println!("[codex-corp-headless] stopped");
    Ok(())
}

fn cmd_stop() -> Result<ServerStatus, String> {
    lifecycle::stop_external()
}

/// Run one golden mission fixture against a scripted fake app-server.
fn cmd_golden(args: &[String]) -> Result<String, String> {
    let fixture_path = args
        .first()
        .ok_or("usage: codex-corp-headless golden <fixture.json> [fake-app-server]")?;
    let fake_server = args.get(1).cloned().or_else(|| {
        std::env::var("CODEX_CORP_GOLDEN_FAKE_SERVER")
            .ok()
            .filter(|value| !value.trim().is_empty())
    });
    let fake_server = fake_server.ok_or(
        "a scripted fake app-server path is required (arg 2 or CODEX_CORP_GOLDEN_FAKE_SERVER)",
    )?;
    let result = codex_corp_lib::golden::run_golden_mission(fixture_path, &fake_server)?;
    serde_json::to_string_pretty(&result).map_err(|error| error.to_string())
}

fn cmd_discover() -> Result<String, String> {
    let value = discover_codex_json()?;
    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
}

/// Install SIGINT/Ctrl+C (all platforms) and SIGTERM (Unix). Handlers only set
/// the AtomicBool — no FS or locks (async-signal-safe).
fn install_stop_signals(stop: Arc<AtomicBool>) {
    // Cross-platform SIGINT / Ctrl+C (do not also register SIGINT via signal-hook).
    {
        let stop = stop.clone();
        if let Err(error) = ctrlc::set_handler(move || {
            stop.store(true, Ordering::SeqCst);
        }) {
            eprintln!("[codex-corp-headless] warning: failed to install Ctrl+C handler: {error}");
        }
    }

    // Unix SIGTERM only; SIGINT is owned by ctrlc above.
    #[cfg(unix)]
    {
        use signal_hook::consts::SIGTERM;
        use signal_hook::flag as signal_flag;
        if let Err(error) = signal_flag::register(SIGTERM, Arc::clone(&stop)) {
            eprintln!("[codex-corp-headless] warning: failed to install SIGTERM handler: {error}");
        }
    }

    // Cooperative stop file (same path as lifecycle::stop_external / app_data_dir).
    let stop = stop.clone();
    thread::spawn(move || {
        let path = mcp_stop_file_path();
        while !stop.load(Ordering::SeqCst) {
            if path.exists() {
                let _ = std::fs::remove_file(&path);
                stop.store(true, Ordering::SeqCst);
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_output_redacts_bearer_token_by_default() {
        let status = ServerStatus {
            running: true,
            endpoint: "http://127.0.0.1:8742/mcp".into(),
            transport: "streamable-http".into(),
            host: "127.0.0.1".into(),
            port: 8742,
            pid: 42,
            mode: "headless".into(),
            owner_id: "owner-1".into(),
            auth_token: "cc-secret-token-value".into(),
            message: String::new(),
        };
        let printable = printable_status(&status, false);
        assert!(!printable.auth_token.contains("secret-token-value"));
        assert!(printable.auth_token.contains("redacted"));
        assert_eq!(
            printable.auth_token,
            "secret-t… (redacted; see status file)"
        );
    }

    #[test]
    fn status_output_can_reveal_token_only_when_explicitly_requested() {
        let status = ServerStatus {
            running: true,
            endpoint: "http://127.0.0.1:8742/mcp".into(),
            transport: "streamable-http".into(),
            host: "127.0.0.1".into(),
            port: 8742,
            pid: 42,
            mode: "headless".into(),
            owner_id: "owner-1".into(),
            auth_token: "cc-secret-token-value".into(),
            message: String::new(),
        };
        assert_eq!(
            printable_status(&status, true).auth_token,
            status.auth_token
        );
    }
}
