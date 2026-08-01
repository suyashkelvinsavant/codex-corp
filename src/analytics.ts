/**
 * Verification-revision analytics parsing (P4).
 *
 * Mirrors the `analytics_verification_loops` Tauri command / MCP tool response:
 * a `nodes` array of per-node `{ nodeId, verificationRevisions, criterionIds }`
 * derived from `node_attempts` rows persisted by verification-driven revision
 * routing (`record_verification_revision`). Parsing is defensive (unknown/malformed
 * payloads degrade to an empty report, never throw).
 */

export type VerificationLoopReport = {
  nodeId: string;
  verificationRevisions: number;
  criterionIds: string[];
};

export type VerificationLoopsSummary = {
  total: number;
  byNode: VerificationLoopReport[];
};

/** Normalize a single MCP/command node record; null when unusable. */
export function parseVerificationLoopNode(
  value: unknown,
): VerificationLoopReport | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nodeId = typeof record.nodeId === "string" ? record.nodeId : null;
  if (!nodeId) return null;
  const revisions =
    typeof record.verificationRevisions === "number"
      ? record.verificationRevisions
      : typeof record.verificationRevisions === "string"
        ? Number(record.verificationRevisions)
        : 0;
  const criterionIds = Array.isArray(record.criterionIds)
    ? record.criterionIds.filter((id): id is string => typeof id === "string")
    : [];
  if (revisions <= 0) return null;
  return { nodeId, verificationRevisions: revisions, criterionIds };
}

/** Parse the command response into a report; malformed input → empty. */
export function parseVerificationLoops(
  value: unknown,
): VerificationLoopReport[] {
  if (!value || typeof value !== "object") return [];
  const nodes = (value as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map(parseVerificationLoopNode)
    .filter((report): report is VerificationLoopReport => report !== null);
}

/** Aggregate totals for the inspector chip. */
export function summarizeVerificationLoops(
  reports: VerificationLoopReport[],
): VerificationLoopsSummary {
  return {
    total: reports.reduce(
      (sum, report) => sum + report.verificationRevisions,
      0,
    ),
    byNode: reports,
  };
}
