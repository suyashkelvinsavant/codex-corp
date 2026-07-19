import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode } from "./model";
import { composeSpecialistInputPreview } from "./specialist-input";

const node = (
  id: string,
  status: FlowNode["data"]["status"],
  output: string,
): FlowNode => ({
  id,
  type: "corpNode",
  position: { x: 0, y: 0 },
  data: {
    label: id,
    role: id,
    kind: "agent",
    status,
    model: "gpt",
    effort: "medium",
    tools: [],
    prompt: "",
    description: "",
    duration: "—",
    tokens: 0,
    trace: [],
    color: "#fff",
    output,
    structuredOutput: { score: 7 },
  },
});

describe("specialist input preview", () => {
  it("includes only completed direct sources and applies edge mappings", () => {
    const edges: FlowEdge[] = [
      {
        id: "mapped",
        source: "a",
        target: "target",
        data: { edgeType: "standard", mapping: { score: "$.data.score" } },
      },
      {
        id: "pending",
        source: "b",
        target: "target",
        data: { edgeType: "standard" },
      },
      {
        id: "unrelated",
        source: "c",
        target: "other",
        data: { edgeType: "standard" },
      },
      {
        id: "revision",
        source: "reviewer",
        target: "target",
        data: { edgeType: "revision" },
      },
    ];
    expect(
      composeSpecialistInputPreview(
        "mission",
        "target",
        [
          node("a", "completed", "done"),
          node("b", "running", "pending"),
          node("c", "completed", "secret"),
          node("reviewer", "completed", "Tighten the error handling."),
        ],
        edges,
      ),
    ).toEqual({
      workflowInput: "mission",
      upstreamOutputs: [
        { sourceNodeId: "a", edgeId: "mapped", payload: { score: 7 } },
      ],
      revisionFeedback: [
        {
          message:
            "REVISION FEEDBACK FROM reviewer:\nTighten the error handling.",
        },
      ],
    });
  });
});
