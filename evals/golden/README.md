# Golden evaluation fixtures

Host-owned verification fixtures for Codex Corp layer A. Each JSON follows the
same shape: an `id`, a criterion/attempt shape that exercises one host verifier
or failure category, and an `expect` block documenting the required outcome.
Runtime unit tests under `src-tauri/src/verifier/**` and the `golden_evals`
test in `src-tauri/src/verifier/mod.rs` execute the fixtures in CI.

Mission fixtures (`"runMode": "mission"`) additionally carry a `mission` block,
`scriptedOutputs`, and an `expect.runStatus` / `expect.delivery` block. The
mission-level runner (`evals/runner.mjs`) drives each one end-to-end through
`start_run_headless` against a scripted fake Codex app-server and asserts the
run's terminal status + delivery node `data.verification` / `bundleHash`.

## Fixtures

| Fixture | Asserts |
|---|---|
| `self-attestation-blocked` | Required claim cannot pass on producer `passed:true` |
| `missing-artifact` | `artifact_exists` fails when name absent |
| `command-fail` | Allowlisted command non-zero exit fails |
| `architecture-wrong-layer` | Suspect TS runtime paths fail architecture policy |
| `architecture-wrong-layer-unanticipated` | v2 structural policy catches an unanticipated wrong-layer scheduler by SHAPE (`src/scheduler/job_runner.ts`) that v1's fixed globs miss |
| `delivery-stale-hash` | Pair-compare fails on hash mismatch |
| `transient-failure-retry` | Provider/network flakiness classifies `transient` and backs off (no plateau) |
| `capability-denial` | Sandbox/workspace write denial classifies `capability` → and arms a `needs_human` gate (P2) |
| `quality-plateau-stop` | ≥2 identical fingerprints + stable artifact hash-set fires plateau stop |
| `spec-ambiguity-pause` | Ambiguous/incomplete acceptance criteria classify `specification` → `needs_human` gate (P2) |
| `revision-loop-evidence-routing` | Required verification row routes exact failing evidence into the revision turn; persists a `failureClass:"verification"` attempt record (P3) |
| `mission-delivery-trusted` | Full run with fake app-server: passing required criteria → `completed` run with non-empty `bundleHash` + runtime verification rows |
| `mission-delivery-fail-closed` | Full run: required claim can never pass → run `failed`, no `bundleHash` is ever produced |
| `mission-capability-gate-times-out` | Full run: capability → `needs_human` gate with no operator → fail-closed via `CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS` (P1) |
| `mission-command-fail-required` | Full run: required `node_script` exits non-zero → run `failed`, no bundle (P3a) |
| `mission-architecture-wrong-layer-v2` | Full run: architecture v2 catches a producer-side scheduler by shape; terminal reason names the module (P3b) |
| `mission-delivery-stale-hash` | Full run: post-approval artifact makes the live set stale → delivery pair-compare fails, terminal reason names pair-compare (P3c) |
| `mission-revision-loop` | Full run: required verification → revision → re-review completes; ≥1 persisted `failureClass:"verification"` attempt record (P3d) |

## Failure taxonomy

The attempt-level classifier records one of the product-strategy classes on
`node_attempts.diagnostics_json.failureClass`, retry events
(`retry.transient|retry.contract_repair|retry.plateau|retry.needs_human|retry.exhausted`),
and terminal failure events:

- `transient` — provider timeout / rate limit / connection loss → backoff and retry
- `contract` — invalid JSON / schema / missing artifact → focused repair turn
- `verification` — test or policy failed → send exact failing evidence to the producer
- `capability` — permission / unavailable tool → arm a `needs_human` gate (or reroute)
- `specification` — acceptance-criteria conflict or incompleteness → arm a `needs_human` gate
- `plateau` — repeated identical failure with stable artifacts → change strategy or stop
- `fatal` — fallback for genuinely unclassified errors (operator decline, internal)

These are **documentation + JSON shapes** for eval harnesses. Runtime unit tests
under `src-tauri/src/verifier/**` cover the same cases executable-in-CI.

## Mission-level runner

Loads every fixture and drives the `runMode:"mission"` ones end-to-end through
`start_run_headless` against a scripted fake app-server
(`scripts/fake-codex-server.mjs` — protocol-level JSON-RPC over stdio, so no
real Codex install and no GTK are needed). Classification-only fixtures are
reported as `skipped` (they execute in the Rust `golden_evals` unit test).

Mission fixtures support these runner hooks:

- `scriptedOutputs` — one structured output per specialist turn. The fake
  server serves them per attempt through a shared on-disk cursor
  (`CODEX_CORP_GOLDEN_OUTPUTS_CURSOR`) because each turn spawns a fresh
  app-server process, so multi-turn missions (revision loops, post-approval
  agents) consume `outputs[0..N]` deterministically.
- `mission.workspaceFiles` / `workspaceFiles` — JSON object of
  relative-path → content seeded into the run workspace before the mission
  starts (command scripts, wrong-layer sources, native markers).
- `mission.builderCriteria` — required/advisory completion criteria on the
  reviewer-builder node; `mission.revisionTarget` adds a producer node and a
  revision edge back to it (builder → producer); `mission.maxRevisions` bounds
  the loop; `mission.postApprovalAgent` inserts an agent between Release
  Approval and delivery so its unfrozen artifacts trip the pair-compare gate.
- `autoApproveGates: false` — let gates resolve naturally (a `needs_human`
  gate times out fail-closed) instead of the runner auto-approving them.
- `env` — fixture-scoped environment (e.g.
  `CODEX_CORP_NEEDS_HUMAN_TIMEOUT_SECS: "3"` for the timeout mission).
- `expect.terminalReasonContains` — assert the run's `terminalReason` names a
  specific failure (offending module, pair-compare, `needs_human`).
- `expect.persistedVerificationAttempts` — assert ≥N persisted
  `failureClass:"verification"` attempt records on `node_attempts`.

```bash
# build the headless binary once (needs a cargo-capable + GTK-capable builder), then:
CODEX_CORP_HEADLESS_BIN=src-tauri/target/debug/codex-corp-headless node evals/runner.mjs
# or, where cargo is available:
npm run headless:build && npm run golden
# single fixture passthrough through the headless launcher:
npm run headless -- golden evals/golden/mission-revision-loop.json scripts/fake-codex-server.mjs
```

### CI and the build-vs-runtime GTK nuance

Headless missions run in CI via `.github/workflows/golden.yml` on an
`ubuntu-22.04` image. The **binary build** needs webkit2gtk dev packages
(`libwebkit2gtk-4.1-dev …`) because `codex-corp-headless` links the tauri/lib
crate; the **runtime** needs no display/GTK, so the same binary runs
`start_run` and MCP in a headless VM. Any mission regression fails the job.

### Result table (latest CI run)

| Fixture | Mode | Status | Run status | bundleHash | Verification | Checks |
|---|---|---|---|---|---|---|
| `architecture-wrong-layer-unanticipated` | skipped | skipped | — | — | — | classification-only |
| `architecture-wrong-layer` | skipped | skipped | — | — | — | classification-only |
| `capability-denial` | skipped | skipped | — | — | — | classification-only |
| `command-fail` | skipped | skipped | — | — | — | classification-only |
| `delivery-stale-hash` | skipped | skipped | — | — | — | classification-only |
| `missing-artifact` | skipped | skipped | — | — | — | classification-only |
| `mission-architecture-wrong-layer-v2` | mission | pass | failed | — | — | runStatus=ok bundleHash=ok verification=ok terminalReason=ok |
| `mission-capability-gate-times-out` | mission | pass | failed | — | — | runStatus=ok bundleHash=ok verification=ok terminalReason=ok |
| `mission-command-fail-required` | mission | pass | failed | — | — | runStatus=ok bundleHash=ok verification=ok terminalReason=ok |
| `mission-delivery-fail-closed` | mission | pass | failed | — | — | runStatus=ok bundleHash=ok verification=ok |
| `mission-delivery-stale-hash` | mission | pass | failed | — | — | runStatus=ok bundleHash=ok verification=ok terminalReason=ok |
| `mission-delivery-trusted` | mission | pass | completed | sha256:┈ | runtime | runStatus=ok bundleHash=ok verification=ok |
| `mission-revision-loop` | mission | pass | completed | sha256:┈ | runtime | runStatus=ok bundleHash=ok verification=ok persistedVerificationAttempts=ok |
| `quality-plateau-stop` | skipped | skipped | — | — | — | classification-only |
| `revision-loop-evidence-routing` | skipped | skipped | — | — | — | classification-only |
| `self-attestation-blocked` | skipped | skipped | — | — | — | classification-only |
| `spec-ambiguity-pause` | skipped | skipped | — | — | — | classification-only |
| `transient-failure-retry` | skipped | skipped | — | — | — | classification-only |

> **NOTE:** this table is regenerated by `evals/runner.mjs` after a cargo-capable
> run. The rows above are the committed expectation targets; the runner
> re-derives them on every invocation and fails the mission if any mission
> fixture regresses.
