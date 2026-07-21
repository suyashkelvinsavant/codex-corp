/**
 * Per-specialist completion criteria: platform guarantees (evaluated) +
 * operator-editable criteria (prompt-injected + soft evaluation).
 *
 * ## Host vs client evaluation
 *
 * Host-owned kinds (`command`, `artifact_exists`, `architecture_policy`) produce
 * `verification.results` at runtime. The TS layer must **not** invent pass/fail
 * for those kinds without host rows — they stay `pending` until results exist.
 * Lightweight client-side checks remain only for pure JSON/text kinds
 * (`structured_json`, `concise_summary`, `no_hidden_reasoning`) and advisory
 * `claim` evidence preview.
 */

export type CriterionKind =
  | "structured_json"
  | "concise_summary"
  | "no_hidden_reasoning"
  /** Self-attestation evidence only; never owns the required pass bit. */
  | "claim"
  /** @deprecated Prefer `claim`. Deserialized as `claim`. */
  | "custom"
  /** Host runs allowlisted command (npm_test, cargo_test, …). */
  | "command"
  /** Host checks materialized artifact presence. */
  | "artifact_exists"
  /** Host architecture policy (git-first). */
  | "architecture_policy";

/** Kinds whose pass/fail is owned by the Rust host (runtime `verification.results`). */
export const HOST_VERIFIER_KINDS = [
  "command",
  "artifact_exists",
  "architecture_policy",
] as const;

export type HostVerifierKind = (typeof HOST_VERIFIER_KINDS)[number];

export function isHostVerifierKind(
  kind: string | undefined | null,
): kind is HostVerifierKind {
  const normalized = normalizeCriterionKind(kind);
  return (HOST_VERIFIER_KINDS as readonly string[]).includes(normalized);
}

export const COMMAND_TEMPLATE_IDS = [
  "npm_test",
  "npm_run_build",
  "cargo_test",
  "cargo_check",
  "node_script",
] as const;

export type CompletionCriterion = {
  id: string;
  label: string;
  kind: CriterionKind;
  enabled: boolean;
  /** Platform guarantees cannot be removed; may still be disabled by operator. */
  platform?: boolean;
  /** Extra instruction for custom / prompt injection / node_script path. */
  instruction?: string;
  /** Required failures block/revise; advisory failures are evidence only. */
  enforcement: "required" | "advisory";
  /** command: allowlisted template id */
  templateId?: string;
  /** artifact_exists: expected name */
  artifactName?: string;
  /** artifact_exists: expected path fragment */
  artifactPath?: string;
  /** architecture_policy id */
  policyId?: string;
};

/** Runtime verification result row (prefer over local re-eval post-run). */
export type VerificationResultRow = {
  id: string;
  label?: string;
  kind?: string;
  passed: boolean;
  enforcement?: "required" | "advisory";
  detail?: string;
  /** Host method (kind or command:template / architecture_policy:id). */
  method?: string;
  source?: string;
};

export type CriterionEvalStatus = "pass" | "fail" | "pending" | "skipped";

export type CriterionEvaluation = {
  id: string;
  label: string;
  status: CriterionEvalStatus;
  detail: string;
  enforcement: "required" | "advisory";
};

/** Sample structured agent result for evaluation. */
export type AgentResultLike = {
  status?: string;
  summary?: string;
  data?: Record<string, unknown>;
  artifacts?: unknown[];
  structuredOutput?: Record<string, unknown>;
};

export const PLATFORM_CRITERION_IDS = [
  "structured_json",
  "concise_summary",
  "no_hidden_reasoning",
] as const;

export function defaultPlatformCriteria(): CompletionCriterion[] {
  return [
    {
      id: "structured_json",
      kind: "structured_json",
      label: "Return structured JSON output",
      enabled: true,
      platform: true,
      instruction:
        "Respond with status, summary, data, and artifacts in the required schema.",
      enforcement: "required",
    },
    {
      id: "concise_summary",
      kind: "concise_summary",
      label: "Include concise execution notes",
      enabled: true,
      platform: true,
      instruction: "Keep summary actionable and under ~500 words.",
      enforcement: "required",
    },
    {
      id: "no_hidden_reasoning",
      kind: "no_hidden_reasoning",
      label: "Never expose hidden reasoning",
      enabled: true,
      platform: true,
      instruction:
        "Do not dump chain-of-thought, internal monologue, or hidden scratchpads in summary/data.",
      enforcement: "required",
    },
  ];
}

/** Merge saved criteria with platform defaults (ensures platform rows always exist). */
export function ensureCompletionCriteria(
  saved: CompletionCriterion[] | undefined | null,
): CompletionCriterion[] {
  const platform = defaultPlatformCriteria();
  if (!saved?.length) return platform;

  const byId = new Map(saved.map((c) => [c.id, c]));
  const merged: CompletionCriterion[] = platform.map((p) => {
    const existing = byId.get(p.id);
    if (!existing) return p;
    return {
      ...p,
      enabled: true,
      enforcement: "required",
      // keep platform label/kind
    };
  });

  for (const c of saved) {
    if (
      c.platform ||
      PLATFORM_CRITERION_IDS.includes(
        c.id as (typeof PLATFORM_CRITERION_IDS)[number],
      )
    ) {
      continue;
    }
    if (merged.some((m) => m.id === c.id)) continue;
    const kind = normalizeCriterionKind(c.kind);
    const isClaim = kind === "claim";
    merged.push({
      id: c.id,
      label: c.label || "Custom criterion",
      // Preserve host verifier kinds; legacy `custom` → claim.
      kind,
      enabled: c.enabled !== false,
      platform: false,
      instruction: c.instruction,
      templateId: c.templateId,
      artifactName: c.artifactName,
      artifactPath: c.artifactPath,
      policyId: c.policyId,
      // Required claim is invalid as a pass gate — force advisory.
      // Host verifiers may stay required.
      enforcement: isClaim
        ? c.enforcement === "required"
          ? "advisory"
          : (c.enforcement ?? "advisory")
        : c.enforcement === "required"
          ? "required"
          : (c.enforcement ?? "advisory"),
    });
  }
  return merged;
}

export function makeCustomCriterion(label: string): CompletionCriterion {
  const clean = label.replace(/\s+/g, " ").trim() || "Custom criterion";
  return {
    id: `claim-${crypto.randomUUID()}`,
    label: clean,
    kind: "claim",
    enabled: true,
    platform: false,
    instruction: clean,
    // Claims cannot be required pass bits (plan invariant 2).
    enforcement: "advisory",
  };
}

/** Normalize legacy `custom` kind to `claim`. */
export function normalizeCriterionKind(
  kind: string | undefined | null,
): CriterionKind {
  if (kind === "custom" || kind === "claim") return "claim";
  if (
    kind === "structured_json" ||
    kind === "concise_summary" ||
    kind === "no_hidden_reasoning" ||
    kind === "command" ||
    kind === "artifact_exists" ||
    kind === "architecture_policy"
  ) {
    return kind;
  }
  return "claim";
}

/** Append enabled criteria into the specialist system prompt. */
export function appendCompletionCriteriaToPrompt(
  basePrompt: string,
  criteria: CompletionCriterion[] | undefined,
): string {
  const list = ensureCompletionCriteria(criteria).filter((c) => c.enabled);
  if (!list.length) return basePrompt;
  const block = [
    "",
    "## Completion criteria (must satisfy before finishing)",
    ...list.map((c) => {
      const extra =
        c.instruction?.trim() && c.instruction !== c.label
          ? ` — ${c.instruction.trim()}`
          : "";
      return `- ${c.label}${extra}`;
    }),
  ].join("\n");
  const base = (basePrompt ?? "").trimEnd();
  return base ? `${base}\n${block}` : block.trimStart();
}

const PRIVATE_REASONING_KEYS = new Set([
  "chain_of_thought",
  "hidden_reasoning",
  "internal_monologue",
  "reasoning_content",
  "scratchpad",
]);

const PRIVATE_REASONING_SECTION_RE =
  /^(?:chain[-\s]?of[-\s]?thought|hidden reasoning|internal monologue|reasoning_content|scratchpad)\s*:\s*\S/i;
const PRIVATE_REASONING_HEADING_RE =
  /^(?:chain[-\s]?of[-\s]?thought|hidden reasoning|internal monologue|reasoning_content|scratchpad)\s*:?\s*$/i;

function normalizedPrivateReasoningKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function privateReasoningSection(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((line, index) => {
    const cleaned = line.replace(/^\s*(?:#{1,6}|[-*])\s*/, "").trim();
    if (PRIVATE_REASONING_SECTION_RE.test(cleaned)) return true;
    if (!PRIVATE_REASONING_HEADING_RE.test(cleaned)) return false;
    return lines.slice(index + 1).some((next) => next.trim().length > 0);
  });
}

function hiddenReasoningViolation(
  value: unknown,
  path: string,
  depth = 0,
): string | null {
  if (depth > 32) return `${path} exceeds the private-reasoning scan depth`;
  if (typeof value === "string") {
    if (privateReasoningSection(value))
      return `private-reasoning section marker at ${path}`;
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return hiddenReasoningViolation(JSON.parse(trimmed), path, depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const violation = hiddenReasoningViolation(
        value[index],
        `${path}[${index}]`,
        depth + 1,
      );
      if (violation) return violation;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (PRIVATE_REASONING_KEYS.has(normalizedPrivateReasoningKey(key)))
        return `explicit private-reasoning field at ${childPath}`;
      const violation = hiddenReasoningViolation(child, childPath, depth + 1);
      if (violation) return violation;
    }
  }
  return null;
}

function evaluateOne(
  criterion: CompletionCriterion,
  result: AgentResultLike | null | undefined,
): CriterionEvaluation {
  const enforcement = criterion.platform ? "required" : criterion.enforcement;
  if (!criterion.enabled) {
    return {
      id: criterion.id,
      label: criterion.label,
      status: "skipped",
      detail: "Disabled by operator",
      enforcement,
    };
  }
  if (!result) {
    return {
      id: criterion.id,
      label: criterion.label,
      status: "pending",
      detail: "No run result yet",
      enforcement,
    };
  }

  // Host-owned kinds (HOST_VERIFIER_KINDS SSOT): never invent pass/fail
  // without verification.results. New host kinds added to the constant stay
  // pending without updating this switch.
  if (isHostVerifierKind(criterion.kind)) {
    return {
      id: criterion.id,
      label: criterion.label,
      status: "pending",
      detail:
        "Host-owned verifier — pending until runtime verification.results",
      enforcement,
    };
  }

  const summary = String(result.summary ?? "").trim();
  const status = String(result.status ?? "").trim();
  const data =
    result.data && typeof result.data === "object"
      ? result.data
      : result.structuredOutput && typeof result.structuredOutput === "object"
        ? result.structuredOutput
        : null;

  switch (criterion.kind) {
    case "structured_json": {
      const ok =
        !!status &&
        !!summary &&
        ["success", "failure", "needs_revision"].includes(status);
      return {
        id: criterion.id,
        label: criterion.label,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `status=${status}; summary present`
          : "Missing status and/or summary in structured result",
        enforcement,
      };
    }
    case "concise_summary": {
      if (!summary) {
        return {
          id: criterion.id,
          label: criterion.label,
          status: "fail",
          detail: "Empty summary",
          enforcement,
        };
      }
      const words = summary.split(/\s+/).filter(Boolean).length;
      const ok = words >= 3 && words <= 600;
      return {
        id: criterion.id,
        label: criterion.label,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${words} words`
          : words < 3
            ? "Summary too short"
            : "Summary exceeds concise limit (~600 words)",
        enforcement,
      };
    }
    case "no_hidden_reasoning": {
      const violation =
        hiddenReasoningViolation(summary, "summary") ??
        hiddenReasoningViolation(data ?? {}, "data");
      return {
        id: criterion.id,
        label: criterion.label,
        status: violation ? "fail" : "pass",
        detail:
          violation ??
          "No explicit private-reasoning fields or sections detected",
        enforcement,
      };
    }
    // Host kinds handled above via isHostVerifierKind (command / artifact / arch).
    case "claim":
    case "custom":
    default: {
      // Claim criteria never own the required pass bit. Producer `passed`
      // is evidence-only and is ignored for required gates.
      const evidence = Array.isArray(data?.criteria)
        ? data.criteria.find(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              (entry as { id?: unknown }).id === criterion.id,
          )
        : undefined;
      const claimText =
        evidence && typeof evidence === "object"
          ? String(
              (evidence as { evidence?: unknown }).evidence ??
                (evidence as { note?: unknown }).note ??
                "",
            ).trim()
          : "";
      const claimEnum =
        evidence && typeof evidence === "object"
          ? String((evidence as { claim?: unknown }).claim ?? "")
              .trim()
              .toLowerCase()
          : "";
      const passedFalse =
        evidence &&
        typeof evidence === "object" &&
        (evidence as { passed?: unknown }).passed === false;
      // Required claim is invalid: always fail closed for required enforcement.
      if (enforcement === "required") {
        return {
          id: criterion.id,
          label: criterion.label,
          status: "fail",
          detail:
            "Required claim criteria are invalid — use platform/command/artifact verifiers",
          enforcement,
        };
      }
      // Advisory: need evidence text; fail on not_satisfied/unknown or passed:false.
      // Still ignore passed:true as sole authority (empty evidence fails).
      const negativeClaim =
        claimEnum === "not_satisfied" || claimEnum === "unknown";
      const ok = !!claimText && !passedFalse && !negativeClaim;
      return {
        id: criterion.id,
        label: criterion.label,
        status: ok ? "pass" : "fail",
        detail: !claimText
          ? "No claim evidence in data.criteria (advisory only)"
          : ok
            ? claimText
            : `claim=${claimEnum || "unspecified"} (advisory evidence present but not satisfied)`,
        enforcement: "advisory",
      };
    }
  }
}

/**
 * Pull runtime verification rows from a node output payload.
 * Accepts either the RuntimeOutput `data` object or a full agent result shape.
 */
export function verificationResultsFromOutput(
  data: Record<string, unknown> | null | undefined,
): VerificationResultRow[] | null {
  if (!data || typeof data !== "object") return null;
  const dig = (obj: Record<string, unknown>): unknown => {
    const direct = obj.verification;
    if (direct && typeof direct === "object") {
      const results = (direct as { results?: unknown }).results;
      if (Array.isArray(results)) return results;
    }
    const nested = obj.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return dig(nested as Record<string, unknown>);
    }
    return null;
  };
  const raw = dig(data);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: VerificationResultRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    const enforcement =
      r.enforcement === "required" || r.enforcement === "advisory"
        ? r.enforcement
        : undefined;
    rows.push({
      id,
      label: r.label != null ? String(r.label) : undefined,
      kind: r.kind != null ? String(r.kind) : undefined,
      passed: Boolean(r.passed),
      enforcement,
      detail: r.detail != null ? String(r.detail) : undefined,
      method: r.method != null ? String(r.method) : undefined,
      source: r.source != null ? String(r.source) : undefined,
    });
  }
  return rows.length ? rows : null;
}

/** Operator-editable verifier kinds (inspector kind select). */
export const OPERATOR_VERIFIER_KINDS = [
  "claim",
  "command",
  "artifact_exists",
  "architecture_policy",
] as const;

export type OperatorVerifierKind = (typeof OPERATOR_VERIFIER_KINDS)[number];

export function requiredCriteriaFailed(evals: CriterionEvaluation[]): boolean {
  return evals.some(
    (evaluation) =>
      evaluation.enforcement === "required" && evaluation.status === "fail",
  );
}

/**
 * Prefer runtime `verification.results` when present (plan III.4 / Q2).
 * Local re-eval only for pre-run preview or when no verification block exists.
 */
export function evaluateFromVerification(
  verificationResults: VerificationResultRow[] | undefined | null,
  criteria?: CompletionCriterion[],
): CriterionEvaluation[] | null {
  if (!verificationResults?.length) return null;
  const byId = new Map(verificationResults.map((r) => [r.id, r]));
  const list = ensureCompletionCriteria(criteria);
  return list.map((c) => {
    const row = byId.get(c.id);
    const enforcement = c.platform ? "required" : c.enforcement;
    if (!row) {
      return {
        id: c.id,
        label: c.label,
        status: "pending" as const,
        detail: "No runtime verification row",
        enforcement,
      };
    }
    const detailParts = [
      row.detail || (row.passed ? "Runtime verified" : "Runtime failed"),
      row.method ? `method=${row.method}` : "",
    ].filter(Boolean);
    return {
      id: c.id,
      label: row.label || c.label,
      status: row.passed ? ("pass" as const) : ("fail" as const),
      detail: detailParts.join(" · "),
      enforcement: row.enforcement ?? enforcement,
    };
  });
}

export function evaluateCompletionCriteria(
  criteria: CompletionCriterion[] | undefined,
  result: AgentResultLike | null | undefined,
  verificationResults?: VerificationResultRow[] | null,
): CriterionEvaluation[] {
  // Prefer runtime verification.results (SSOT for host kinds + full post-run view).
  const fromRuntime = evaluateFromVerification(verificationResults, criteria);
  if (fromRuntime) return fromRuntime;
  // Without host rows: host kinds stay pending; JSON/text/claim may preview locally.
  return ensureCompletionCriteria(criteria).map((c) => evaluateOne(c, result));
}

export function criteriaEvalSummary(evals: CriterionEvaluation[]): {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
} {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;
  for (const e of evals) {
    if (e.status === "pass") passed += 1;
    else if (e.status === "fail") failed += 1;
    else if (e.status === "pending") pending += 1;
    else skipped += 1;
  }
  return { passed, failed, pending, skipped };
}
