# Stream visibility, decision-center lifecycle, staged release, and Byte workspace shell — Design

**Date:** 2026-08-12
**Status:** Approved (Option 2 — staged release graph)
**Scope:** Frontend (React/TypeScript), native runtime (Rust/Tauri), persistence, workflow templates, E2E

## 1. Problem statements

### 1.1 Live AI thinking/trace visibility
The bottom execution bar and workflow chat surfaces show only the first and last lifecycle messages for a node, not the actual model reasoning/plan/tool-progress stream. Reasoning-summary, plan, console, diff, and warning events are persisted as typed trace records, but the UI does not render them as a bounded live stream, and workflow chat does not receive per-node stream entries at all.

### 1.2 Permission/approval popup persists after approval
The decision-center modal remains mounted after the last pending decision is resolved because `approvalCenterOpen` is independent state, not derived from the set of pending decisions. The same class of stale-open behavior exists for mediator questions and local-test launch approvals.

### 1.3 QA → demo/release approval behavior
The current Software Company template ends with a non-AI human approval control node followed by a deterministic Release Bundle output node. The approval node freezes artifact hashes but does not run the product, create a Git commit, or push to `main`. The user wants a meaningful AI-mediated two-stage review:

1. QA completes verification.
2. An AI Release Coordinator asks whether the finished product may be run and demonstrated.
3. If yes, the product is run through the approved local-test/demo mechanism and a local release commit is created for the exact verified candidate.
4. A separate publish approval asks whether to push that exact commit to `main`.

### 1.4 Workflow-chat command execution
Byte (the workflow-chat mediator) currently runs with `approvalPolicy: "never"` and `sandbox: "read-only"`, and its app-server loop does not implement the same `requestApproval` broker path used by specialist nodes. Telling Byte to run a shell command is therefore not equivalent to asking the Builder/QA node to run it. The user wants Byte to have direct workspace shell authority through a native selected-workspace boundary, with explicit approval for destructive and publish operations.

## 2. Root causes

### 2.1 Stream visibility
- The Rust adapter emits specialist assistant deltas as `agent.message.delta`, but `src/stream-display.ts` only recognizes `item/agentMessage/delta`, so specialist assistant deltas are ignored by the graph UI. <ref_snippet file="src-tauri/src/lib.rs" lines="6313-6333" />
- The bottom execution drawer renders only the lifecycle timeline, not the typed trace records that contain reasoning/plan/console events. <ref_snippet file="src/main.tsx" lines="4913-4947" />
- The node card renders a single preview string and CSS clamps it to two lines. <ref_snippet file="src/main.tsx" lines="550-560" />
- Workflow chat persists and renders only ordinary `ChatMessage.text`; mediator reasoning-summary events are not routed into the chat message model. <ref_snippet file="src/agent-chat-page.tsx" lines="872-918" />

### 2.2 Approval popup lifecycle
- `approvalCenterOpen` is stored independently of the pending-decision set. Resolving a native approval updates the request status but does not close the center when no pending request remains. <ref_snippet file="src/main.tsx" lines="2469-2525" />
- Multiple decision channels (native Codex approvals, graph release approvals, Byte confirmations, structured questions, local-test launch) are managed separately and can race or leave stale state.

### 2.3 Release semantics
- The approval node is a non-AI control node that waits on the run-approval broker, records the operator's decision, and freezes approved artifact hashes. <ref_snippet file="src-tauri/src/workflow_runtime/approval_gates.rs" lines="16-211" />
- The Release Bundle node is a deterministic control node that compares approved artifact hashes with live artifacts and writes `delivery-bundle.json`. It does not run the product, create a Git commit, or push to `main`. <ref_snippet file="src-tauri/src/workflow_runtime.rs" lines="2733-2810" />
- The existing local-test flow is a separate post-run step, not integrated into the graph. <ref_snippet file="src-tauri/src/local_test.rs" lines="166-231" />

### 2.4 Workflow-chat access denied
- The mediator is started with `approvalPolicy: "never"` and `sandbox: "read-only"`, and its app-server loop does not implement the `requestApproval` broker path used by specialist nodes. <ref_snippet file="src-tauri/src/lib.rs" lines="3017-3024" />
- The selected workspace is already propagated through `ChatSession.workspacePath`, `execute_mediator_turn.request.workspacePath`, `activeChatWorkspaceRef`, persisted workflow `workspacePath`, and native runtime `target_workspace`, so the missing capability is a native shell execution seam, not workspace selection.

## 3. Design

### 3.1 Unified streamed execution context

#### 3.1.1 Canonical event contract
A single normalized stream envelope is introduced for both specialist nodes and Byte:

```ts
type ExecutionStreamKind =
  | "reasoning-summary"
  | "plan"
  | "console"
  | "diff"
  | "file-change"
  | "warning"
  | "lifecycle";

type ExecutionStreamEvent = {
  streamKey: string;       // `${runId}/${nodeId}/${turnId}` or `chat/${sessionId}/${turnId}`
  nodeId: string;
  nodeLabel?: string;
  surface: "workflow-node" | "workflow-chat";
  kind: ExecutionStreamKind;
  text: string;
  at: number;
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  messageId?: string;
  complete?: boolean;
};
```

The native adapter is the single source of truth for translating Codex app-server notifications into this contract. This removes the current mismatch where Rust emits `agent.message.delta` but the TypeScript helper only recognizes `item/agentMessage/delta`.

For chat, the event includes `sessionId` and `messageId`, so a stream can be patched into the correct chat turn rather than being accidentally treated as a graph-node event.

#### 3.1.2 What is visible
The UI displays only model-provided reasoning summaries, plans, command output, file-change/diff summaries, warnings, and lifecycle progress. It does not display private raw chain-of-thought tokens. Raw internal reasoning events are filtered at the native adapter or retained only as non-rendered diagnostics. This matches the existing delivery contract, which marks `chainOfThought` as `"not-exposed"`. <ref_snippet file="src-tauri/src/workflow_runtime.rs" lines="2780-2791" />

#### 3.1.3 Bounded stream storage and line coalescing
Each active node/turn maintains a bounded stream buffer:
- **16 retained lines** (within the requested 10–20 line range);
- a character cap as a second protection against very long individual lines;
- delta fragments coalesced into lines instead of rendering one row per token;
- completed streams retained as a compact snapshot for inspection;
- no unbounded high-frequency persistence into chat history.

**Line coalescing invariant (critical):** A stream delta updates the current visible line; it never creates a new log row by itself. A new row is created only when:
- the model emits an actual newline;
- the semantic stream kind changes (e.g. reasoning → console);
- the current stream completes;
- a soft-wrap threshold is reached after a meaningful amount of text.

```text
"The" + " app" + " starts" + " correctly"
→ one visible line: "The app starts correctly"
```

Rapid events are coalesced before rendering using an animation-frame queue, so the UI does not re-render once per token even when the native stream delivers many small fragments.

Workflow chat receives one stream-bearing message per node/turn and patches that message in place while the node is active. This prevents the chat from accumulating hundreds of messages for one execution.

#### 3.1.4 Shared UI behavior
A shared `ExecutionStreamDisclosure` module is used in:
1. the bottom execution drawer;
2. each workflow-chat node/progress entry;
3. the compact node-card live indicator.

Each disclosure has:
- an accessible expand/collapse button;
- a scrollable stream viewport;
- line count and current state;
- clear labels such as "Reasoning summary", "Plan", or "Console";
- `white-space: pre-wrap` and safe wrapping for long commands/output.

Only one stream is expanded at a time per surface. When a new node begins emitting a stream, the previous stream automatically collapses while its bounded history remains available through its own dropdown.

The bottom drawer gains a stream-oriented view that groups records by node rather than showing only the last twelve lifecycle events. Workflow chat shows the same records under the corresponding node's disclosure.

### 3.2 Decision-center lifecycle

#### 3.2.1 Single pending-decision source of truth
Decision state is centralized around the actual pending work:

```text
pending native approvals
+ pending graph approvals
+ active Byte confirmation
+ active structured question
+ pending local-test launch
```

After a successful decision:
- the resolved request is marked approved or declined;
- the next pending request remains visible if one exists;
- the modal closes automatically when no decision remains;
- duplicate native resolution events remain harmless (idempotent);
- an invoke failure leaves the approval visible and actionable;
- manually opening the approvals center can still show an empty state.

This removes the current stale-modal state where the popup remains open with "No pending decisions" after the last approval has already been completed.

#### 3.2.2 Run/workflow switching
Switching runs or workflows scopes pending decisions correctly:
- pending decisions for a non-active run are retained but not shown in the modal;
- the modal derives visibility from pending decisions for the active run plus cross-run decisions (Byte confirmations, structured questions) that are not run-scoped;
- run completion/termination cleans up related pending approvals.

### 3.3 Direct Byte workspace shell

#### 3.3.1 Native boundary
The mediator turn changes from:

```text
approvalPolicy = never
sandbox = read-only
```

to:

```text
approvalPolicy = on-request
sandbox = workspace-write
cwd = selected workspace
```

The native mediator loop uses the same approval broker contract as specialist nodes:
1. Byte requests a command.
2. The native host validates the request.
3. The request is shown in the existing approval center with command and working directory.
4. The user approves or declines it.
5. The native host sends the decision back to Codex.
6. The command output is streamed through the unified stream contract.
7. Timeouts, cancellation, and process cleanup remove all stale broker entries.

The boundary enforces:
- selected-workspace path scope (no implicit fallback to the application install directory or repository root);
- process lifecycle cleanup;
- stop/cancellation support;
- wall-clock and idle timeouts;
- output size limits;
- secret/redaction handling;
- clear exit codes and stderr/stdout reporting;
- explicit approval for destructive commands;
- explicit approval for Git commit/push or other external side effects.

#### 3.3.2 Publish-operation guard
To preserve the separate publish approval decision:
- `git status`, `git diff`, and read-only inspection remain available to Byte;
- `git commit`, `git push`, force-push, destructive reset, and equivalent release operations are not allowed through ordinary Byte shell access;
- those operations are handled only by the dedicated release/publish actions tied to the exact approved revision.

The guard is enforced at the native approval boundary, not merely by prompt text, so a mediator that attempts a publish operation is rejected with a clear typed error before any process is spawned.

### 3.4 Staged release graph

#### 3.4.1 Graph shape
The Software Company template changes from:

```text
input → PM → architect → builder → QA → approval → output
```

to:

```text
input → PM → architect → builder → QA → release-coordinator → demo → release-commit → publish-approval → output
```

#### 3.4.2 Release Coordinator (AI node)
A read-only AI node that:
- receives QA's verification summary and the approved artifact snapshot;
- presents a structured Yes/No question: "May I launch and demo this candidate?";
- if No: the run transitions to a clearly defined declined state and no release commit is created;
- if Yes: the demo node proceeds.

#### 3.4.3 Demo node
Runs the product through the approved local-test/demo mechanism:
- the user sees exact launch details and can inspect the result;
- the approved artifact snapshot remains immutable;
- on success, the release-commit node proceeds;
- on failure or user "request changes", the run returns to QA or stops with a clear declined state.

#### 3.4.4 Release-commit node
Creates a local release commit for the exact verified release candidate:
- the commit is bound to the exact approved artifact/hash snapshot, not current mutable workspace state;
- idempotent creation: if a commit already exists for this snapshot, it is reused;
- if the workspace is not a Git repository, the node fails closed with a clear message;
- if the branch is not `main`, the commit is created on the current branch but publish is blocked until the user explicitly confirms;
- uncommitted unrelated changes are reported and the node fails closed unless the user explicitly stashes or commits them first;
- Git command failures are reported with redacted output;
- the commit hash is recorded for the publish node.

#### 3.4.5 Publish-approval node
A separate human approval node that:
- asks whether to push the exact recorded commit to `main`;
- if approved: the exact recorded commit is pushed to `main` and the UI reports the commit hash, target branch, and push result;
- if declined: the local release commit remains available, no push occurs, and the UI clearly reports that publishing was skipped;
- push requires remote configuration and authentication; failures are reported with redacted output;
- retries use the exact recorded commit and do not create duplicate commits or push a different revision.

#### 3.4.6 Release candidate object
The release candidate is represented as:

```ts
type ReleaseCandidate = {
  runId: string;
  approvedArtifactSnapshot: ArtifactSnapshot;  // frozen at QA approval
  verificationResult: VerificationResult;       // from QA
  demoResult: DemoResult;                       // from demo node
  commitHash?: string;                          // set by release-commit node
  commitBranch?: string;
  publishState: "pending" | "approved" | "declined" | "pushed" | "failed";
  publishError?: string;
  pushedAt?: number;
};
```

The delivery bundle remains fail-closed and must not claim success without runtime verification and a non-empty, pair-compare-clean approval artifact set.

## 4. Architecture options considered

1. **Minimal compatibility patch** — keep the current human control approval node, improve its copy with AI-generated QA context, and retain the existing post-run local-test flow. Smallest change, but the approval is still not an AI node and the run does not wait for demo before delivery. **Rejected.**
2. **Staged release graph (recommended, approved)** — add a read-only AI Release Coordinator node after QA, a native demo action, a release-commit node, and a separate publish-approval node. Matches the two-stage review choice and preserves runtime ownership of decisions and side effects. **Selected.**
3. **General action-node framework** — introduce reusable capability/action nodes for demo, commit, publish, and other external effects. Most extensible, but substantially broader than this bugfix and unnecessary for the immediate Software Company path. **Rejected.**

## 5. Acceptance criteria

### 5.1 Stream visibility
- [ ] The bottom execution drawer shows a bounded, scrollable, collapsible live reasoning-summary/plan/console stream per node.
- [ ] Workflow chat shows the same per-node stream under each node's disclosure.
- [ ] Each disclosure has a scrollbar when expanded.
- [ ] Streams are hidden by default.
- [ ] Activating a new node's stream automatically collapses the previous stream.
- [ ] Streams are bounded to 16 lines.
- [ ] Delta fragments coalesce into lines; no one-row-per-token rendering.
- [ ] Private raw chain-of-thought is not exposed; only protocol-provided reasoning summaries/plans/tool output are shown.
- [ ] Specialist assistant deltas (currently emitted as `agent.message.delta`) are rendered, not ignored.

### 5.2 Approval popup lifecycle
- [ ] The decision-center modal closes automatically when no pending decision remains.
- [ ] Approving or declining a request removes it from the pending set.
- [ ] Duplicate resolution events are idempotent.
- [ ] A completed approval does not reopen the modal.
- [ ] A pending decision from another node/run does not incorrectly pin a resolved node.
- [ ] Modal closure resolves/cancels the correct pending interaction.
- [ ] Run completion/termination cleans up related pending approvals.
- [ ] A failed approval invocation leaves the approval visible and actionable.

### 5.3 Staged release
- [ ] The Software Company template includes Release Coordinator, demo, release-commit, and publish-approval nodes.
- [ ] The Release Coordinator presents a structured Yes/No question.
- [ ] Selecting No stops the run or transitions to a clearly defined declined state with no release commit.
- [ ] Selecting Yes runs the demo and creates a local release commit for the exact verified candidate.
- [ ] The publish-approval node asks whether to push the exact commit to `main`.
- [ ] Publish approval pushes the exact recorded commit and reports the commit hash, target branch, and push result.
- [ ] Publish decline leaves the local release commit available and reports that publishing was skipped.
- [ ] The delivery bundle remains fail-closed.
- [ ] Non-Git workspaces, wrong branches, uncommitted changes, and Git failures are handled with clear messages.

### 5.4 Byte direct shell
- [ ] Byte can execute shell commands in the selected workspace.
- [ ] Commands are routed through the native approval broker.
- [ ] The shell uses `workspace-write` sandbox and the selected workspace as cwd.
- [ ] Destructive commands require explicit approval.
- [ ] `git commit`, `git push`, force-push, and destructive reset are blocked from ordinary Byte shell access.
- [ ] Timeouts, cancellation, and process cleanup remove stale broker entries.
- [ ] Output is streamed through the unified stream contract.
- [ ] The UI explains that Byte's shell operates in the selected workspace and is subject to the native execution boundary.

## 6. Test strategy

### 6.1 Unit tests (TypeScript)
- `src/stream-display.test.ts`: normalize both raw and already-normalized assistant delta names; verify reasoning-summary events are accepted and raw reasoning events are not rendered; verify fragments coalesce into lines; verify the buffer never exceeds 16 lines or its character cap; verify a new active stream changes the expansion key and collapses the previous stream; verify mediator stream events patch the correct chat message using `sessionId`/`messageId`.
- `src/decision-center.test.tsx`: approval center closes after the final native approval; stays open when another request is pending; correct state for graph approvals, Byte confirmations, questions, and local-test launch; failed approval invocations do not remove the request; run completion cleans up pending approvals.
- `src/release-candidate.test.ts`: release candidate state transitions; idempotent commit creation; publish state transitions.
- `src/company-mediator-tools.test.ts`: Byte shell tool is registered; publish-guard rejects `git commit`/`git push`.

### 6.2 Unit tests (Rust)
- `src-tauri/src/lib.rs`: mediator turn uses `workspace-write` and `on-request`; mediator `requestApproval` is routed through the broker; publish-guard rejects publish operations; broker entries are removed after approval, decline, timeout, cancellation, and process exit.
- `src-tauri/src/workflow_runtime/release.rs`: release-commit node creates idempotent commit; publish-approval node pushes exact commit; non-Git workspace fails closed; wrong branch reports clearly; Git failures are reported with redacted output.

### 6.3 Integration / E2E
- `e2e/workflow.spec.ts`: bounded stream UI behavior; per-node disclosure; approval center closes after resolution; staged release flow.

### 6.4 Manual verification
- `npm run desktop:dev` — verify live stream updates in the execution drawer and workflow chat.
- `npm run desktop:build` — launch the exact newly built executable and inspect the rendered window.

## 7. Failure-path behavior

- Stream events that cannot be classified are ignored (not rendered as raw text).
- Approval invocations that fail leave the approval visible and actionable.
- Release-commit failures (non-Git, wrong branch, uncommitted changes, Git errors) fail closed with clear messages.
- Publish failures (no remote, auth failure, push rejection) are reported with redacted output; the local release commit remains available.
- Broker entries are removed after approval, decline, timeout, cancellation, and process exit.

## 8. Migration / backward compatibility

- Existing Software Company workflow snapshots are migrated to the new graph shape on load, preserving node IDs where possible and adding the new nodes with default configuration.
- Existing chat sessions without stream-bearing messages continue to render normally; stream disclosures are added only to new messages.
- Existing approval state is preserved; the new visibility derivation treats already-resolved approvals as not pending.
- The delivery bundle contract is unchanged; the release-commit and publish nodes are additive and do not alter the fail-closed verification behavior.

## 9. Existing approval node and release bundle explanation

For clarity, the current behavior (before this design is implemented):

- **Approval node**: a non-AI control node that waits on the native run-approval broker, records the operator's decision, and freezes the exact artifact keys/hashes approved at that moment. It does not run the product, create a Git commit, or push to `main`.
- **Release Bundle node**: a deterministic control node that requires explicit approval, requires runtime-owned verification, compares frozen approved artifact hashes with live artifacts, and writes `delivery-bundle.json` with provenance, verification, residual risks, and a bundle hash. It does not run the product, create a Git commit, or push to `main`.

After this design is implemented, the approval node is replaced by the Release Coordinator (AI) and publish-approval (human) nodes, and the Release Bundle node is preserved as the verification handoff that feeds the release-commit node.
