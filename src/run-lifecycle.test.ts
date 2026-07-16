import { describe, expect, it } from "vitest";
import {
  missionFromNodes,
  resetExecutableNodeForRun,
  revisionLimitFor,
} from "./run-lifecycle";
import type { FlowEdge, FlowNode, Kind } from "./model";

const node = (
  id: string,
  kind: Kind = "agent",
  extra: Partial<FlowNode["data"]> = {},
): FlowNode => ({
  id,
  type: "corpNode",
  position: { x: 0, y: 0 },
  data: {
    label: id,
    role: id,
    kind,
    status: "idle",
    model: "gpt-5.6-luna",
    effort: "low",
    tools: [],
    prompt: "instructions",
    description: "",
    duration: "—",
    tokens: 0,
    trace: [],
    color: "#fff",
    ...extra,
  },
});

describe("run-lifecycle", () => {
  it("missionFromNodes composes constraints and acceptance notes", () => {
    const mission = missionFromNodes([
      node("input", "input", {
        output: "Build a landing page",
        missionConstraints: ["Single page only"],
        acceptanceNotes: "Hero + CTA",
        status: "completed",
      }),
    ]);
    expect(mission).toContain("Build a landing page");
    expect(mission).toContain("- Single page only");
    expect(mission).toContain("Hero + CTA");
  });

  it("resetExecutableNodeForRun clears criteriaEvaluation and run outputs", () => {
    const dirty = node("builder", "agent", {
      status: "completed",
      output: "done",
      structuredOutput: { x: 1 },
      artifacts: [{ id: "a", name: "f.ts", kind: "code" }],
      threadId: "019f-live-thread",
      criteriaEvaluation: [
        {
          id: "structured_json",
          label: "Return structured JSON output",
          status: "pass",
          detail: "prior",
          enforcement: "required",
        },
      ],
      revisions: 2,
      retries: 1,
      tokens: 100,
    });
    const reset = resetExecutableNodeForRun(dirty);
    expect(reset.data.status).toBe("queued");
    expect(reset.data.output).toBeUndefined();
    expect(reset.data.criteriaEvaluation).toBeUndefined();
    expect(reset.data.artifacts).toEqual([]);
    expect(reset.data.threadId).toBeUndefined();
    expect(reset.data.revisions).toBe(0);
    expect(reset.data.prompt).toBe("instructions");
  });

  it("revisionLimitFor reads revision edge maxRevisions", () => {
    const edges: FlowEdge[] = [
      {
        id: "e",
        source: "reviewer",
        target: "builder",
        data: { edgeType: "revision", maxRevisions: 3 },
      },
    ];
    expect(revisionLimitFor(node("reviewer"), edges)).toBe(3);
  });
});
