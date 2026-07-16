/**
 * Per-specialist completion criteria: platform guarantees (evaluated) +
 * operator-editable criteria (prompt-injected + soft evaluation).
 */

export type CriterionKind =
  "structured_json" | "concise_summary" | "no_hidden_reasoning" | "custom";

export type CompletionCriterion = {
  id: string;
  label: string;
  kind: CriterionKind;
  enabled: boolean;
  /** Platform guarantees cannot be removed; may still be disabled by operator. */
  platform?: boolean;
  /** Extra instruction for custom / prompt injection. */
  instruction?: string;
  /** Required failures block/revise; advisory failures are evidence only. */
  enforcement: "required" | "advisory";
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
    merged.push({
      id: c.id,
      label: c.label || "Custom criterion",
      kind: c.kind === "custom" ? "custom" : "custom",
      enabled: c.enabled !== false,
      platform: false,
      instruction: c.instruction,
      enforcement: c.enforcement ?? "required",
    });
  }
  return merged;
}

export function makeCustomCriterion(label: string): CompletionCriterion {
  const clean = label.replace(/\s+/g, " ").trim() || "Custom criterion";
  return {
    id: `custom-${crypto.randomUUID()}`,
    label: clean,
    kind: "custom",
    enabled: true,
    platform: false,
    instruction: clean,
    enforcement: "required",
  };
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

const HIDDEN_REASONING_RE =
  /\b(chain[-\s]?of[-\s]?thought|internal monologue|hidden reasoning|reasoning_content|scratchpad:)\b/i;

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

  const summary = String(result.summary ?? "").trim();
  const status = String(result.status ?? "").trim();
  const data =
    result.data && typeof result.data === "object"
      ? result.data
      : result.structuredOutput && typeof result.structuredOutput === "object"
        ? result.structuredOutput
        : null;
  const blob = `${summary}\n${JSON.stringify(data ?? {})}`;

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
      const leaked = HIDDEN_REASONING_RE.test(blob);
      return {
        id: criterion.id,
        label: criterion.label,
        status: leaked ? "fail" : "pass",
        detail: leaked
          ? "Possible hidden-reasoning markers in summary/data"
          : "No hidden-reasoning markers detected",
        enforcement,
      };
    }
    case "custom":
    default: {
      const evidence = Array.isArray(data?.criteria)
        ? data.criteria.find(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              (entry as { id?: unknown }).id === criterion.id,
          )
        : undefined;
      const passed =
        evidence && typeof evidence === "object"
          ? (evidence as { passed?: unknown }).passed === true
          : false;
      return {
        id: criterion.id,
        label: criterion.label,
        status: passed ? "pass" : "fail",
        detail: passed
          ? String(
              (evidence as { evidence?: unknown }).evidence ??
                "Agent supplied evidence",
            )
          : "Missing explicit passing evidence in data.criteria",
        enforcement,
      };
    }
  }
}

export function requiredCriteriaFailed(evals: CriterionEvaluation[]): boolean {
  return evals.some(
    (evaluation) =>
      evaluation.enforcement === "required" && evaluation.status === "fail",
  );
}

export function evaluateCompletionCriteria(
  criteria: CompletionCriterion[] | undefined,
  result: AgentResultLike | null | undefined,
): CriterionEvaluation[] {
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
