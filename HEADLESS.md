# Headless Codex Corp + MCP Server

Run Codex Corp **without a GUI / WebView** on a Linux or Windows VM where the **Codex CLI** (`codex app-server`) is installed. The same embedded **MCP server** also starts automatically inside the desktop app.

## Requirements

- Codex CLI with `app-server` (same as desktop: roughly `0.140`–`0.150`, newer versions often work when probes pass)
- Optional: `CODEX_CORP_CODEX_PATH` pointing at the `codex` executable
- Rust toolchain (to build) or a prebuilt `codex-corp-headless` binary

### Binary / platform notes

- The headless binary currently **links the Tauri runtime** (not a pure minimal core crate). A future `codex_corp_core` split without WebView deps is out of scope for this version.
- On Linux VMs, validate shared-library needs by running `codex-corp-headless status` on the **target image** before automating.
- Desktop and headless execution are mutually exclusive for one data directory. A cross-process runtime lock is acquired before SQLite is opened or recovered and is held for the process lifetime. Use a separate `CODEX_CORP_DATA_DIR` only when you intentionally need an isolated second runtime.

## Quick start (from repo)

```bash
# Always rebuilds debug bin by default, then runs start
npm run headless -- start

# Status / stop (status exits 3 when not running; same for mcp status)
npm run headless -- status
npm run headless -- stop

# Probe Codex CLI only
npm run headless -- discover-codex
```

Or with Cargo:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin codex-corp-headless
./src-tauri/target/debug/codex-corp-headless start --port 8742
```

### `npm run headless` rebuild policy

| Env / flag | Behavior |
|------------|----------|
| (default) | `cargo build --bin codex-corp-headless` (debug) every invocation |
| `CODEX_CORP_HEADLESS_RELEASE=1` or leading `--release` | Build/use release binary |
| `CODEX_CORP_HEADLESS_SKIP_BUILD=1` | Re-use existing bin (CI smoke / rapid CLI iteration) |
| `CODEX_CORP_HEADLESS_BIN=/path/to/bin` | Use that path; skip build |

### Flags

| Flag | Meaning |
|------|---------|
| `--host ADDR` | Bind address (default `127.0.0.1`; non-loopback requires `CODEX_CORP_MCP_ALLOW_NON_LOOPBACK=1`). IPv6 literals such as `::1` are formatted as `[::1]:port`. |
| `--port N` | Bind port (default `8742`, or `CODEX_CORP_MCP_PORT`) |
| `--stdio` | Also serve classic MCP JSON-RPC on stdin/stdout |

## MCP transport

| Mode | Connection |
|------|------------|
| **Streamable HTTP** (default, auto-start) | `POST http://127.0.0.1:8742/mcp` with JSON-RPC body + **Bearer token** |
| **Stdio** | `codex-corp-headless start --stdio` (Content-Length frames or line-delimited JSON) |
| **Discovery GET** | `GET http://127.0.0.1:8742/mcp` → metadata (no token required) |

### Auth

HTTP **POST** `/mcp` requires a bearer token:

```http
Authorization: Bearer <authToken>
```

or header `X-Codex-Corp-Token: <authToken>`.

- Token is generated per process and written to `mcp-server.status.json` as `authToken`.
- Pin a token with `CODEX_CORP_MCP_TOKEN` (recommended if you set `CODEX_CORP_MCP_ALLOW_NON_LOOPBACK=1` — use a strong secret).
- Auto-generated tokens use OS CSPRNG (`BCryptGenRandom` / `/dev/urandom`).
- **Start banner** prints a short `authTokenFingerprint` (first 8 hex chars) by default. Full token on stdout only when `CODEX_CORP_MCP_PRINT_TOKEN=1`. Always prefer reading the status file for the secret.
- On Unix, PID/status/lock files are created with mode `0600` and the data dir best-effort `0700`. On Windows, the data directory and runtime secret files receive a current-user-only ACL.
- CORS is **not** enabled (local service; not a browser API).

Example initialize + tools/list:

```bash
# After start, copy authToken from the status file (not from default stdout)
TOKEN=$(jq -r .authToken < "$LOCALAPPDATA/CodexCorp/mcp-server.status.json")  # Windows-ish path

curl -s http://127.0.0.1:8742/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -s http://127.0.0.1:8742/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

For stdio-only clients:

```json
{
  "mcpServers": {
    "codex-corp": {
      "command": "path/to/codex-corp-headless",
      "args": ["start", "--stdio", "--port", "8742"]
    }
  }
}
```

## Tools exposed

| Tool | Purpose |
|------|---------|
| `byte_workflow_chat` | Byte company companion (Live Codex + hosted company tools) |
| `byte_architect_chat` | Byte Workflow Architect (catalog companion) |
| `workflow_list` / `workflow_get` | Catalog inspection |
| `company_status` / `company_run` / `company_stop` | Run control via shared workflow runtime (`company_run` accepts `startNodeId`, `workspacePath`) |
| `respond_run_approval` | Approve/decline human **graph** gates (approval nodes) |
| `list_pending_run_approvals` | List pending graph-gate `requestId`s (`runId::…`); also on `company_status` / `get_run` |
| `respond_codex_approval` | Accept/decline Live Codex `requestApproval` when headless policy is `wait` |
| `list_pending_codex_approvals` | List broker keys (`process_key::id`) waiting on Live Codex approvals |
| `list_runs` / `get_run` / `list_active_runs` | Run history and in-process status (`get_run` includes `pendingApprovals`) |
| `discover_codex` | Local Codex CLI / app-server probe |
| `mcp_server_status` | This server’s endpoint + mode |

## Runtime recovery (headless start)

On headless start (and desktop `initialize`):

1. In-flight runs (`queued` / `running` / `waiting_approval`) are marked **`interrupted`** and **resumable**.
2. Matching `node_attempts` rows are marked interrupted.
3. Retention cleanup + schedule_firings prune run (same as desktop).

**Cron / schedule nodes fire only under the desktop app** in this version (scheduler needs `AppHandle` / desktop `start_run`). Headless does not start the cron ticker.

## Headless approvals

### Graph approval nodes (`waiting_approval`)

There is **no desktop UI** for approval gates when running headless.

1. Start a run with `company_run` (or via chat tools).
2. When a node requests approval, the run waits (up to 30 minutes) on the run-approval broker.
3. Discover `requestId` via `list_pending_run_approvals`, `company_status.pendingRunApprovals`, or `get_run.pendingApprovals` (also logged to headless stderr when the gate arms).
4. Call MCP tool `respond_run_approval` with `runId`, `requestId`, `decision` (bool).
5. Or call `company_stop` to interrupt the run.

Prefer graphs without blocking approval nodes for unattended VM automation.

### Live Codex `requestApproval` (specialist tool steps)

When `app` is `None` (headless agent path), non-`never` approval policies use:

| `CODEX_CORP_HEADLESS_APPROVAL` | Behavior |
|--------------------------------|----------|
| `auto_accept` | Accept immediately with log/event `"Auto-accepted (headless policy)"`; opt in explicitly for unattended execution |
| `auto_decline` (**default**) | Decline immediately |
| `wait` | Register on `ApprovalBroker`; resolve via MCP `respond_codex_approval` (`requestId`, `decision`: `accept`\|`decline`). Times out to decline after 120s |

**Discovering wait-mode `requestId`s:**

1. Headless stderr logs `requestId=process_key::id` when a request is armed.
2. MCP tool `list_pending_codex_approvals` returns current broker keys (use this when you cannot read the serve process stderr).
3. Then call `respond_codex_approval` with that `requestId`.

Desktop UI path is unchanged when `app` is present (env ignored). Graph `approvalPolicy=never` remains the preferred explicit unattended setting on nodes. Select `auto_accept` explicitly only for trusted unattended workflows; `wait` is for operator-attended remote sessions.

## Stop ownership

| Server `mode` | `npm run headless -- stop` |
|---------------|----------------------------|
| **`headless`** | Cooperative stop file, short wait, then hard-kill peer PID if needed |
| **`embedded`** (desktop) | Writes stop file only; **does not** `taskkill`/`kill` the PID (that PID is the whole Tauri UI). Exit 0 with a clear message that desktop Quit stops MCP |

Second `start` while **any** live peer is recorded (any port / bind) fails immediately with pid/mode in the error — only one runtime owner is supported. Stale PID files from dead processes are cleared on start.

### Signals (headless process)

- **Windows:** Ctrl+C (and console control) → clean `stop_embedded()` (PID/status cleared).
- **Unix:** SIGINT and SIGTERM set a stop flag only (async-signal-safe); main loop then stops cleanly.
- **SIGKILL:** PID/status may remain; next `start` treats dead PIDs as stale and overwrites.

## Desktop auto-start, tray, and exit

When you launch `npm run desktop:dev`, the same MCP HTTP server **auto-starts** in-process (`mode=embedded`) and shuts down on **full app exit**. Release builds default MCP auto-start off to reduce the production attack surface; the environment override always wins.

| Control | Behavior |
|---------|----------|
| (default) | Auto-starts in debug/dev builds; stays off in release builds |
| `CODEX_CORP_MCP_AUTO=0` (also `false` / `off` / `no`) | Skip embedded MCP start |
| `CODEX_CORP_MCP_AUTO=1` (also `true` / `on` / `yes`) | Explicit force on |

Logs when enabled:

```text
[codex-corp] MCP server listening on http://127.0.0.1:8742/mcp (streamable-http)
[codex-corp] POST /mcp requires Authorization: Bearer <authToken> from mcp-server.status.json
[codex-corp] Disable desktop MCP auto-start with CODEX_CORP_MCP_AUTO=0
```

### Attack surface (loopback control plane)

- **Bind:** default `127.0.0.1` only. Non-loopback requires `CODEX_CORP_MCP_ALLOW_NON_LOOPBACK=1`.
- **Auth:** HTTP POST `/mcp` requires bearer token from `mcp-server.status.json` (`authToken`) or `CODEX_CORP_MCP_TOKEN`. Token compare is constant-time for equal-length secrets (length still leaks). Prefer a strong pinned token if binding off-loopback.
- **Token location:** same data dir as SQLite — Windows `%LOCALAPPDATA%\CodexCorp\mcp-server.status.json`; Unix profile data-local `CodexCorp/`.
- **CORS:** not enabled (not a browser API).
- Bearer token is **not** printed in desktop logs; read the status file.

**Tray vs exit:** closing the main window **hides to tray**; **MCP stays up** until the app fully exits (tray Quit / process exit). `headless stop` will **not** kill desktop MCP (see stop ownership above).

## Data paths

Same as desktop (override with `CODEX_CORP_DATA_DIR`):

- Windows: `%LOCALAPPDATA%\CodexCorp\`
- Linux/macOS: platform data-local dir under `CodexCorp/`
- SQLite: `codex-corp.sqlite` (WAL + 5s busy timeout; the runtime ownership guard prevents desktop/headless coexistence)
- Runtime ownership: `runtime-owner.lock` holds the OS lock, with its live nonce, PID, and mode recorded in the protected `runtime-owner.json`
- MCP PID/status/token: `mcp-server.pid`, `mcp-server.status.json`
- Cooperative stop file: `mcp-server.stop`

## VM checklist

1. Install Codex CLI and complete login (`codex login` / provider auth as required).
2. Verify: `codex app-server --help` and `npm run headless -- discover-codex`.
3. Start: `npm run headless -- start --host 127.0.0.1 --port 8742`.
4. Read `authToken` from the status file; point your MCP client at `http://127.0.0.1:8742/mcp` with the bearer token.
5. Stop: `npm run headless -- stop`, Ctrl+C, or SIGTERM on the serve process.

## Architecture notes

- Shared Rust modules: `mcp_server` (protocol, tools, HTTP/stdio, lifecycle) + existing DB / workflow runtime / Codex app-server integration.
- Hosted MCP chat turns use `codex_turn` (shared spawn / initialize / turn loop / tool callback / kill-on-drop). Desktop UI mediator and specialist paths still use their own loops in `lib.rs` (streaming + approval broker; see debt below).
- Host I/O criteria (`command`, `architecture_policy`, `artifact_exists`, delivery) evaluate via `verifier/*` with an explicit workspace path (no CWD fallback). Kind aliases live in `verifier/criteria`. Text/JSON criteria (`structured_json`, `concise_summary`, `no_hidden_reasoning`, `claim`) remain runtime-local for now.
- Generic `cargo_test` and `cargo_check` command criteria search from the selected workflow workspace. That workspace must expose a discoverable `Cargo.toml` at its root or an ancestor accepted by the command template.
- Headless binary: `codex-corp-headless` (no WebView UI; still links Tauri for shared lib).
- Desktop: thin wiring in `lib.rs` setup + exit; tray hide does not stop MCP.
- Headless runs use the native workflow runtime without UI event fan-out; use `respond_run_approval` for graph gates and headless approval env / `respond_codex_approval` for Live Codex tool approvals.

### Known limitations

- **Command criteria process trees:** Windows assigns each verifier command to a kill-on-close Job Object and terminates that job on stop/timeout (with `taskkill /T /F` only as a fallback when job assignment is unavailable). Unix starts a process group and signals the group.
- **Bearer compare:** constant-time for equal-length tokens; unequal lengths still short-circuit. Adequate for loopback; pin a fixed-length strong secret via `CODEX_CORP_MCP_TOKEN` if ever binding non-loopback.
- **Host I/O without workspace:** `company_run` / `start_run` fail closed when the graph has enabled `command` or `architecture_policy` criteria and `workspacePath` is unset (evaluate path also fails closed mid-node).

## Architecture debt

Intentional follow-ups (not blocking headless MCP quality bar):

| Item | Intent |
|------|--------|
| **`codex_corp_core` crate split** | Move db, workflow runtime, verifier, and MCP into a core crate without WebView/Tauri desktop deps; desktop becomes a thin adapter. Headless binary links core only. |
| **Full criterion engine move** | All evaluate + graph validate in `verifier/`; runtime only schedules. Today text/JSON/`claim` kinds are still runtime-local; host I/O kinds already call `verifier/*`. |
| **Delivery assembly extract** | Lift delivery materialize / pair-compare orchestration into `runtime/delivery.rs` or expand `verifier/delivery` to shrink `workflow_runtime.rs`. |
| **UI Codex turn migration** | Route `execute_mediator_turn` / `execute_agent_internal` through `codex_turn` only when streaming, UI tool broker, and `requestApproval` map cleanly — do not half-fork a third client. |
| **Auth beyond loopback** | If non-loopback bind becomes a product default, revisit ACL on status files (Windows) and fixed-length token policy. |
