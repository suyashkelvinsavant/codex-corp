/**
 * Final delivery-bundle.json assembly after human release approval.
 */

import type { Artifact } from "./model";

export type DeliveryBundle = {
  schemaVersion: string;
  generatedAt: string;
  mode: "live";
  mission: string;
  status: "success";
  execution: {
    isolatedThreads: true;
    approvalRequired: true;
    network: "none";
    apiKeys: "none";
  };
  specialistHandoffs: Array<{
    nodeId: string;
    role: string;
    label: string;
    summary: string;
    data: Record<string, unknown>;
    artifactNames: string[];
  }>;
  review: {
    outcome: string;
    summary: string;
    revisionCount: number;
  };
  artifacts: Array<{
    id: string;
    name: string;
    kind: string;
    sourceNodeId: string;
  }>;
  safety: {
    approvals: "explicit-human";
    chainOfThought: "not-exposed";
    permissions: "node-scoped";
  };
};

/** Assemble the final delivery-bundle.json from explicit upstream outputs. */
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
    })),
  );

  const bundle: DeliveryBundle = {
    schemaVersion: "codex-corp.delivery.v1",
    generatedAt,
    mode: "live",
    mission: args.mission,
    status: "success",
    execution: {
      isolatedThreads: true,
      approvalRequired: true,
      network: "none",
      apiKeys: "none",
    },
    specialistHandoffs: handoffs,
    review: {
      outcome: String(reviewSource?.data.verdict ?? "pass"),
      summary: reviewSource?.summary ?? "Review completed",
      revisionCount: Number(reviewSource?.data.revision ?? 1),
    },
    artifacts: allArtifacts,
    safety: {
      approvals: "explicit-human",
      chainOfThought: "not-exposed",
      permissions: "node-scoped",
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
