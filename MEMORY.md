# Project Memory

This file records durable, repository-specific operational lessons. Keep entries factual, scoped, and actionable; `AGENTS.md` contains the corresponding mandatory rules.

## 2026-07-18 — Local-only main holds headless MCP work (do not push yet)

### State

Local `main` contains the headless MCP server + completion verifier + related harness/UI work (merged from `feature/headless-mcp-server`, which was deleted locally and never pushed). Commits are intentionally **ahead of `origin/main`**.

### Guardrails

- Do **not** `git push` / IDE Sync / publish `main` until a deliberate publish decision.
- Local config may set `branch.main.pushRemote=no_push` so a bare `git push` on `main` fails closed. To publish later: push with an explicit refspec, or reset `pushRemote` first.
- Do **not** recreate or push a remote `feature/headless-mcp-server` “just to back up.”
- Publishing `main` will ship the entire fat feature commit(s) together; rewrite history only if a subset must stay private, and only before first push.

### Before production desktop ship from this main

Still run the full Agents.md desktop verification sequence (`npm run build`, `npm test`, `cargo test`, `npm run desktop:build` with `custom-protocol`, launch the exact `release/Codex-Corp.exe`, confirm no `ERR_CONNECTION_REFUSED` / blank WebView). The local merge tests alone are not a release handoff.

## 2026-07-17 — Tauri release opened `127.0.0.1` instead of bundled assets

### Symptom

`release/Codex-Corp.exe` launched a normal-looking desktop window, but its WebView displayed `127.0.0.1 refused to connect` / `ERR_CONNECTION_REFUSED`.

### What went wrong

The release helper invoked `cargo build --release` without Tauri's `custom-protocol` feature. Compilation succeeded and the process remained responsive, but those signals did not prove that the production frontend was embedded. The binary selected the development URL and depended on a Vite server that was not running.

An older `release/Codex-Corp.exe` was also still running. Windows locked the destination executable, so the otherwise successful rebuild failed at the final copy with `EPERM`. Initially treating build success and process liveness as sufficient delayed discovery of the real rendering failure.

### Durable fix

- `src-tauri/Cargo.toml` defines `custom-protocol = ["tauri/custom-protocol"]`.
- `scripts/desktop-build.mjs` runs the release build with `--features custom-protocol`.
- Development remains separate: `npm run desktop:dev` intentionally runs Vite on port 5173 and does not enable the release-only protocol feature.

### Required verification sequence

1. Preserve and inspect the dirty worktree before doing anything destructive.
2. Install dependencies with `npm install` when needed.
3. Run `npm run build` and `npm test`.
4. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
5. Identify any running process whose executable path exactly equals `release/Codex-Corp.exe`; stop only that process before replacement.
6. Run `npm run desktop:build` and require its final executable-copy success message.
7. Launch the exact `release/Codex-Corp.exe` just produced.
8. Verify both process health and rendered UI content. The window must show Codex Corp, not a loopback connection error, blank WebView, or stale page.

### Evidence standard

Do not claim the app is ready for manual verification based only on exit code, compiler output, file timestamp/hash, window title, or `Responding = True`. The final evidence must include the content rendered inside the new desktop window. If visual inspection is interrupted or unavailable, say that verification is incomplete.

## 2026-07-19 — Codex Realtime Voice (Phase 1)

### Architecture

Voice mode uses `thread/realtime/*` JSON-RPC methods over the existing stdin/stdout transport. The frontend captures 24 kHz/16-bit/mono audio via `AudioWorklet`, batches to 100 ms frames (~6.4 KB base64), and sends via `append_codex_realtime_audio`. Output audio arrives as `codex-realtime-output-audio` events with `ThreadRealtimeAudioChunk` payloads (already base64-encoded). A dedicated `AudioContext` + `AudioBufferSourceNode` queues chunks for gapless playback.

### Session lifecycle

`RealtimeBroker` (mirrors `ToolBroker`/`ApprovalBroker`) holds `Arc<Mutex<RealtimeSession>>` entries keyed by `sessionKey`. Each session owns `stdin`, `child`, and `next_id` (AtomicU64). A dispatcher thread reads stdout and emits 8 Tauri events. `Drop` kills the child process.

### Manual verification steps

1. Launch exe, open mediator chat.
2. Click phone button (not mic — mic button was removed).
3. Grant microphone permission when prompted.
4. Speak — confirm transcript appears in VoicePanel.
5. Confirm spoken replies are audible (output audio).
6. Click "End conversation" — confirm session closes cleanly.
7. Check no `127.0.0.1` / `ERR_CONNECTION_REFUSED` in WebView.

### IPC throughput

- 100 ms frames → ~6.4 KB base64 per batch → ~10 `invoke` calls/sec.
- `send_json_timed` uses 10s timeout to prevent deadlocks.
- Dispatcher thread reads lines in a loop with no timeout (session lifetime).

### Upgrade path

- Phase 4: WebRTC transport (`transport:{type:webrtc,sdp}`).
- Phase 4: `tauri::ipc::Channel` for output audio (bypasses global event-bus fanout).
- Phase 4: Persistent voice transcript as structured chat messages.
