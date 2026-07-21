/**
 * Per-run lifecycle helpers shared by the Live Codex graph executor.
 * No stub / synthetic specialist outputs — specialists always go through Codex.
 */

import { composeAuthorizedMission } from "./mission-context";
import {
  DEFAULT_MAX_REVISIONS,
  isSpecialistKind,
  type FlowEdge,
  type FlowNode,
} from "./model";

const NODE_STATUS_BY_RUN_EVENT: Partial<
  Record<string, FlowNode["data"]["status"]>
> = {
  "node.attempt.started": "running",
  "node.attempt.completed": "completed",
  "node.attempt.failed": "failed",
  "node.terminal.failed": "failed",
  "node.started": "running",
  "node.completed": "completed",
  "node.skipped": "skipped",
  "approval.requested": "approval",
  "approval.approved": "completed",
  "approval.declined": "failed",
  "approval.expired": "failed",
};

export function nodeStatusForRunEvent(
  eventType: string,
): FlowNode["data"]["status"] | undefined {
  return NODE_STATUS_BY_RUN_EVENT[eventType];
}

/** Return monotonic connector progress from a validated native revision event. */
export function revisionCountForRunEvent(
  eventType: string,
  diagnostics: Record<string, unknown>,
  currentRevisions: number,
): number | undefined {
  if (eventType !== "revision.routed") return undefined;
  const revision = diagnostics.revision;
  const maxRevisions = diagnostics.maxRevisions;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision <= 0 ||
    typeof maxRevisions !== "number" ||
    !Number.isInteger(maxRevisions) ||
    maxRevisions <= 0 ||
    revision > maxRevisions
  ) {
    return undefined;
  }
  const current =
    Number.isInteger(currentRevisions) && currentRevisions >= 0
      ? currentRevisions
      : 0;
  return Math.max(current, revision);
}

type NodeOutputPatch = Partial<
  Pick<FlowNode["data"], "output" | "structuredOutput" | "artifacts">
>;

/** Extract safe host-produced output from specialist or control completion events. */
export function nodeOutputPatchForRunEvent(
  eventType: string,
  diagnostics: Record<string, unknown>,
  currentStructuredOutput?: Record<string, unknown>,
): NodeOutputPatch {
  if (
    eventType !== "node.attempt.completed" &&
    eventType !== "node.completed"
  ) {
    return {};
  }
  const patch: NodeOutputPatch = {};
  if (typeof diagnostics.summary === "string") {
    patch.output = diagnostics.summary;
  }
  if (
    diagnostics.data &&
    typeof diagnostics.data === "object" &&
    !Array.isArray(diagnostics.data)
  ) {
    patch.structuredOutput = {
      ...(currentStructuredOutput ?? {}),
      ...(diagnostics.data as Record<string, unknown>),
    };
  }
  if (Array.isArray(diagnostics.artifacts)) {
    patch.artifacts = diagnostics.artifacts as FlowNode["data"]["artifacts"];
  }
  return patch;
}

/** True when the node owns an outbound bounded revision edge. */
export function hasOutboundRevisionEdge(
  node: FlowNode,
  edges: FlowEdge[],
): boolean {
  return edges.some(
    (edge) => edge.source === node.id && edge.data?.edgeType === "revision",
  );
}

/** Seed Quality Gate id or QA/review-style roles (library specialists included). */
export function isReviewerLikeAgent(node: FlowNode): boolean {
  if (node.data.kind !== "agent") return false;
  if (node.id === "reviewer") return true;
  const role = node.data.role.toLowerCase();
  return (
    role.includes("qa") || role.includes("review") || role.includes("quality")
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
        ? ["Ready · verifies approved artifacts and builds the release bundle"]
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

/**
 * Build the exact graph shown and persisted for a new run. Mission overrides
 * and runtime reset happen in one immutable transformation so React state
 * cannot later overwrite the authorized mission with a stale closure value.
 */
export function prepareNodesForRun(
  nodes: FlowNode[],
  missionOverride?: string,
  edges: FlowEdge[] = [],
  startNodeId?: string,
): FlowNode[] {
  const mission = missionOverride?.trim();
  const executionScope = new Set<string>();
  if (startNodeId) {
    executionScope.add(startNodeId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (
          edge.data?.edgeType !== "revision" &&
          executionScope.has(edge.source) &&
          !executionScope.has(edge.target)
        ) {
          executionScope.add(edge.target);
          changed = true;
        }
      }
    }
  }
  return nodes.map((node) => {
    const withMission =
      mission && node.data.kind === "input"
        ? { ...node, data: { ...node.data, output: mission } }
        : node;
    return !startNodeId || executionScope.has(node.id)
      ? resetExecutableNodeForRun(withMission)
      : withMission;
  });
}

export function revisionLimitFor(node: FlowNode, edges: FlowEdge[]): number {
  const revisionEdge = edges.find(
    (edge) => edge.source === node.id && edge.data?.edgeType === "revision",
  );
  return revisionEdge?.data?.maxRevisions ?? DEFAULT_MAX_REVISIONS;
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
