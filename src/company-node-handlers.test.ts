import { describe, expect, it } from "vitest";
import { resolveNode, executeNodeHandler } from "./company-node-handlers";
import type { MediatorHostContext } from "./company-mediator-tools";
import type { FlowNode } from "./model";

const node = (
  id: string,
  partial: Partial<FlowNode["data"]> & { kind?: FlowNode["data"]["kind"] },
): FlowNode => ({
  id,
  type: "corpNode",
  position: { x: 0, y: 0 },
  data: {
    label: partial.label ?? id,
    role: partial.role ?? id,
    kind: partial.kind ?? "agent",
    status: partial.status ?? "idle",
    model: "gpt-5.6-luna",
    effort: "low",
    tools: [],
    prompt: partial.prompt ?? "Do the job",
    description: "",
    duration: "—",
    tokens: 0,
    trace: partial.trace ?? ["started"],
    color: "#fff",
    output: partial.output,
    structuredOutput: partial.structuredOutput,
    artifacts: partial.artifacts,
    criteriaEvaluation: partial.criteriaEvaluation,
    completionCriteria: partial.completionCriteria,
  },
});

function ctx(over: Partial<MediatorHostContext> = {}): MediatorHostContext {
  return {
    nodes: [
      node("input", { kind: "input", label: "Mission brief", status: "completed" }),
      node("builder", {
        label: "Build Agent",
        role: "Frontend Engineer",
        status: "failed",
        output: "Could not finish",
        trace: ["started", "Attempt failed: sandbox error"],
        prompt: "Implement the landing page only.",
      }),
      node("architect", {
        label: "Systems Architect",
        role: "Architect",
        status: "completed",
        output: "File plan ready",
        prompt: "Produce architecture plan only.",
      }),
    ],
    edges: [],
    events: [
      {
        id: "1",
        at: new Date().toISOString(),
        type: "node.failed",
        message: "Build Agent · failed",
        nodeId: "builder",
        level: "error",
      },
    ],
    running: false,
    runId: null,
    workflowId: "wf-test",
    approvals: [],
    runHistory: [],
    ...over,
  };
}

describe("company-node-handlers / resolveNode", () => {
  it("resolves by exact id", () => {
    const r = resolveNode(ctx(), { nodeId: "builder" });
    expect(r.node?.id).toBe("builder");
  });

  it("resolves by exact label (case-insensitive)", () => {
    const r = resolveNode(ctx(), { label: "build agent" });
    expect(r.node?.id).toBe("builder");
  });

  it("resolves by role substring", () => {
    const r = resolveNode(ctx(), { label: "architect" });
    expect(r.node?.id).toBe("architect");
  });

  it("returns error when no nodeId or label provided", () => {
    const r = resolveNode(ctx(), {});
    expect(r.error).toBeTruthy();
  });

  it("returns candidates when ambiguous", () => {
    const c = ctx({
      nodes: [
        node("a", { label: "Reviewer Alpha", role: "QA" }),
        node("b", { label: "Reviewer Beta", role: "QA" }),
      ],
    });
    const r = resolveNode(c, { label: "Reviewer" });
    expect(r.error).toMatch(/Ambiguous/i);
    expect(r.candidates).toHaveLength(2);
  });

  it("returns error when nothing matches", () => {
    const r = resolveNode(ctx(), { label: "nonexistent" });
    expect(r.error).toMatch(/No node matched/i);
  });
});

describe("company-node-handlers / executeNodeHandler", () => {
  it("returns null for unknown tool names", async () => {
    const r = await executeNodeHandler("not_a_node_tool", {}, ctx());
    expect(r).toBeNull();
  });

  it("node_focus calls focusNode action and returns ok", async () => {
    let focused: string | null = null;
    const c = ctx({
      actions: {
        focusNode: (id) => {
          focused = id;
        },
      },
    });
    const r = await executeNodeHandler("node_focus", { nodeId: "builder" }, c);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(focused).toBe("builder");
    expect(JSON.parse(r!.text)).toMatchObject({ focused: "builder" });
  });

  it("node_get returns node summary fields", async () => {
    const r = await executeNodeHandler("node_get", { nodeId: "builder" }, ctx());
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    const data = JSON.parse(r!.text);
    expect(data).toMatchObject({
      id: "builder",
      label: "Build Agent",
      role: "Frontend Engineer",
      status: "failed",
    });
  });

  it("node_get_output returns output and artifacts", async () => {
    const r = await executeNodeHandler(
      "node_get_output",
      { nodeId: "builder" },
      ctx(),
    );
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    const data = JSON.parse(r!.text);
    expect(data).toMatchObject({ id: "builder", status: "failed" });
    expect(data.summary).toBe("Could not finish");
  });

  it("node_get_trace returns trace entries", async () => {
    const r = await executeNodeHandler(
      "node_get_trace",
      { nodeId: "builder", limit: 5 },
      ctx(),
    );
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    const data = JSON.parse(r!.text);
    expect(data.trace).toEqual(["started", "Attempt failed: sandbox error"]);
  });

  it("node_get_events returns filtered events", async () => {
    const r = await executeNodeHandler(
      "node_get_events",
      { nodeId: "builder" },
      ctx(),
    );
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    const data = JSON.parse(r!.text);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toMatchObject({
      type: "node.failed",
      level: "error",
    });
  });

  it("node_task_progress returns criteria and error summary", async () => {
    const r = await executeNodeHandler(
      "node_task_progress",
      { label: "Builder" },
      ctx(),
    );
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    const data = JSON.parse(r!.text);
    expect(data).toMatchObject({
      id: "builder",
      status: "failed",
      hasOutput: true,
    });
    expect(data.lastError).not.toBeNull();
    expect(data.lastError.message).toMatch(/Build Agent/i);
  });

  it("returns fail result when node resolution fails", async () => {
    const r = await executeNodeHandler(
      "node_get",
      { label: "nonexistent" },
      ctx(),
    );
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
    expect(r!.text).toMatch(/No node matched/i);
  });
});
