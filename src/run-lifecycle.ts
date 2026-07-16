/**
 * Per-run lifecycle helpers shared by the Live Codex graph executor.
 * No stub / synthetic specialist outputs — specialists always go through Codex.
 */

import { composeAuthorizedMission } from "./mission-context";
import type { FlowEdge, FlowNode } from "./model";
import { isSpecialistKind } from "./model";

/** True when the node owns an outbound bounded revision edge. */
export function hasOutboundRevisionEdge(
  node: FlowNode,
  edges: FlowEdge[],
): boolean {
  return edges.some(
    (edge) =>
      edge.source === node.id && edge.data?.edgeType === "revision",
  );
}

/** Seed Quality Gate id or QA/review-style roles (library specialists included). */
export function isReviewerLikeAgent(node: FlowNode): boolean {
  if (node.data.kind !== "agent") return false;
  if (node.id === "reviewer") return true;
  const role = node.data.role.toLowerCase();
  return (
    role.includes("qa") ||
    role.includes("review") ||
    role.includes("quality")
  );
}

/**
 * Reset per-run execution fields before a new graph run.
 * Preserves identity, instructions, tools, schemas, and input mission text.
 */
export function resetExecutableNodeForRun(node: FlowNode): FlowNode {
  if (node.data.kind === "note") return node;
  if (node.data.kind === "input") {
    return {
      ...node,
      data: {
        ...node.data,
        status: "completed",
        duration: node.data.duration || "0.1s",
        threadId: undefined,
        revisions: 0,
        retries: 0,
      },
    };
  }
  const baselineTrace =
    node.data.kind === "approval"
      ? ["Ready · human checkpoint"]
      : node.data.kind === "output"
        ? ["Ready · waiting for approved delivery"]
        : ["Ready · awaiting schedule"];
  return {
    ...node,
    data: {
      ...node.data,
      status: "queued",
      duration: "—",
      threadId: undefined,
      revisions: 0,
      retries: 0,
      tokens: 0,
      output: undefined,
      structuredOutput: undefined,
      artifacts: [],
      validationErrors: undefined,
      criteriaEvaluation: undefined,
      trace: baselineTrace,
    },
  };
}

export function revisionLimitFor(
  node: FlowNode,
  edges: FlowEdge[],
): number {
  const revisionEdge = edges.find(
    (edge) =>
      edge.source === node.id && edge.data?.edgeType === "revision",
  );
  return revisionEdge?.data?.maxRevisions ?? 2;
}

/** Authorized mission string from the graph input node (body + constraints + notes). */
export function missionFromNodes(nodes: FlowNode[]): string {
  const input = nodes.find((candidate) => candidate.data.kind === "input");
  return composeAuthorizedMission({
    output: input?.data.output,
    missionConstraints: input?.data.missionConstraints,
    acceptanceNotes: input?.data.acceptanceNotes,
  });
}
