# Codex Corp durable incident notes

## 2025-08-26 — Builder node blocked by npm install / build approval

### Symptom
The Software company built-in template failed in the production build with the message that `npm test` passes but `npm run build` is blocked because dependencies are not installed, `npm install` requires approval, and no revision edge is configured.

### Root cause
1. The Software company builder was wired to the `frontend-engineer` pack with `approvalPolicy: "on-request"` and `sandboxProfile: "workspace-write"` in the built-in template.
2. The pack and template did not include `Build`, `Test`, or `Package install` as explicit tools.
3. The Rust runtime collapsed any non-`"untrusted"`/`"never"` approval policy to `"on-request"` and only accepted `read-only` or `workspace-write` sandbox modes, so even if the UI somehow chose a broader mode, `danger-full-access` was dropped back to `workspace-write` before reaching the Codex app-server.
4. The `requestApproval` handler fail-closed for `approvalPolicy: "never"`, so a builder that did manage to send `danger-full-access` but whose approval policy got mis-cast would still see approval requests declined.
5. The v2 persistence migration condition matched `approvalPolicy: "never"`, but the actual saved v2 Software Company template used `approvalPolicy: "on-request"`, so real old snapshots would not be upgraded.

### Fix
- Added a new `builder` pack (`src/node-packs/packs.ts`) with role `"Builder"`, tools `["Workspace read", "Workspace write", "Shell", "Apply patch", "Network", "Build", "Test", "Package install"]`, `sandboxProfile: "danger-full-access"`, `approvalPolicy: "never"`, `workspacePolicy: "workflow"`.
- Promoted `frontend-engineer`, `backend-engineer`, and `senior-software-engineer` packs to the same `danger-full-access`/`never` defaults and updated their developer instructions to require installing dependencies, running tests, and running the production build without asking for human approval.
- Updated `packNode` and all built-in templates to let pack defaults own `sandboxProfile`/`approvalPolicy` while templates only enforce `workspacePolicy: "workflow"`.
- Extended the `sandboxProfile` type union and the UI inspector to support `"danger-full-access"`.
- Added `Build`, `Test`, `Package install` to the standard tool labels.
- Ensured `ensureSpecialistQuality` and `main.tsx` propagate pack `sandboxProfile`/`approvalPolicy`/`workspacePolicy` into newly created nodes.
- In Rust (`src-tauri/src/lib.rs`):
  - Added `codex_sandbox_mode` to forward `danger-full-access` to the Codex app-server.
  - Allowed the request-approval handler to auto-accept for `danger-full-access` + `approvalPolicy: "never"`.
  - Preserved the documented `AutoDecline` default for the `CODEX_CORP_HEADLESS_APPROVAL` headless policy; builder auto-accept is handled by the dedicated `danger-full-access` branch above.
- Updated the v2 persistence migration to upgrade an affected Software Company builder to the new `builder` pack profile and keep other specialists on-request.
- Added/updated Rust and TypeScript tests for the builder policy, sandbox mapping, and template pack wiring.

### Verification
- `npm run build` — passed
- `npm test` — passed (349 tests)
- `cargo test --manifest-path src-tauri/Cargo.toml` — passed (218 passed, 1 ignored)
- `cargo clippy --manifest-path src-tauri/Cargo.toml` — passed
- `npm run desktop:build` — produced `release/Codex-Corp.exe` after stopping the stale instance that locked the destination; launched it and the process was responding.

### Notes for operators
- If a builder node has a named `permissionProfile` selected, that profile takes precedence over the pack `sandboxProfile` and may require connector-side approval. Keep `permissionProfile` empty to rely on the built-in `danger-full-access` builder sandbox.
- The v2 and v4 Software Company snapshots that use the old `frontend-engineer` builder pack are now detected by graph shape and upgraded to the autonomous `builder` pack automatically when loaded. Snapshots that already have the new `builder` pack (or any non-matching custom values) are left untouched.

## 2025-08-27 — Review follow-up: workspace policy ownership and process limiter

### Corrections
- Made the pack catalog the single source of truth for `workspacePolicy`:
  - `pack()` in `src/node-packs/packs.ts` now defaults built-in packs to `workspacePolicy: "workflow"`; the blank `empty-agent` pack explicitly defaults to `"isolated"`.
  - Removed redundant `workflowPolicy` overrides from built-in templates in `src/node-packs/template-factory.ts`.
  - `src/main.tsx`, `src/editor-inspector.tsx`, and `src/persistence.ts` now fall back to `"isolated"` when a pack does not declare a policy, matching the Rust runtime default.
  - `src/persistence.ts` `parseWorkflowSnapshot` now migrates an undefined `workspacePolicy` to the pack's declared default rather than hardcoding `"isolated"`, while preserving explicit `"workflow"`/`"isolated"` values and remapping invalid values to the pack default or `"isolated"`.
- Fixed `ProcessLimiter::acquire` in `src-tauri/src/workflow_runtime.rs` so it checks the per-run `stop` flag while queued and releases the ticket so the next waiter does not hang.
- Replaced a direct `database.0.lock()` in `src-tauri/src/golden.rs` with `database_guard_for` for consistency with the `parking_lot` migration.
