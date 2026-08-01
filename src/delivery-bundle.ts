/**
 * Delivery-bundle assembly. Runtime live shape is SSOT for
 * `codex-corp.delivery.v3` (see workflow_runtime delivery node).
 * This TS builder is the preview surface (`mode: "preview"`) and must share
 * the same pair-compare / residual / safety field names as live.
 */

import type { Artifact } from "./model";

export type DeliveryArtifactRef = {
  artifactKey: string;
  contentHash: string;
  sourceNodeId: string;
  name: string;
  hostOrdinal: number;
};

/** Runtime verification.results row (SSOT — producer can never own the pass bit). */
export type VerificationRow = {
  id: string;
  passed: boolean;
  kind?: string;
  enforcement?: string;
  detail?: string;
  method?: string;
  source?: string;
};

/**
 * Fail-closed preview status. `success` is only claimed when runtime
 * verification rows back the run; rows without runtime backing are `pending`
 * and never `pass`; any contradiction is `failed`.
 */
export type DeliveryPreviewStatus = "success" | "failed" | "pending";

export type DeliveryBundle = {
  schemaVersion: "codex-corp.delivery.v3" | string;
  /** Runtime emits "live"; this builder emits "preview". */
  mode: "live" | "preview";
  status: string;
  review: {
    outcome: string;
    summary?: string;
    revisionCount?: number;
  };
  specialistHandoffs: Array<{
    nodeId: string;
    role: string;
    label: string;
    summary: string;
    data: Record<string, unknown>;
    artifactNames: string[];
  }>;
  /** Frozen approval snapshot (pair-compare SSOT). */
  approvedArtifacts: DeliveryArtifactRef[];
  liveArtifactRefs: DeliveryArtifactRef[];
  verificationSummary?: unknown;
  residualRisks: string[];
  bundleHash?: string;
  safety: {
    /** Runtime SSOT field name (not `approvals`). */
    approval: "explicit-human";
    chainOfThought: "not-exposed";
    permissions?: "node-scoped";
    passBitOwner?: "runtime";
  };
  // Preview-only supplements — do not replace pair-compare fields.
  generatedAt?: string;
  mission?: string;
  execution?: {
    isolatedThreads: true;
    approvalRequired: true;
    network: "none";
    apiKeys: "none";
  };
  artifacts?: Array<{
    id: string;
    name: string;
    kind: string;
    sourceNodeId: string;
    artifactKey?: string;
    contentHash?: string;
    hostOrdinal?: number;
  }>;
};

function refFromArtifact(
  sourceNodeId: string,
  artifact: Artifact,
  ordinal: number,
): DeliveryArtifactRef | null {
  const artifactKey =
    typeof (artifact as { artifactKey?: unknown }).artifactKey === "string"
      ? String((artifact as { artifactKey?: string }).artifactKey)
      : undefined;
  const contentHash =
    typeof (artifact as { contentHash?: unknown }).contentHash === "string"
      ? String((artifact as { contentHash?: string }).contentHash)
      : undefined;
  const hostOrdinal =
    typeof (artifact as { hostOrdinal?: unknown }).hostOrdinal === "number"
      ? Number((artifact as { hostOrdinal?: number }).hostOrdinal)
      : ordinal;
  if (!artifactKey || !contentHash) {
    return null;
  }
  return {
    artifactKey,
    contentHash,
    sourceNodeId,
    name: artifact.name,
    hostOrdinal,
  };
}

/** Assemble a delivery-bundle preview aligned with runtime v3 field names. */
export function buildDeliveryBundle(args: {
  mission: string;
  upstreamOutputs: Array<{
    nodeId: string;
    role: string;
    label: string;
    summary: string;
    data: Record<string, unknown>;
    artifacts: Artifact[];
  }>;
  generatedAt?: string;
  approvedArtifacts?: DeliveryArtifactRef[];
  liveArtifactRefs?: DeliveryArtifactRef[];
  verificationResults?: VerificationRow[];
}): { summary: string; data: DeliveryBundle; artifacts: Artifact[] } {
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const handoffs = args.upstreamOutputs.map((item) => ({
    nodeId: item.nodeId,
    role: item.role,
    label: item.label,
    summary: item.summary,
    data: item.data,
    artifactNames: item.artifacts.map((a) => a.name),
  }));

  const reviewSource =
    args.upstreamOutputs.find(
      (item) =>
        item.data.verdict === "pass" ||
        item.data.verdict === "needs_revision" ||
        /qa|review|quality/i.test(item.role),
    ) ?? args.upstreamOutputs[args.upstreamOutputs.length - 1];

  const allArtifacts = args.upstreamOutputs.flatMap((item) =>
    item.artifacts.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      sourceNodeId: item.nodeId,
      artifactKey:
        typeof (a as { artifactKey?: unknown }).artifactKey === "string"
          ? String((a as { artifactKey?: string }).artifactKey)
          : undefined,
      contentHash:
        typeof (a as { contentHash?: unknown }).contentHash === "string"
          ? String((a as { contentHash?: string }).contentHash)
          : undefined,
      hostOrdinal:
        typeof (a as { hostOrdinal?: unknown }).hostOrdinal === "number"
          ? Number((a as { hostOrdinal?: number }).hostOrdinal)
          : undefined,
    })),
  );

  const derivedLive: DeliveryArtifactRef[] = [];
  for (const item of args.upstreamOutputs) {
    item.artifacts.forEach((art, i) => {
      const ref = refFromArtifact(item.nodeId, art, i);
      if (ref) derivedLive.push(ref);
    });
  }

  const liveArtifactRefs = args.liveArtifactRefs ?? derivedLive;
  const approvedArtifacts = args.approvedArtifacts ?? [];

  const residualRisks: string[] = [];
  const hasClaimish = args.upstreamOutputs.some((item) => {
    const criteria = (item.data as { criteria?: unknown }).criteria;
    return Array.isArray(criteria) && criteria.length > 0;
  });
  if (hasClaimish) residualRisks.push("claim_criteria_are_advisory_only");
  if (approvedArtifacts.length === 0) {
    residualRisks.push("empty_approval_artifact_set");
  }

  const status = deriveDeliveryStatus({
    upstreamOutputs: args.upstreamOutputs,
    verificationResults: args.verificationResults,
    approvedArtifacts,
    liveArtifactRefs,
  });
  const outcome =
    status === "success" ? "pass" : status === "failed" ? "fail" : "pending";

  const verificationSummary = args.verificationResults?.length
    ? [
        {
          results: args.verificationResults,
          requiredFailed: args.verificationResults
            .filter((row) => row.passed === false)
            .map((row) => row.id),
          passBitOwner: "runtime",
        },
      ]
    : undefined;

  const bundle: DeliveryBundle = {
    schemaVersion: "codex-corp.delivery.v3",
    generatedAt,
    mode: "preview",
    mission: args.mission,
    status,
    execution: {
      isolatedThreads: true,
      approvalRequired: true,
      network: "none",
      apiKeys: "none",
    },
    specialistHandoffs: handoffs,
    approvedArtifacts,
    liveArtifactRefs,
    verificationSummary,
    residualRisks,
    review: {
      outcome,
      summary: reviewSource?.summary ?? "Review completed",
      revisionCount: Number(reviewSource?.data.revision ?? 1),
    },
    artifacts: allArtifacts,
    safety: {
      approval: "explicit-human",
      chainOfThought: "not-exposed",
      permissions: "node-scoped",
      passBitOwner: "runtime",
    },
  };

  const content = JSON.stringify(bundle, null, 2);
  return {
    summary:
      "Delivery bundle assembled from authorized specialist handoffs after human release approval.",
    data: bundle,
    artifacts: [
      {
        id: "delivery-bundle",
        name: "delivery-bundle.json",
        kind: "json",
        content,
      },
    ],
  };
}

/**
 * Pair-compare mirror of the runtime verifier (delivery_pair_compare): every
 * approved (artifactKey, contentHash) must exist in the live set with the same
 * hash, and every live release-set key must be present in the approved set.
 * `true` means the pair contradicts a trusted handoff.
 */
export function pairCompareFailed(
  approved: DeliveryArtifactRef[] | undefined,
  live: DeliveryArtifactRef[] | undefined,
): boolean {
  if (!approved && !live) return false;
  const approvedList = approved ?? [];
  const liveList = live ?? [];
  const liveByKey = new Map(
    liveList.map((ref) => [ref.artifactKey, ref.contentHash]),
  );
  const approvedKeys = new Set(approvedList.map((ref) => ref.artifactKey));
  for (const ref of approvedList) {
    const liveHash = liveByKey.get(ref.artifactKey);
    if (liveHash === undefined) return true;
    if (liveHash !== ref.contentHash) return true;
  }
  for (const ref of liveList) {
    if (!approvedKeys.has(ref.artifactKey)) return true;
  }
  return false;
}

/**
 * Fail-closed delivery status derivation.
 *
 * Order of precedence — any contradiction fails; success is only claimed when
 * runtime verification rows exist AND the approval artifact set is non-empty
 * and pair-compare-clean:
 *
 * 1. explicit handoff failure signals → `failed`
 * 2. runtime verification rows present with any `passed:false` → `failed`
 * 3. pair-compare mismatch between approved and live refs → `failed`
 * 4. rows backed by runtime verification + non-empty approval set → `success`
 * 5. otherwise (no runtime rows, empty approval set) → `pending` — never `pass`
 */
export function deriveDeliveryStatus(args: {
  upstreamOutputs: Array<{
    nodeId: string;
    data: Record<string, unknown>;
  }>;
  verificationResults?: VerificationRow[];
  approvedArtifacts?: DeliveryArtifactRef[];
  liveArtifactRefs?: DeliveryArtifactRef[];
}): DeliveryPreviewStatus {
  const hasHandoffFailure = args.upstreamOutputs.some(
    (item) =>
      item.data.status === "failure" ||
      item.data.status === "failed" ||
      item.data.verdict === "fail" ||
      item.data.verdict === "needs_revision",
  );
  if (hasHandoffFailure) return "failed";

  const runtimeRows = args.verificationResults ?? [];
  if (
    runtimeRows.length > 0 &&
    runtimeRows.some((row) => row.passed === false)
  ) {
    return "failed";
  }

  if (pairCompareFailed(args.approvedArtifacts, args.liveArtifactRefs)) {
    return "failed";
  }

  if (runtimeRows.length > 0 && (args.approvedArtifacts?.length ?? 0) > 0) {
    return "success";
  }

  // Fail closed: no runtime backing (or empty approval snapshot) → pending.
  return "pending";
}

/**
 * Derive a fail-closed delivery status for a persisted run record. The run's
 * output node `structuredOutput` (the delivery bundle) is authoritative when
 * present; a run without a trusted bundle is `pending` and a failed run is
 * `failed` — never claimed `success` from run status alone.
 */
export function deliveryStatusFromRun(args: {
  runStatus?: string;
  nodesJson?: string;
}): DeliveryPreviewStatus {
  if (args.runStatus === "failed" || args.runStatus === "cancelled") {
    return "failed";
  }
  let bundle: Record<string, unknown> | undefined;
  if (args.nodesJson?.trim()) {
    try {
      const nodes = JSON.parse(args.nodesJson) as Array<{
        data?: { kind?: string; structuredOutput?: unknown };
      }>;
      const outputNode = nodes.find((node) => node.data?.kind === "output");
      if (outputNode?.data?.structuredOutput) {
        bundle = outputNode.data.structuredOutput as Record<string, unknown>;
      }
    } catch {
      // Unparseable snapshot: fail closed below.
    }
  }
  if (!bundle) return "pending";
  const verificationSummary = Array.isArray(bundle.verificationSummary)
    ? (bundle.verificationSummary as Array<{
        results?: VerificationRow[];
      }>)
    : [];
  const results = verificationSummary.flatMap((block) => block.results ?? []);
  return deriveDeliveryStatus({
    upstreamOutputs: [],
    verificationResults: results,
    approvedArtifacts: bundle.approvedArtifacts as
      DeliveryArtifactRef[] | undefined,
    liveArtifactRefs: bundle.liveArtifactRefs as
      DeliveryArtifactRef[] | undefined,
  });
}
