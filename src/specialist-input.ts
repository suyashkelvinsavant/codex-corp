import type { FlowEdge, FlowNode } from "./model";

export type ComposedSpecialistInput = {
  workflowInput: string;
  upstreamOutputs: Array<{
    sourceNodeId: string;
    edgeId: string;
    payload: unknown;
  }>;
  revisionFeedback: Array<{ message: string }>;
};

export function resolveJsonPath(root: unknown, path: string): unknown {
  if (!path.startsWith("$.")) return undefined;
  let current: unknown = root;
  for (const segment of path.slice(2).split(".")) {
    const match = /^([^[]+)(?:\[(\d+)\])?$/.exec(segment);
    if (!match || current === null || typeof current !== "object")
      return undefined;
    current = (current as Record<string, unknown>)[match[1]];
    if (match[2] !== undefined) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(match[2])];
    }
  }
  return current;
}

export function composeSpecialistInputPreview(
  workflowInput: string,
  nodeId: string,
  nodes: FlowNode[],
  inboundEdges: FlowEdge[],
): ComposedSpecialistInput {
  const revisionFeedback = inboundEdges
    .filter(
      (edge) => edge.target === nodeId && edge.data?.edgeType === "revision",
    )
    .flatMap((edge) => {
      const source = nodes.find((candidate) => candidate.id === edge.source);
      const feedback = source?.data.output?.trim();
      if (!source || !feedback) return [];
      return [
        {
          message: `REVISION FEEDBACK FROM ${source.data.label}:\n${feedback}`,
        },
      ];
    });
  return {
    workflowInput,
    upstreamOutputs: inboundEdges
      .filter(
        (edge) => edge.target === nodeId && edge.data?.edgeType !== "revision",
      )
      .flatMap((edge) => {
        const source = nodes.find((candidate) => candidate.id === edge.source);
        if (!source || source.data.status !== "completed") return [];
        const full = {
          status: "success",
          summary: source.data.output ?? "",
          data: source.data.structuredOutput ?? {},
          artifacts: source.data.artifacts ?? [],
          threadId: source.data.threadId ?? null,
        };
        const mapping = edge.data?.mapping;
        const payload =
          mapping && Object.keys(mapping).length
            ? Object.fromEntries(
                Object.entries(mapping).map(([field, path]) => [
                  field,
                  resolveJsonPath(full, path) ?? null,
                ]),
              )
            : full;
        return [{ sourceNodeId: source.id, edgeId: edge.id, payload }];
      }),
    revisionFeedback,
  };
}
