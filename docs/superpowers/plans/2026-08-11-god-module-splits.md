# God-Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the three god-modules (`main.tsx`, `lib.rs`, `workflow_runtime.rs`) into focused, deep modules with clear ownership, preserving all existing behavior.

**Architecture:** Incremental, seam-driven extraction. Each task extracts one cohesive responsibility area with clear seams first, preserving the public API via re-exports or thin wrappers. No speculative traits. No behavior changes. Each task ends with a green build + test cycle.

**Tech Stack:** TypeScript/React (frontend), Rust/Tauri (desktop runtime), Vitest (TS tests), Cargo test (Rust tests)

## Global Constraints

- Repository root: `C:\Users\suyas\Documents\Hackathon_OpenAI_Build_Week`
- Frontend build: `npm run build` (must pass with exit code 0)
- Frontend tests: `npm test` (366+ tests must pass)
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml` (must pass)
- Desktop release: `npm run desktop:build` (must produce `release/Codex-Corp.exe`)
- Preserve fail-closed behavior for verification and delivery
- Preserve native runtime invariant: standalone release builds must not depend on Vite dev server
- No behavior changes — pure structural refactoring
- Each task must end with `npm run build && npm test` (TS tasks) or `cargo test` (Rust tasks) passing
- Remove superseded code after extraction — no duplicate sources of truth
- Follow existing naming conventions (kebab-case TS files, snake_case Rust files)

---

## Phase 1: Rust Clear Seams (Low Risk)

### Task 1: Extract `process_limiter.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/process_limiter.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 92-151)
- Test: `cargo test --manifest-path src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `pub struct ProcessLimiter`, `pub struct ProcessPermit` (moved to new module)
- Consumes: `parking_lot` primitives (already a dependency)

- [ ] **Step 1: Read the current ProcessLimiter code (lines 92-151)**

Read `src-tauri/src/workflow_runtime.rs` lines 92-151 to capture the exact code.

- [ ] **Step 2: Create `src-tauri/src/workflow_runtime/` directory**

```bash
mkdir src-tauri/src/workflow_runtime
```

- [ ] **Step 3: Create `process_limiter.rs` with the extracted code**

Move `ProcessLimiter`, `ProcessPermit`, and their impl blocks to `src-tauri/src/workflow_runtime/process_limiter.rs`. Make structs and methods `pub` or `pub(crate)` as needed.

- [ ] **Step 4: Add module declaration in `workflow_runtime.rs`**

At the top of `workflow_runtime.rs`, add:
```rust
mod process_limiter;
pub use process_limiter::{ProcessLimiter, ProcessPermit};
```

Remove the original struct/impl definitions (lines 92-151).

- [ ] **Step 5: Run `cargo test --manifest-path src-tauri/Cargo.toml`**

Expected: PASS — all existing tests pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/workflow_runtime/ src-tauri/src/workflow_runtime.rs
git commit -m "refactor: extract ProcessLimiter into its own module"
```

---

### Task 2: Extract `graph_validation.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/graph_validation.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 964-1083)

**Interfaces:**
- Produces: `pub fn parse_graph(...)`, `pub fn validate_condition_rule(...)`, `pub fn evaluate_condition(...)`
- Consumes: `RuntimeGraph`, `RuntimeNode`, `ConditionRule` types from `workflow_runtime.rs`

- [ ] **Step 1: Read lines 964-1083 of `workflow_runtime.rs`**

- [ ] **Step 2: Create `graph_validation.rs` with extracted functions**

Move `parse_graph`, `validate_condition_rule`, `read_path`, `evaluate_condition` to the new module. Types they reference (`RuntimeGraph`, `RuntimeNode`, etc.) stay in `workflow_runtime.rs` — the new module imports them via `use crate::workflow_runtime::{...}` or `use super::{...}`.

- [ ] **Step 3: Add module declaration and re-exports**

```rust
mod graph_validation;
pub use graph_validation::{parse_graph, validate_condition_rule, evaluate_condition};
```

- [ ] **Step 4: Run `cargo test`**

Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 3: Extract `scheduler.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/scheduler.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 4433-4648)

**Interfaces:**
- Produces: `pub fn cron_field_matches(...)`, `pub fn cron_matches_at(...)`, `pub fn due_schedules(...)`, `pub fn scheduler_tick(...)`, `pub fn start_scheduler(...)`, etc.
- Consumes: `Database`, `WorkflowRuntime`, `RuntimeGraph`

- [ ] **Step 1: Read lines 4433-4648**

- [ ] **Step 2: Create `scheduler.rs` with all cron/scheduler functions**

Move `cron_field_matches`, `cron_matches_at`, `due_schedules`, `reserve_schedule_firing`, `release_schedule_firing`, `workflow_is_active`, `scheduler_tick`, `start_scheduler` to the new module. Also move `DueSchedule` struct.

- [ ] **Step 3: Add module declaration and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

### Task 4: Extract `approval_gates.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/approval_gates.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 3012-3265)

**Interfaces:**
- Produces: `pub async fn await_operator_approval(...)`, `pub async fn approval_node(...)`, `pub fn operator_approval_timeout(...)`, etc.
- Consumes: `RunContext`, `RuntimeNode`, `RunApprovalBroker`

- [ ] **Step 1: Read lines 3012-3265**

- [ ] **Step 2: Create `approval_gates.rs` with extracted functions**

Move `await_operator_approval`, `approval_node`, `operator_approval_timeout`, `parse_needs_human_timeout`, `wait_for_approval` to the new module.

- [ ] **Step 3: Add module declaration and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

### Task 5: Extract `node_experience.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/node_experience.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 506-750)

**Interfaces:**
- Produces: `pub fn record_node_experience(...)`, `pub fn get_node_experience(...)`, `pub fn load_node_experience(...)`, `pub fn experience_guidance(...)`, `pub fn prune_node_experience(...)`, etc.
- Consumes: `Database`, `NodeExperience`

- [ ] **Step 1: Read lines 506-750**

- [ ] **Step 2: Create `node_experience.rs` with extracted functions and types**

Move `NodeExperience` struct, `record_node_experience`, `get_node_experience`, `load_node_experience`, `experience_guidance`, `delete_node_experience_for_workflow`, `prune_node_experience`, and the `initialize_database` for node_experience table.

- [ ] **Step 3: Add module declaration and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

### Task 6: Extract `workflow_validation.rs` from `lib.rs`

**Files:**
- Create: `src-tauri/src/workflow_validation.rs`
- Modify: `src-tauri/src/lib.rs` (lines 1519-2133)

**Interfaces:**
- Produces: `pub fn is_revision(...)`, `pub fn standard_cycle(...)`, `pub fn validate_graph(...)`, `pub fn build_execution_plan(...)`
- Consumes: `GraphSnapshot`, `GraphNode`, `GraphEdge`, `GraphCriterion` DTOs (these stay in `lib.rs` or move with the validation)

- [ ] **Step 1: Read lines 1519-2133 of `lib.rs`**

- [ ] **Step 2: Create `workflow_validation.rs`**

Move `is_revision`, `standard_cycle`, `problem`, `validate_graph`, `build_execution_plan` to the new module. Move `GraphProblem` and `ExecutionPlan` structs. Import graph DTOs from `lib.rs` via `use crate::{GraphSnapshot, GraphNode, ...}`.

- [ ] **Step 3: Add `mod workflow_validation;` to `lib.rs` and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

### Task 7: Extract `codex_discovery.rs` from `lib.rs`

**Files:**
- Create: `src-tauri/src/codex_discovery.rs`
- Modify: `src-tauri/src/lib.rs` (lines 1253-1450, 2194-2365)

**Interfaces:**
- Produces: `pub fn find_node_exe(...)`, `pub fn system_codex_path(...)`, `pub fn command_for_codex(...)`, `pub fn discover_codex_impl(...)`, etc.
- Consumes: `CodexInfo` DTO

- [ ] **Step 1: Read the discovery-related lines**

- [ ] **Step 2: Create `codex_discovery.rs` with path resolution and discovery functions**

Move `npm_dir`, `npm_codex_js`, `find_node_exe`, `system_codex_path`, `fallback_codex_path`, `active_codex_path`, `is_npm_codex_shim`, `prepare_command`, `command_for_codex`, `discover_codex_impl` to the new module.

- [ ] **Step 3: Add module declaration and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

## Phase 2: TypeScript Clear Seams (Low Risk)

### Task 8: Extract `useGraphHistory` hook from `main.tsx`

**Files:**
- Create: `src/hooks/useGraphHistory.ts`
- Modify: `src/main.tsx` (lines 916-922, 1016-1042)

**Interfaces:**
- Produces: `useGraphHistory(nodes, setNodes, edges, setEdges)` → `{ snapshot, pushHistory, restore, undo, redo, historyPast, historyFuture, canUndo, canRedo }`
- Consumes: `FlowNode[]`, `FlowEdge[]` and their setters

- [ ] **Step 1: Read the history-related code in `main.tsx`**

- [ ] **Step 2: Create `src/hooks/` directory and `useGraphHistory.ts`**

Extract `snapshot`, `pushHistory`, `restore`, `undo`, `redo` and the `historyPast`, `historyFuture` state into a custom hook.

- [ ] **Step 3: Replace inline code in `main.tsx` with hook usage**

```typescript
const { snapshot, pushHistory, restore, undo, redo, historyPast, historyFuture } = useGraphHistory(nodes, setNodes, edges, setEdges);
```

- [ ] **Step 4: Run `npm run build && npm test`**

Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 9: Extract `useRunHistory` hook from `main.tsx`

**Files:**
- Create: `src/hooks/useRunHistory.ts`
- Modify: `src/main.tsx` (lines 1465-1507, 2218-2255)

**Interfaces:**
- Produces: `useRunHistory()` → `{ runHistory, setRunHistory, portfolioRunSummaries, loadRunHistoryFor, loadPortfolioRunSummaries, inspectRun }`
- Consumes: `invoke` from Tauri, `RunRecord`, `PortfolioRunSummary` types

- [ ] **Step 1: Read the run history code**

- [ ] **Step 2: Create `useRunHistory.ts`**

Extract `loadRunHistoryFor`, `loadPortfolioRunSummaries`, `inspectRun` and the `runHistory`, `portfolioRunSummaries` state.

- [ ] **Step 3: Replace inline code in `main.tsx`**

- [ ] **Step 4: Run `npm run build && npm test`**

- [ ] **Step 5: Commit**

---

### Task 10: Extract `useLocalTest` hook from `main.tsx`

**Files:**
- Create: `src/hooks/useLocalTest.ts`
- Modify: `src/main.tsx` (lines 2601-2775)

**Interfaces:**
- Produces: `useLocalTest(workflowId, nodes, edges, approvalsRef, ...)` → `{ localTest, prepareLocalTestForRun, resolveLocalTestLaunch, submitLocalTestFeedback, stopLocalTest }`
- Consumes: `LocalTestSession`, `invoke`, workflow state

- [ ] **Step 1: Read the local test code**

- [ ] **Step 2: Create `useLocalTest.ts`**

Extract `prepareLocalTestForRun`, `resolveLocalTestLaunch`, `submitLocalTestFeedback`, `stopLocalTest` and the `localTest` state.

- [ ] **Step 3: Replace inline code in `main.tsx`**

- [ ] **Step 4: Run `npm run build && npm test`**

- [ ] **Step 5: Commit**

---

## Phase 3: Rust Moderate Coupling (Medium Risk)

### Task 11: Extract `event_emission.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/event_emission.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 898-962, 2215-2315, 3276-3326)

**Interfaces:**
- Produces: `pub fn emit_event(...)`, `pub fn slim_artifact_meta(...)`, `pub fn slim_attempt_completed_diagnostics(...)`, etc.
- Consumes: `RunContext`, `WorkflowRunEvent`

- [ ] **Step 1: Read all event emission code**

- [ ] **Step 2: Create `event_emission.rs`**

Move `now_isoish`, `event_item_type`, `emit_event`, `slim_artifact_meta`, `slim_attempt_completed_diagnostics`, `slim_control_completed_diagnostics`, `emits_control_completion`, `revision_routed_diagnostics`, `collect_residual_risks` to the new module.

- [ ] **Step 3: Add module declaration and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

### Task 12: Extract `output_mapping.rs` from `workflow_runtime.rs`

**Files:**
- Create: `src-tauri/src/workflow_runtime/output_mapping.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (lines 1556-1743)

**Interfaces:**
- Produces: `pub fn resolve_json_path(...)`, `pub fn mapped_output(...)`, `pub fn compose_specialist_input(...)`, `pub fn validate_json_schema(...)`
- Consumes: `RuntimeNode`, `RuntimeOutput`, `MappedOutput`

- [ ] **Step 1: Read lines 1556-1743**

- [ ] **Step 2: Create `output_mapping.rs`**

Move `resolve_artifact_content_hash`, `resolve_json_path`, `mapped_output`, `compose_specialist_input`, `validate_json_schema`, `MappedOutput` to the new module.

- [ ] **Step 3: Add module declaration and re-exports**

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

### Task 13: Extract `realtime.rs` from `lib.rs`

**Files:**
- Create: `src-tauri/src/realtime.rs`
- Modify: `src-tauri/src/lib.rs` (lines 3468-4569)

**Interfaces:**
- Produces: All realtime voice session types and functions
- Consumes: `RealtimeBroker`, `RealtimeSession`, Tauri AppHandle

- [ ] **Step 1: Read lines 3468-4569**

- [ ] **Step 2: Create `realtime.rs`**

Move `StartRealtimeRequest`, `StartRealtimeResult`, `RealtimeDispatcherContext`, `spawn_realtime_dispatcher`, and the Tauri commands `start_codex_realtime`, `append_codex_realtime_audio/text/speech`, `stop_codex_realtime` to the new module. Keep the `#[tauri::command]` attributes.

- [ ] **Step 3: Add module declaration and register commands in the Tauri builder**

Update the `run()` function's `invoke_handler` to reference the moved commands.

- [ ] **Step 4: Run `cargo test`**

- [ ] **Step 5: Commit**

---

## Phase 4: TypeScript Moderate Coupling (Medium Risk)

### Task 14: Extract `useApprovals` hook from `main.tsx`

**Files:**
- Create: `src/hooks/useApprovals.ts`
- Modify: `src/main.tsx` (lines 809-832, 833-849, 1422-1464, 2474-2534)

**Interfaces:**
- Produces: `useApprovals(nodes, setNodes, ...)` → `{ approvals, activeApproval, approvalCenterOpen, decideApprovalFor, decideApproval, askOperatorConfirmation, resolveOperatorConfirmation, askMediatorQuestion, resolveMediatorQuestion, closeDecisionCenter }`
- Consumes: `FlowNode[]`, `ApprovalRequest`, `MediatorQuestion`

- [ ] **Step 1: Read all approval-related code**

- [ ] **Step 2: Create `useApprovals.ts`**

Extract all approval state and functions.

- [ ] **Step 3: Replace inline code in `main.tsx`**

- [ ] **Step 4: Run `npm run build && npm test`**

- [ ] **Step 5: Commit**

---

### Task 15: Extract `useWorkflowPersistence` hook from `main.tsx`

**Files:**
- Create: `src/hooks/useWorkflowPersistence.ts`
- Modify: `src/main.tsx` (lines 2032-2391, 1310-1326)

**Interfaces:**
- Produces: `useWorkflowPersistence(nodes, edges, ...)` → `{ workflowId, workflowName, save, load, resetToSeed, switchTemplate, createBlankWorkflow, applyGraph, persistWorkflowMetadata, ... }`
- Consumes: `FlowNode[]`, `FlowEdge[]`, `invoke`, `native`

- [ ] **Step 1: Read persistence code**

- [ ] **Step 2: Create `useWorkflowPersistence.ts`**

- [ ] **Step 3: Replace inline code in `main.tsx`**

- [ ] **Step 4: Run `npm run build && npm test`**

- [ ] **Step 5: Commit**

---

## Phase 5: High-Risk Extractions (Deferred to Follow-Up)

The following extractions are documented but deferred to focused follow-up sessions because they involve deeply intertwined state and require careful interface design:

### `main.tsx` remaining:
- `useGraphEditing` — graph editing operations (high coupling to ReactFlow state)
- `useRunOrchestration` — run/stop/resume (deeply coupled to validation, persistence, native)
- `useMediatorIntegration` — mediator/chat turn handling (deeply integrated with run state)
- `useCodexDiscovery` — Codex CLI discovery and model loading effects
- `useNativeEventListeners` — native event listener effects
- View extraction — split render functions into EditorView, OverviewView, ArchitectView, ChatView

### `lib.rs` remaining:
- `codex_protocol.rs` — JSON-RPC protocol and AppServerConnection
- `run_hydration.rs` — run record hydration and portfolio summaries
- `mediator.rs` — mediator turn execution
- Agent execution core refactoring — `execute_agent_internal` (985 lines) needs decomposition first

### `workflow_runtime.rs` remaining:
- `verification_integration.rs` — criterion evaluation (moderate coupling to verifier module)
- `retry_policy.rs` — retry state machine (intertwined with node execution)
- `node_execution.rs` — node execution orchestration (deeply intertwined)
- `run_lifecycle.rs` — run_worker, start_run, resume_run (main orchestration loop)
- `graph_traversal.rs` — dependency traversal (embedded in run_worker)

These should be tackled one at a time in dedicated sessions with full test verification.

---

## Verification

After all Phase 1-4 tasks are complete, run the full verification suite:

- [ ] **`npm run build`** — must pass with exit code 0
- [ ] **`npm test`** — all 366+ tests must pass
- [ ] **`cargo test --manifest-path src-tauri/Cargo.toml`** — all Rust tests must pass
- [ ] **`npm run desktop:build`** — must produce `release/Codex-Corp.exe`
- [ ] Report warnings separately from failures
