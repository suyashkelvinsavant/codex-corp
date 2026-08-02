import { describe, expect, it } from "vitest";
import {
  missionFromNodes,
  nodeOutputPatchForRunEvent,
  nodeStatusForRunEvent,
  prepareNodesForRun,
  resetExecutableNodeForRun,
  revisionCountForRunEvent,
  revisionLimitFor,
  shouldAcceptRunEvent,
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

  it("atomically overlays a chat mission and resets that exact graph for the run UI", () => {
    const input = node("input", "input", {
      output: "Old mission",
      status: "completed",
    });
    const builder = node("builder", "agent", { status: "completed" });
    const prepared = prepareNodesForRun(
      [input, builder],
      "Build a chair storefront",
    );
    expect(prepared.find((item) => item.id === "input")?.data.output).toBe(
      "Build a chair storefront",
    );
    expect(prepared.find((item) => item.id === "builder")?.data.status).toBe(
      "queued",
    );
    expect(input.data.output).toBe("Old mission");
  });

  it("scopes a selected-node run without fabricating upstream or revision activity", () => {
    const nodes = [
      node("input", "input", { status: "completed", output: "mission" }),
      node("builder", "agent", {
        status: "completed",
        output: "built",
        revisions: 1,
      }),
      node("qa", "agent", { status: "failed", output: "old failure" }),
      node("approval", "approval", { status: "idle" }),
      node("output", "output", { status: "idle" }),
      node("unrelated", "agent", { status: "completed", output: "keep" }),
    ];
    const edges: FlowEdge[] = [
      { id: "i-b", source: "input", target: "builder" },
      { id: "b-q", source: "builder", target: "qa" },
      {
        id: "q-a",
        source: "qa",
        target: "approval",
        data: { edgeType: "approval" },
      },
      { id: "a-o", source: "approval", target: "output" },
      {
        id: "q-b",
        source: "qa",
        target: "builder",
        data: { edgeType: "revision", maxRevisions: 2 },
      },
    ];

    const prepared = prepareNodesForRun(nodes, undefined, edges, "qa");
    const byId = Object.fromEntries(
      prepared.map((item) => [item.id, item.data]),
    );
    // Attack vector 1: the selected failed node is reset for execution.
    expect(byId.qa.status).toBe("queued");
    expect(byId.qa.output).toBeUndefined();
    // Attack vector 2: its ordinary descendants are reset.
    expect(byId.approval.status).toBe("queued");
    expect(byId.output.status).toBe("queued");
    // Attack vector 3: the reverse revision edge cannot reset Builder.
    expect(byId.builder.status).toBe("completed");
    expect(byId.builder.output).toBe("built");
    expect(byId.builder.revisions).toBe(1);
    // Attack vector 4: ordinary ancestors remain visibly completed.
    expect(byId.input.status).toBe("completed");
    // Attack vector 5: unrelated branches retain their evidence and status.
    expect(byId.unrelated.status).toBe("completed");
    expect(byId.unrelated.output).toBe("keep");
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

  it("maps a terminal node failure to failed after an attempt completed event", () => {
    expect(nodeStatusForRunEvent("node.attempt.completed")).toBe("completed");
    expect(nodeStatusForRunEvent("node.terminal.failed")).toBe("failed");
  });

  it("maps the complete human approval lifecycle without leaving the node waiting", () => {
    expect(nodeStatusForRunEvent("approval.requested")).toBe("approval");
    expect(nodeStatusForRunEvent("approval.approved")).toBe("completed");
    expect(nodeStatusForRunEvent("approval.declined")).toBe("failed");
  });

  it("marks non-specialist control nodes completed", () => {
    expect(nodeStatusForRunEvent("node.completed")).toBe("completed");
  });

  it.each([
    ["no active run", null, "run-1", 1, { runId: null, sequence: 0 }, false],
    [
      "different run",
      "run-1",
      "run-2",
      1,
      { runId: "run-1", sequence: 2 },
      false,
    ],
    ["first event", "run-1", "run-1", 1, { runId: null, sequence: 0 }, true],
    [
      "duplicate or reordered event",
      "run-1",
      "run-1",
      2,
      { runId: "run-1", sequence: 2 },
      false,
    ],
    ["newer event", "run-1", "run-1", 3, { runId: "run-1", sequence: 2 }, true],
  ] as const)(
    "accepts only fresh events for the active run: %s",
    (_label, activeRunId, eventRunId, sequence, cursor, expected) => {
      expect(
        shouldAcceptRunEvent(activeRunId, eventRunId, sequence, cursor),
      ).toBe(expected);
    },
  );

  it("hydrates a completed Release Bundle without leaking artifact bodies", () => {
    const patch = nodeOutputPatchForRunEvent("node.completed", {
      summary: "Approved release bundle assembled.",
      data: {
        schemaVersion: "codex-corp.delivery.v3",
        bundleHash: "sha256:bundle",
      },
      artifacts: [
        {
          id: "delivery-bundle",
          name: "delivery-bundle.json",
          kind: "json",
          contentHash: "sha256:artifact",
        },
      ],
    });

    expect(patch.output).toBe("Approved release bundle assembled.");
    expect(patch.structuredOutput).toMatchObject({
      schemaVersion: "codex-corp.delivery.v3",
      bundleHash: "sha256:bundle",
    });
    expect(patch.artifacts).toHaveLength(1);
    expect(patch.artifacts?.[0]).not.toHaveProperty("content");
  });

  it("ignores output payloads on non-completion events", () => {
    expect(
      nodeOutputPatchForRunEvent("node.started", {
        summary: "must not publish early",
        artifacts: [{ name: "premature.json" }],
      }),
    ).toEqual({});
  });

  it("rejects malformed completion diagnostics instead of corrupting node data", () => {
    expect(
      nodeOutputPatchForRunEvent("node.completed", {
        summary: 42,
        data: ["invalid"],
        artifacts: "invalid",
      }),
    ).toEqual({});
  });

  describe("revision connector counters", () => {
    it("increments from a structured revision.routed event", () => {
      expect(
        revisionCountForRunEvent(
          "revision.routed",
          { revision: 1, maxRevisions: 2 },
          0,
        ),
      ).toBe(1);
    });

    it("keeps the counter monotonic when delayed events arrive out of order", () => {
      expect(
        revisionCountForRunEvent(
          "revision.routed",
          { revision: 1, maxRevisions: 2 },
          2,
        ),
      ).toBe(2);
    });

    it("ignores unrelated events and malformed revision values", () => {
      expect(
        revisionCountForRunEvent("node.attempt.started", { revision: 2 }, 1),
      ).toBeUndefined();
      expect(
        revisionCountForRunEvent(
          "revision.routed",
          { revision: "2", maxRevisions: 2 },
          1,
        ),
      ).toBeUndefined();
    });

    it("rejects zero, negative, and over-limit revisions", () => {
      for (const revision of [0, -1, 3]) {
        expect(
          revisionCountForRunEvent(
            "revision.routed",
            { revision, maxRevisions: 2 },
            0,
          ),
        ).toBeUndefined();
      }
    });
  });
});
