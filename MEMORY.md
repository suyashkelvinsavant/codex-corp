# Codex Corp durable incident notes

## 2026-01-15 — Harness lessons: durable, versioned, reviewable supplemental guidance (Continual Harness)

### Context
The existing `node_experience` mechanism (`src-tauri/src/workflow_runtime.rs`) records durable failure outcomes and prepends a hard-coded, ephemeral guidance note to the next specialist prompt. This is useful failure-informed prompt adaptation but is not a full Continual Harness: the guidance is recomputed each run, not reviewable, not editable, not versioned, and not rollback-able. It also cannot transfer across workflows sharing the same role/model/effort pattern.

### Change
Added a dedicated `harness_lessons` Rust module (`src-tauri/src/harness_lessons.rs`) that owns durable, versioned, reviewable supplemental guidance — the Continual Harness analogue to prime-agent's `/refine` + supplemental prompts + snapshot rollback.

- **Schema**: `harness_lessons` (keyed by role/model/effort pattern, with body, evidence JSON, status, source, current_version) and `harness_lesson_snapshots` (immutable per-version history with snapshot_reason). Created in `initialize_database`. A partial unique index `udx_harness_lessons_active_pattern` enforces at most one active lesson per pattern; creation is resilient to legacy databases that predate the invariant (the index is created separately and a failure is tolerated, with the application-layer check in `create_lesson` still preventing new duplicates).
- **CRUD**: `create_lesson` (rejects a duplicate active lesson for the same pattern), `update_lesson` (snapshots prior version, bumps current_version; leaves title unchanged — operator-facing edit path), `update_lesson_with_title` (same as `update_lesson` but also updates the title; used by refine when the failure signature shifts so the title stays consistent with the body), `delete_lesson` (operator-facing **soft-delete**: marks `superseded` so the row and history are retained for audit and later pruning), `hard_delete_lesson` (internal; used only by workflow-delete cleanup; explicitly deletes child snapshots before the parent because SQLite foreign keys are off by default in this codebase and the declared `ON DELETE CASCADE` does not fire), `get_lesson`, `list_lessons`, `active_lessons_for_pattern`.
- **Rollback**: `rollback_lesson(id, to_version)` snapshots the current state first (so rollback is itself reversible), restores the target snapshot's body/evidence, and records a new snapshot at the next version. Linear, auditable history.
- **Refine**: `refine_harness_lessons(workflow_id?)` runs a deliberate, deterministic, evidence-backed refinement pass over `node_experience`. For each pattern with a recurring failure class (≥2 recent failures, no recent success), it creates or updates a lesson with evidence JSON (failureClass, counts, sampled workflows). Existing lessons are updated (via `update_lesson_with_title`, so the title follows the new signature) only when the dominant failure class or stop reason shifts, so stable lessons are not churned. Determinism is guaranteed by `BTreeMap` grouping (sorted pattern order) and explicit lexicographic-smallest-key tie-breaking when failure classes or stop reasons tie on count — a `HashMap` would use a random `RandomState` seed and produce non-reproducible output.
- **Run-time application**: `specialist_with_retries` in `workflow_runtime.rs` loads active lessons for the node's pattern via `harness_lessons::lesson_guidance` and prepends them to the specialist's developer instructions (after the ephemeral experience guidance). Emits `node.harness.lessons_applied` / `node.harness.lessons_load_failed` events.
- **Immutable base prompt protection**: lessons are supplemental to developer instructions only. The `baseInstructions` field is never touched by lessons.
- **Retention**: `prune_lessons` is wired into `app_settings::cleanup` alongside `prune_node_experience`. Only inactive (`superseded`/`rolled_back`) lessons older than `retention_days` are pruned; active lessons are retained regardless of age. The operator-facing soft-delete sets `superseded`, so prune has something to reap. Child snapshots for the to-be-pruned lessons are deleted explicitly first (same age/status predicate via a subselect) because SQLite foreign keys are off by default and the declared `ON DELETE CASCADE` does not fire — without this, snapshots would be orphaned with no cleanup path.
- **Workflow deletion**: `delete_lessons_for_workflow` is wired into the workflow delete transaction and uses `hard_delete_lesson` (the workflow is gone, so there is nothing to audit). Only lessons whose evidence references only that workflow are removed; cross-workflow lessons are preserved. `hard_delete_lesson` reaps child snapshots explicitly before the parent row for the same foreign-key-CASCADE-does-not-fire reason as `prune_lessons`.
- **Tauri commands**: `list_harness_lessons`, `create_harness_lesson`, `update_harness_lesson`, `rollback_harness_lesson`, `delete_harness_lesson` (soft-delete), `list_harness_lesson_snapshots`, `refine_harness_lessons_cmd`.
- **TS bridge**: `src/harness-lessons.ts` with typed wrappers and `formatLessonDigest`. No-ops outside the Tauri shell (returns empty arrays / zero summaries) so unit tests do not crash.
- **Byte/mediator tools**: `workflow_refine_lessons` and `workflow_list_lessons` added to `workflow-architect-tools.ts`; `node_refine_lessons` and `node_list_lessons` added to `company-mediator-tools.ts`. System prompts updated to direct Byte/mediator to call them after recurring failures and before prompt changes.
- **UI**: New "lessons" tab in `editor-inspector.tsx` (`HarnessLessonsPanel`) with refine, refresh, edit, history, rollback, and delete (soft-delete) controls. CSS in `src/styles.css`.
- **Tests**: 19 Rust tests in `harness_lessons::tests` covering create/snapshot, update/version-bump (incl. `update_lesson_with_title` updates title+body and `update_lesson` leaves title unchanged), rollback (including out-of-range rejection), active-only filtering + duplicate-active rejection, guidance per pattern, refine create/skip-on-success/update-on-signature-shift (incl. title follows the new signature)/skip-on-unchanged, refine determinism on tied failure classes, refine action ordering by pattern, soft-delete + prune reaping, cross-workflow preservation (incl. no orphaned snapshots), hard-delete reaps child snapshots, and prune (incl. no orphaned snapshots). 5 TS tests in `src/harness-lessons.test.ts` covering digest formatting and no-op behavior outside Tauri. Existing architect tools test updated to assert the two new tool names.

### Verification
- `cargo test --lib` — 238 passed, 0 failed, 1 ignored.
- `npm test` — 362 passed across 48 files.
- `npm run build` — passed (only the pre-existing chunk-size warning).
- `cargo clippy --lib` — 0 warnings.

### Trust boundaries
- Rust owns all lesson state and the refine algorithm (deterministic, reproducible, auditable). The operator remains the human review path via edit/rollback/soft-delete in the UI.
- Lessons never mutate `baseInstructions`; they are supplemental to developer instructions only.
- At most one active lesson per `(role, model, effort)` pattern (partial unique index + application-layer check), so run-time guidance is never duplicated.
- `prune_lessons` and `delete_lessons_for_workflow` are defensive against a missing `harness_lessons` table (older databases) so cleanup never fails on schema drift.
- Snapshot cleanup is explicit, not CASCADE-reliant: SQLite foreign keys are off by default in this codebase (`open_database` never sets `PRAGMA foreign_keys = ON`), so the `harness_lesson_snapshots` declared `ON DELETE CASCADE` never fires. Both `hard_delete_lesson` and `prune_lessons` delete child snapshot rows explicitly before/with the parent to avoid orphan accumulation.

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
