# Codex Corp

**Agent operating system** for multi-specialist software companies on a graph — powered only by **Live Codex** (desktop + CLI). No browser stub agents, no fake model catalog.

## Requirements

- **Windows** desktop shell (Tauri): `npm run desktop:dev`
- **Codex CLI** with the required app-server protocol probes. Versions outside the tested `0.140`–`0.150` range show a warning but remain usable when the probes pass.
- Models from live **`model/list`** only (e.g. **gpt-5.6-luna** with **low** effort)

Browser Vite alone is for UI/graph editing; **company runs and company chat** require the desktop app.

## Scripts

| Command                 | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `npm run desktop:dev`   | Dev desktop app (Vite + native shell)                   |
| `npm run desktop:build` | Release executable under `release/`                     |
| `npm run headless`      | Headless runtime + MCP server (no GUI; see [HEADLESS.md](./HEADLESS.md)) |
| `npm test`              | Unit tests (Vitest)                                     |
| `npm run test:e2e`      | Playwright UI tests (graph/chat shell; no fake AI runs) |
| `npm run dev`           | Vite only (no Live Codex)                               |

## Headless + MCP

Codex Corp embeds an **MCP server** (Streamable HTTP on `http://127.0.0.1:8742/mcp` by default) that auto-starts with both the desktop app and `npm run headless -- start`. It exposes Byte Workflow chat, Workflow Architect chat, catalog, and run tools. Full VM deployment notes: [HEADLESS.md](./HEADLESS.md).

- **Disable desktop MCP auto-start:** `CODEX_CORP_MCP_AUTO=0`
- **Token:** read `authToken` from `%LOCALAPPDATA%\CodexCorp\mcp-server.status.json` (or `CODEX_CORP_DATA_DIR`); loopback-only by default.

## Architecture

```
Company chat (mediator)
  → Live Codex thread + dynamic tools + streamed tokens
  → Tools: company_run/run_from/stop/status/mission/approve/ask_operator + node_get/trace/events/progress/…

Graph specialists
  → Mission brief → research ∥ architect ∥ designer → creative
  → builder → five-vector reviewer → human approval → delivery
  → Each specialist: isolated execute_agent (gpt from model/list)
  → Rust owns scheduling, retries, revisions, approvals, checkpoints, retention, and terminal state
```

- **Chat** is not a graph node: it is the **company operator agent** (tools control/inspect the graph).
- **Mission brief** is the authorized mission store (constraints + acceptance notes compose into specialist input).
- **Completion criteria** on specialists are real (prompt inject + post-run evaluation).

## Company chat (mediator)

There is **no local/hardcoded chat bot**. Freeform messages (including “hi”) go only to:

1. Desktop shell (`npm run desktop:dev`)
2. Live Codex `execute_mediator_turn` with `dynamicTools`
3. Host-executed tools (`company_*`, `node_*`) when the model calls them
4. Streamed `item/agentMessage/delta` into the chat bubble

Browser Vite alone cannot answer company chat (fail closed). Natural language does not use regex intent routers for replies.

## Product rules

- No deterministic “demo agent” runtime.
- No canned mediator replies for freeform chat.
- Mock/demo model ids are stripped from the picker.
- Host-mediated tools are allowlisted. CLI-internal tool granularity is governed by the Codex sandbox and approval policy.

## Local data and privacy

- SQLite: `%LOCALAPPDATA%\CodexCorp\codex-corp.sqlite` on Windows (the Settings page shows the resolved path).
- Run workspaces: `%LOCALAPPDATA%\CodexCorp\workspaces\<run-id>\...`.
- Company chat: the desktop WebView's local storage, keyed per workflow and session. Image data URLs are removed after successful sending; attachment metadata remains.
- Log exports: saved through the browser download flow to the location selected by the operating system/browser.
- Detailed logs, attempt diagnostics, and checkpoints follow Settings → Data & Logs. Compact run summaries and delivery metadata remain until explicitly deleted.
- Codex Corp does not transmit logs or telemetry to a remote analytics service.

## Templates

Seed from the editor (**Seed**): Software company, Startup idea validation, Conditional launch review.

## License

Private / hackathon project unless otherwise stated.
