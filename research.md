# Codex Corp: research and product strategy

**Research date:** 17 July 2026  
**Scope:** Product and architecture research only. No application code was changed.  
**Decision horizon:** Hackathon MVP first, revenue validation immediately after, production SaaS second. Video generation is intentionally future scope.

## Executive answer

Yes, I am aligned with the project goal, with one important sharpening:

> Codex Corp should not be judged by whether several agents can finish a graph. It should be judged by whether a customer receives an accepted, production-usable outcome faster and at lower total cost than hiring or coordinating the equivalent team.

The hackathon goal is to demonstrate a credible **AI company operating system**: a customer provides an authorized mission, specialized agents execute within explicit boundaries, the system verifies the real artifacts, a human approves risky decisions, and a delivery bundle contains enough evidence to trust and use the result. The commercial goal is to turn one repeatable version of that loop into paid outcomes as soon as possible.

The current product has a solid foundation: Rust owns workflow execution, scheduling, retries, revisions, approvals, checkpoints, persistence, and terminal state; the graph editor validates workflow topology; output is structured; and local tests are healthy. The largest risk is not orchestration. It is **false completion**. A custom completion criterion currently passes when the producing model returns its criterion ID with `passed: true` and any evidence string. The delivery stage checks approval and packages outputs, but it does not independently prove that declared files exist, compile, pass tests, match the requested architecture, or satisfy visual constraints.

That explains the cron-node incident. The agent could produce something that appeared functionally correct while violating the intended ownership boundary—runtime behavior belonged in Rust, but the first implementation placed it in TypeScript. A better prompt may reduce this failure, but only an executable architecture rule can prevent it reliably.

The highest-leverage strategy is therefore:

1. Make every claimed outcome carry machine-verifiable evidence.
2. Enforce architecture, permissions, and artifact contracts outside the model.
3. Use model judges only for qualities that deterministic checks cannot assess.
4. Sell one narrow, measurable outcome before building a general multi-tenant SaaS.
5. Optimize cost per **accepted outcome**, not cost per model call or workflow run.

My recommended first commercial wedge is a concierge-assisted **production change delivery service for small software teams and technical founders**: a scoped bug fix, feature, or landing-page implementation, delivered with tests, build evidence, screenshots where relevant, a change manifest, and a human-approved release package. This fits the product's strongest present capabilities and offers clearer acceptance criteria than open-ended “build my SaaS” requests. Image generation can support that wedge through brand assets, illustrations, and marketing variants. Video should enter later through the same artifact-and-evidence contract.

## What the product is today

The repository describes Codex Corp as an “agent OS” for multi-specialist software companies, powered by live Codex. Its intended execution path is:

`mission brief → specialists → reviewer → human approval → delivery`

The implementation already contains several production-minded choices:

- The native runtime in [`workflow_runtime.rs`](src-tauri/src/workflow_runtime.rs) controls scheduling, branching, retries, revision routing, approval waits, checkpoints, cancellation, persistence, and output commits.
- The connector in [`lib.rs`](src-tauri/src/lib.rs) uses the Codex app-server protocol instead of a simulated model runtime.
- [`graph.ts`](src/graph.ts) checks graph validity, reachability, cycles, bounded revision paths, specialist configuration, cron syntax, condition sources, and JSON schema shape before execution.
- [`agent-output.schema.json`](src/shared/agent-output.schema.json) requires structured status, summary, criteria, data, and artifact declarations.
- Runs and business records are stored locally in SQLite; the application currently has no remote analytics service.
- Human approval is durable and can survive a process interruption.
- Node output and artifact records are committed atomically, and revised artifacts replace stale ones.
- The runtime narrows upstream context to relevant lineage instead of indiscriminately exposing unrelated branches.

### Validation performed for this report

On the working tree reviewed on 17 July 2026:

- `npm test`: **30 test files, 132 tests passed**.
- `cargo test --manifest-path src-tauri/Cargo.toml`: **33 tests passed**.
- `npm run build`: **passed**; Vite reported one JavaScript chunk above 500 kB and a 3.1 MB sprite asset, which is a performance warning rather than a build failure.

These results show meaningful engineering discipline. They do not establish end-to-end customer outcome quality because the current suite primarily validates the harness itself, not a corpus of real missions and delivered artifacts.

## The central product gap: completion is asserted, not demonstrated

The key current behavior appears in both [`completion-criteria.ts`](src/completion-criteria.ts) and the Rust `criterion_failed` path in [`workflow_runtime.rs`](src-tauri/src/workflow_runtime.rs): platform criteria validate structured status and summary hygiene, while a custom criterion is accepted when the model returns the matching criterion ID with `passed === true`. The evidence is text supplied by the same model.

This creates a principal–agent problem. The producer is also the first grader of its own work and is rewarded for reaching a terminal success state. Even a well-intentioned model may:

- interpret ambiguous acceptance criteria in the easiest possible way;
- report a command as successful without preserving its output;
- implement equivalent-looking behavior in the wrong layer;
- create artifact descriptions without durable files;
- optimize for reviewer wording instead of user value;
- stop after a superficial happy-path check;
- repeatedly revise prose while leaving the underlying defect untouched.

Current prompts tell the model not to claim a pass without evidence. This is useful behavioral guidance, but it is not enforcement. Agent research supports a mixed evaluation design: deterministic graders for things that can be measured, multiple trials for stochastic behavior, complete traces for diagnosis, and human-calibrated model judges for subjective qualities. Anthropic's agent-evaluation guidance explicitly recommends combining grader types and calibrating subjective rubrics against expert judgment; OpenAI supports string, similarity, Python, model, label, and composite graders in its Evals platform ([Anthropic agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [OpenAI graders](https://platform.openai.com/docs/api-reference/graders)).

The relevant lesson is not to chase a leaderboard. METR defines agent capability as a probability of completing tasks at different human-duration horizons and notes that success depends on the model, task, and exact agent setup. A single pass is not a reliability guarantee ([METR time horizons](https://metr.org/time-horizons/)). Fresh-task research also finds that static software benchmarks can overstate performance through contamination, reinforcing the need for private, continuously refreshed product evals ([SWE-rebench](https://arxiv.org/abs/2505.20411)).

## Recommended product principle: evidence before status

Every specialist should produce two separate things:

1. **The work product**: files, code, images, documents, decisions, or links.
2. **A claim manifest**: what changed, which requirement each change satisfies, and where the verifier can find evidence.

The runtime—not the producer—should determine the final pass state. A criterion should have an explicit verifier type:

| Criterion type | Appropriate verifier | Example |
|---|---|---|
| Exact structure | Schema/parser | Required fields, file types, dimensions |
| Code behavior | Command/test runner | Unit tests, integration tests, typecheck |
| Architecture | Policy/static analysis | Scheduler logic must live under `src-tauri`; UI may only configure it |
| Security | Scanner plus targeted tests | Secret scan, dependency audit, permission checks |
| Web experience | Browser automation | Load page, perform flow, capture screenshot and console errors |
| Visual specification | File checks plus vision rubric | Resolution, alpha, layout, brand/reference match |
| Research quality | Source and claim checks plus judge | Citation validity, coverage, source authority |
| Business decision | Human approval | Pricing, publication, payment, destructive or external action |

The verifier must return its own signed result record containing the criterion ID, command or method, exit status, captured output digest, artifact digest, timestamp, environment, and verifier version. The model may explain evidence, but it must not set the authoritative pass bit.

### A fail-closed delivery contract

The Output node should release a bundle only when all required conditions are true:

- every required artifact resolves to a real file or durable external object;
- each artifact hash matches the version evaluated;
- every mandatory deterministic check passes;
- subjective checks meet their threshold and identify the judge/model version;
- no unresolved critical reviewer finding remains;
- the human approval, when required, applies to the same artifact hashes;
- the run is within its cost, time, and retry policy;
- the bundle exposes residual risks and waived checks rather than hiding them.

This turns a delivery bundle from a collection of agent statements into an auditable release candidate.

## Preventing shortcuts like the TypeScript cron implementation

The cron incident is best treated as a missing invariant, not merely a prompt failure. Establish an explicit architecture ownership map:

| Concern | Authoritative layer | Allowed elsewhere |
|---|---|---|
| Scheduling, durable state, retries, cancellation, approvals | Rust/Tauri runtime | UI may configure and display state |
| Workflow graph editing and visualization | TypeScript/React | Rust validates executable form again |
| Secrets, filesystem authority, process execution | Native boundary | UI requests capability; it does not implement authority |
| Presentation-only validation | TypeScript | Native runtime must not depend on it for correctness |
| Shared contracts | Generated/schema-backed definitions | Hand-written duplicates require parity tests |

Then enforce this map in four places:

1. **Repository guidance:** keep a concise architecture section in `AGENTS.md`, close to the relevant code. Codex automatically discovers layered `AGENTS.md` guidance, but OpenAI also recommends pairing it with linters, type checkers, and hooks rather than relying on prose alone ([Codex AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)).
2. **Task contract:** the Architect produces an approved file plan and ownership rationale before implementation. The Builder is not authorized to move behavior across layers without an explicit revision.
3. **Mechanical policy:** a verifier examines the diff/AST/dependency graph for forbidden ownership changes. For cron, it would require native scheduling behavior and native tests, while allowing TypeScript only for syntax preview and editor UX.
4. **Independent review:** the reviewer receives the mission, architecture policy, diff, and test evidence—not the producer's confidence—and must cite file-level findings.

Graphify is already installed in this repository and can help scope architecture relationships, but its output should inform a deterministic policy rather than becoming the policy itself.

## Codex prompt integration: preserve the model's native harness

This is a high-priority technical issue for GPT-5.6-era Codex behavior.

The generated app-server protocol exposes both `baseInstructions` and `developerInstructions` in [`ThreadStartParams.ts`](src/generated/codex-app-server/v2/ThreadStartParams.ts). The current connector sends the complete specialist system prompt through `baseInstructions` in several `thread/start` paths in [`lib.rs`](src-tauri/src/lib.rs), while it does not send `developerInstructions`.

That matters because `baseInstructions` is a replacement surface. Using it for a specialist role can replace Codex's model-specific base prompt—the part optimized for tool use, persistence, safety, editing, and communication. The safer design is:

- leave `baseInstructions` unset unless Codex Corp intentionally owns and regression-tests a complete base harness for a pinned model snapshot;
- put company, role, workflow, artifact, and completion instructions in `developerInstructions`;
- keep the mission and changing upstream data in the user turn;
- use repository `AGENTS.md` for durable architecture/build/test rules;
- use skills for reusable task procedures;
- pin the model/app-server compatibility range and run evals before changing either.

Codex also exposes additive `developer_instructions` in configuration and a replacement `model_instructions_file`. The former is appropriate for additive behavior; the latter should be treated as an advanced full-replacement mechanism. The product should label these semantics clearly if it exposes them to users.

This layering minimizes prompt conflict and allows model improvements to arrive through the native Codex harness. It also makes prompts smaller and more cacheable.

## The production-quality harness to build

### 1. Typed work orders and typed handoffs

Replace generic payload strings as the primary interface with versioned contracts per role and artifact type. A work order should include:

- mission ID and immutable acceptance-criteria IDs;
- authorized workspace and capability set;
- role responsibility and explicit non-responsibilities;
- inputs by reference and digest, not duplicated full text;
- expected artifacts and verifier plan;
- architecture constraints;
- budget, deadline, retry, and escalation policy;
- definition of blocked versus failed versus complete.

A handoff should declare artifact references, requirement coverage, commands actually run, unresolved risks, and requested downstream actions. Free-form summaries can remain for humans, but orchestration should depend on typed fields.

### 2. Capability enforcement, not tool-name hints

The runtime currently infers write permission partly by checking whether a configured tool label contains “write”; connector tool selections are advisory while the Codex sandbox remains authoritative. This is too indirect for a commercial control plane.

Define explicit capabilities such as `workspace.read`, `workspace.write`, `shell.test`, `network.domain`, `git.commit`, `external.publish`, and `billing.charge`. Resolve them to a sandbox/approval policy at runtime. Unknown capabilities must fail closed. Log the granted set with every attempt. High-impact capabilities require a human or policy approval tied to the exact operation.

### 3. Artifact registry and provenance ledger

Create one authoritative record for each artifact:

- content hash, media type, size, location, and schema version;
- producing run/node/attempt/model/prompt version;
- source input hashes;
- verifier results and reviewer findings;
- approval status and delivery history;
- supersession relationship after revision.

This eliminates ambiguity about whether a review applied to the current file. It also enables caching and avoids repeatedly sending large upstream content.

### 4. Layered evaluation

Use the cheapest reliable evaluator first:

1. schema and file integrity;
2. deterministic commands and static policies;
3. focused domain tools such as browser tests or image metadata inspection;
4. independent model review for ambiguity and qualitative judgment;
5. human approval for high-impact or taste-sensitive release decisions.

Do not ask an expensive model to judge whether `cargo test` passed; execute `cargo test`. Do not use a pixel check to judge brand personality; use a calibrated vision rubric and human review during early pilots.

### 5. Failure taxonomy and strategy-aware recovery

Blindly rerunning the same prompt wastes time and tokens. Classify failures:

- **Transient:** provider timeout, rate limit, temporary tool failure → backoff and retry.
- **Contract:** invalid JSON/schema/missing artifact → focused repair turn.
- **Verification:** test or policy failed → send exact failing evidence to the producer.
- **Capability:** permission or unavailable tool → request authorization or route to a capable node.
- **Specification:** acceptance criteria conflict or are incomplete → pause for human clarification.
- **Quality plateau:** repeated failure with no changed evidence → change model/strategy or stop.

Retries should require a change hypothesis. Stop when the same failure fingerprint repeats, when no relevant artifact changed, or when the marginal expected value falls below the remaining budget.

### 6. Traceability without exposing hidden reasoning

Store observable traces: prompts/instruction versions, tool calls, tool outputs, file diffs, validator results, timing, tokens, retries, approvals, and state transitions. Do not require or display private chain-of-thought. The debugging unit should be “claim → action → environment result,” which is both sufficient and safer.

## Code, image, and future video quality

### Code delivery

For code missions, require a change manifest and select checks from repository evidence:

- clean application of the patch to the expected base revision;
- format, lint, typecheck, unit, integration, and end-to-end checks where configured;
- tests added or a documented reason why none are appropriate;
- architecture ownership policy;
- dependency and secret scan;
- browser screenshots and console/network error capture for UI changes;
- diff-size and unrelated-change checks;
- rollback or recovery note for risky state changes.

The reviewer should inspect failures and untested paths, not merely re-summarize the implementation.

### Image generation

Treat an image as a versioned binary artifact rather than an embedded model claim. Verify:

- file decodes, expected format, dimensions, color mode, transparency, and size limits;
- requested count and variants exist;
- no accidental text corruption when exact text matters;
- reference/brand consistency via a vision rubric;
- prompt, model, seed/options when available, and source-image rights/provenance;
- moderation and human release approval for customer-facing assets during the MVP.

Use a two-stage loop: generate inexpensive drafts/contact sheets, select candidates, then spend quality budget only on finalists. The latest OpenAI models support image input, while image generation is available as a tool; model routing should therefore separate visual inspection from image synthesis ([OpenAI model catalog](https://developers.openai.com/api/docs/models)).

### Future video generation

Do not add a video node in the hackathon MVP. First make the artifact registry support large, asynchronous, multi-part media. A later video verifier can add duration, codec, dimensions, frame sampling, audio checks, continuity, prompt/reference adherence, safety, and human approval. The workflow engine should wait on an external job reference rather than hold an expensive agent turn open.

## Minimal-cost architecture

Cost must be measured as total cost per accepted customer outcome:

`model tokens + tool/API fees + compute + storage + retries + human intervention + support/rework`

Optimizing only token price can increase total cost if a weaker model creates more retries or human repair.

Recommended controls:

- Route complex architecture/build/review work to GPT-5.6 Sol only where its expected quality gain is valuable; use Terra for balanced work and Luna or deterministic code for high-volume simple work. OpenAI currently positions Sol for complex work, Terra for balance, and Luna for cost-sensitive volume ([OpenAI models](https://developers.openai.com/api/docs/models)).
- Keep stable instructions and schemas at the beginning of prompts. Prompt caching reuses exact prefixes; OpenAI reports cache writes and reads separately. For GPT-5.6, cached input is materially cheaper than uncached input, though cache writes have a premium, so measure reuse rather than assuming savings ([prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), [GPT-5.6 Sol pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol)).
- Pass artifact references, targeted excerpts, diffs, and summaries rather than serializing every upstream output into each turn.
- Use hashes to skip unchanged validators and reviews.
- Run independent deterministic checks in parallel.
- Set per-node and per-mission token, wall-clock, retry, and dollar ceilings.
- Use asynchronous Batch processing only for non-urgent, independent evaluation or enrichment work; do not place interactive customer delivery on its completion window ([OpenAI Batch guide](https://developers.openai.com/api/docs/guides/batch)).
- Record model snapshot and prompt version so regressions can be reproduced.
- Build a model-routing eval from actual missions; never route solely by a generic benchmark score.

## Revenue-first product strategy

### Do not launch as “a platform for any automated company”

That positioning is broad, hard to trust, hard to price, and impossible to evaluate consistently. The current desktop product also lacks the identity, tenancy, billing, hosted execution, secrets management, remote artifact storage, audit controls, and support operations expected of self-serve SaaS.

The fastest path to validation is a **concierge MVP** using the existing local-first harness behind a narrow promise. The customer buys an outcome; the founder operates or supervises the workflow. Manual invoicing and manual onboarding are acceptable until repeat demand is proven.

### Recommended initial offer

**“Production-ready small software change, delivered with evidence.”**

Example scope:

- one well-bounded bug fix, feature slice, migration, or landing-page implementation;
- existing repository with runnable validation commands;
- agreed acceptance criteria and excluded scope before the run;
- delivery as a patch/branch/PR or reviewable bundle;
- test/build evidence, change manifest, screenshots for UI, known risks, and one revision;
- human release decision; no autonomous deployment to production in the initial offer.

Why this wedge:

- It matches the code-oriented runtime and review loop already implemented.
- Acceptance is observable and customer value is immediate.
- Existing tests, repositories, and browser flows provide ground truth.
- Failures become reusable eval cases.
- It supports image generation without making subjective creative quality the whole sale.
- Fixed scope enables pricing and margin measurement.

Start with 5–10 design partners from a consistent profile: small technical teams with backlogs of bounded work and working test environments. Charge from the first or second pilot. A discounted paid pilot provides stronger evidence than free usage.

### What the hackathon demo should prove

The most compelling demonstration is not the largest graph. Use one mission with an intentionally tempting shortcut:

1. An Architect creates a file and verification plan.
2. A Builder produces the change.
3. A deterministic policy catches a wrong-layer implementation or missing test.
4. The runtime routes exact evidence into a revision.
5. Tests and browser checks pass on the revised artifact.
6. Human approval releases a hash-bound delivery bundle.
7. The dashboard shows elapsed time, tokens, estimated cost, retries, intervention, and evidence.

This directly demonstrates why Codex Corp is more trustworthy than a chat wrapper or an attractive workflow canvas.

## What is missing for a true SaaS

These are real gaps, but most should follow demand validation rather than precede it:

| Capability | Current indication | Timing |
|---|---|---|
| Customer identity and organizations | No product auth/tenant model found | After paid concierge proof |
| Tenant isolation | Local desktop workspace and SQLite | Before hosted multi-customer runs |
| Billing and entitlements | Manual local finance records, no billing integration | Manual first; automate after pricing is stable |
| Hosted durable execution | Native local runtime | After local outcome reliability is measured |
| Secrets and connector governance | Codex/connector auth is authoritative, node choices advisory | Before customer-connected external actions |
| Remote artifact storage and retention | Local workspaces/SQLite | Before hosted delivery |
| Audit and observability | Local run records, no remote telemetry | Add consent-based operational telemetry for hosted beta |
| Customer portal and support | Not present | Thin portal for beta; support remains high-touch |
| Security/privacy/compliance controls | Local-first reduces exposure but is not a hosted control program | Threat model before hosted beta; formal programs later |
| Deployment/update reliability | Desktop build exists | Signed repeatable releases before public distribution |

Do not interpret this table as a recommendation to build every row now. The sequence is: prove accepted outcomes, prove willingness to pay, prove positive unit economics, then productize the repeated operating steps.

## KPI framework

The north-star event is an **accepted production outcome**, not a successful node, completed run, or reviewer score.

### Primary KPIs

1. **Paid Outcome Acceptance Rate**  
   Paid jobs accepted without founder repair ÷ paid jobs delivered. Measure acceptance within a fixed window, such as seven days.

2. **Gross Margin per Accepted Outcome**  
   `(revenue − model/tool/compute/storage costs − valued human intervention − refunds/rework) ÷ revenue` for accepted jobs.

3. **Median Time to Accepted Outcome**  
   Time from agreed work order to customer acceptance, excluding time explicitly waiting on the customer.

### Leading indicators

- first-pass deterministic verification rate;
- percentage of criteria with independent verifiers;
- human intervention minutes per accepted outcome;
- retries and repeated-failure fingerprints per job;
- tokens and model cost per accepted outcome;
- artifact-review cache hit rate;
- percentage delivered within promised service level;
- customer revision requests by failure category.

### Guardrails

- escaped defect/reopen/rollback rate within 14 or 30 days;
- critical security or privacy incidents;
- unauthorized external actions;
- customer-reported scope violations;
- artifacts released without complete evidence;
- satisfaction measured separately from technical acceptance.

### Provisional pilot targets

These are hypotheses to replace after the first baseline, not industry benchmarks:

- 5–10 paid design partners in one customer profile;
- at least 70% of bounded jobs accepted without founder code repair by the end of the pilot;
- median human intervention below 30 minutes per accepted bounded job;
- zero critical escaped defects or unauthorized actions;
- positive contribution margin, with a path toward at least 50% as repeated work and caching improve;
- 100% of released bundles tied to independently recorded evidence.

Report distributions and failure categories, not just averages. Run several trials on the private golden suite because agent behavior is stochastic.

## Prioritized plan

### P0 — make success trustworthy (hackathon focus)

1. Correct the Codex instruction layering: preserve native base instructions and use developer instructions for specialist behavior.
2. Introduce verifier-owned criterion states; stop accepting producer self-attestation as authoritative.
3. Add an artifact manifest with content hashes and versioned evidence records.
4. Add one architecture policy that catches the cron-style wrong-layer shortcut.
5. Make delivery fail closed when required artifacts or evidence are missing or stale.
6. Add failure fingerprints and stop/replan rules for repeated retries.
7. Create a private golden suite of 10–20 small missions, including known past failures.

### P1 — prove somebody pays (immediately after the demo)

1. Choose the bounded software-change offer and one target customer profile.
2. Create a strict intake/work-order template and a scope rejection checklist.
3. Recruit design partners and charge a fixed pilot price; invoice manually.
4. Measure acceptance, intervention time, cost, elapsed time, and escaped defects for every job.
5. Add failures from live jobs to the golden suite after removing customer-sensitive data.
6. Publish evidence-rich case studies only with customer permission.

### P2 — productize repeated operations

1. Build account, organization, entitlement, and tenant boundaries.
2. Move execution to an isolated hosted worker/queue architecture while preserving local execution as an option.
3. Add billing, budgets, secrets, remote artifacts, audit logs, and customer-facing run status.
4. Add operational telemetry with clear consent and retention controls.
5. Automate onboarding only after the concierge process stabilizes.

### P3 — expand outcome types

1. Add evidence-backed image workflows and calibrated visual evaluation.
2. Add additional software templates only when their acceptance tests are reusable.
3. Add asynchronous video generation after the media artifact contract, storage, and review system are proven.

## Suggested 14-day execution sequence

| Days | Deliverable | Exit evidence |
|---|---|---|
| 1–2 | Define one offer, customer profile, work-order schema, and acceptance vocabulary | Three realistic example work orders can be accepted/rejected consistently |
| 3–5 | Verifier-owned criteria and artifact/evidence record design | A producer cannot pass a criterion by setting a boolean |
| 6–7 | Architecture ownership policy and cron regression case | Wrong-layer implementation fails; correct native implementation passes |
| 8–9 | Hash-bound fail-closed delivery and targeted revision evidence | Changed artifacts invalidate earlier review/approval |
| 10–11 | Golden task runner and cost/outcome metrics | Repeatable multi-trial report across at least 10 tasks |
| 12 | Instruction-layer migration eval | Native-base plus developer-instruction configuration beats or matches current setup without regressions |
| 13 | End-to-end demo rehearsal | One adversarial mission completes with observable catch-and-repair loop |
| 14 | Begin paid pilot outreach | Named prospects, fixed offer, price, intake link/process, and delivery SLA |

The exact implementation duration will depend on how much of the current uncommitted work is retained. The exit evidence matters more than the calendar.

## Decisions to avoid

- Do not add more specialist roles until existing roles have independent outcome evidence.
- Do not treat a reviewer model as an objective verifier.
- Do not advertise autonomous production deployment in the first paid offer.
- Do not build video generation during this MVP.
- Do not build full multi-tenant infrastructure before paid demand is demonstrated.
- Do not optimize prompts without a private regression suite.
- Do not replace Codex base instructions casually or across moving model aliases without compatibility evals.
- Do not report “workflow completion rate” as customer success.
- Do not hide retries, human repair, or waived checks when calculating margin.

## Market position

The durable differentiator should be:

> **Codex Corp turns agent work into verified, releasable outcomes with evidence, budgets, and human control.**

Workflow canvases, multi-agent role labels, and prompt libraries are reproducible features. An accumulated system of typed work orders, architecture policies, private failure cases, calibrated graders, artifact provenance, and real unit-economics data is harder to copy and improves with every paid job.

The product wins if it becomes the harness that makes capable models dependable in a customer's actual environment. It loses if it becomes another interface that makes model activity look like company progress.

## Final recommendation

Keep the existing Rust execution core and local-first strengths. Pause breadth. Make the next milestone a single evidence-backed software delivery workflow in which the system demonstrably catches a shortcut, routes a focused repair, and releases only the verified artifact. Then sell that bounded outcome through paid, high-touch pilots.

The immediate product hierarchy should be:

1. **Truth:** independently prove what happened.
2. **Quality:** verify the artifact against the customer's real environment.
3. **Control:** constrain capabilities, cost, retries, and release authority.
4. **Economics:** measure margin and time per accepted outcome.
5. **Scale:** automate tenancy, billing, and hosting only after the loop sells.
6. **Breadth:** add image and later video workflows through the same evidence contract.

That sequence addresses the exact failure mode described in the cron example while giving the hackathon a clear story and the business a realistic path to revenue.

## Sources and research notes

### Repository evidence

- [`README.md`](README.md) — product framing, architecture, storage, templates, and local-first behavior.
- [`workflow_runtime.rs`](src-tauri/src/workflow_runtime.rs) — native orchestration, criteria, tool policy, revisions, scheduling, approval, checkpoints, and output behavior.
- [`lib.rs`](src-tauri/src/lib.rs) — Codex app-server connector and instruction mapping.
- [`completion-criteria.ts`](src/completion-criteria.ts) — renderer-side completion evaluation.
- [`agent-output.schema.json`](src/shared/agent-output.schema.json) — structured agent output contract.
- [`graph.ts`](src/graph.ts) — graph validation and topology rules.
- [`specialist-defaults.ts`](src/specialist-defaults.ts) — default specialist prompts and weak-prompt detection.
- [`business_data.rs`](src-tauri/src/business_data.rs) and [`dashboard-finance.ts`](src/dashboard-finance.ts) — local manual finance and token-burn views.
- Generated [`ThreadStartParams.ts`](src/generated/codex-app-server/v2/ThreadStartParams.ts) — app-server instruction fields.

### External primary and authoritative sources

- [OpenAI model catalog](https://developers.openai.com/api/docs/models) and [GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) — current model positioning, features, and pricing.
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) — exact-prefix reuse, cache measurement, and GPT-5.6 cache-write behavior.
- [OpenAI Batch API](https://developers.openai.com/api/docs/guides/batch) — asynchronous batch processing.
- [OpenAI Graders API](https://platform.openai.com/docs/api-reference/graders) and [Evals API](https://platform.openai.com/docs/api-reference/evals) — deterministic, code, model, and composite evaluation mechanisms.
- [Codex AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md) — layered repository instructions and enforcement guidance.
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — multi-trial evaluation, trace analysis, grader combinations, and human calibration.
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — ground truth from tool results, stopping conditions, and adding complexity only when justified.
- [METR: Task-completion time horizons](https://metr.org/time-horizons/) — reliability framing for long-horizon agent tasks.
- [SWE-rebench paper](https://arxiv.org/abs/2505.20411) — fresh software tasks and contamination-resistant evaluation.

### Method and limitations

This report used the repository knowledge graph for architecture discovery, direct source inspection for critical claims, local tests/builds for current validation status, current official OpenAI documentation for Codex/model behavior, and primary research for agent-evaluation conclusions. Business targets are explicitly marked as provisional because the repository contains no customer interviews, paid conversion history, or production cohort data. The report therefore recommends a commercial hypothesis and measurement plan rather than claiming proven demand.
