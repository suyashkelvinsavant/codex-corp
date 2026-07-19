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

  const hasFailure = args.upstreamOutputs.some(
    (item) =>
      item.data.status === "failure" ||
      item.data.status === "failed" ||
      item.data.verdict === "fail" ||
      item.data.verdict === "needs_revision",
  );
  const status = hasFailure ? "failed" : "success";

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
    residualRisks,
    review: {
      outcome: String(reviewSource?.data.verdict ?? "pass"),
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
