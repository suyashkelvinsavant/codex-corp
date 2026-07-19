import { describe, expect, it } from "vitest";
import {
  autoLayout,
  readyNodeIds,
  standardCycle,
  upstreamLineage,
  validateWorkflow,
} from "./graph";
import { AgentOutputSchema } from "./model";
import type { EdgeKind, FlowEdge, FlowNode, Kind } from "./model";

const detailedPrompt = `You are a test specialist for graph validation.

Mission
- Execute the assigned unit of work for integration tests with clear structured output.

Process
1. Read the mission and upstream context.
2. Perform the smallest complete step.
3. Return status, summary, and data.

Output contract
- Always return structured agent output suitable for downstream nodes.`;

const node = (id: string, kind: Kind = "agent"): FlowNode => ({
  id,
  type: "corpNode",
  position: { x: 0, y: 0 },
  data: {
    label: id,
    role: id,
    kind,
    status: "idle",
    model: "test",
    effort: "low",
    tools: kind === "agent" || kind === "creative" ? ["Shell"] : [],
    prompt:
      kind === "agent" || kind === "creative" ? detailedPrompt : "control",
    description: "",
    duration: "—",
    tokens: 0,
    trace: [],
    color: "#fff",
  },
});
const edge = (
  source: string,
  target: string,
  edgeType: EdgeKind = "standard",
): FlowEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  type: "signalEdge",
  data: { edgeType, maxRevisions: edgeType === "revision" ? 2 : undefined },
});

describe("workflow graph core", () => {
  it("accepts a cron trigger connected into the Mission brief input", () => {
    const cron = node("schedule", "cron");
    cron.data.cronExpression = "0 9 * * 1-5";
    cron.data.cronTimezone = "UTC";
    const problems = validateWorkflow(
      [cron, node("input", "input"), node("agent"), node("out", "output")],
      [edge("schedule", "input"), edge("input", "agent"), edge("agent", "out")],
    );
    expect(problems.filter((problem) => problem.severity === "error")).toEqual(
      [],
    );
  });

  it("computes the exact upstream context aperture and excludes revision feedback edges", () => {
    const edges = [
      edge("input", "a"),
      edge("a", "b"),
      edge("other", "c"),
      edge("b", "a", "revision"),
    ];
    expect([...upstreamLineage("b", edges)].sort()).toEqual([
      "a",
      "b",
      "input",
    ]);
  });

  it("rejects ordinary cycles but permits bounded revision cycles", () => {
    expect(standardCycle([edge("a", "b"), edge("b", "a")])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(
      standardCycle([edge("a", "b"), edge("b", "a", "revision")]),
    ).toBeNull();
    const good = [node("input", "input"), node("a"), node("out", "output")];
    expect(
      validateWorkflow(good, [
        edge("input", "a"),
        edge("a", "out"),
        edge("a", "a", "revision"),
      ]).some((p) => p.id === "standard-cycle"),
    ).toBe(false);
  });

  it("reports disconnected nodes, missing paths and unbounded revision edges", () => {
    const nodes = [
      node("input", "input"),
      node("lonely"),
      node("out", "output"),
    ];
    const revision = edge("lonely", "input", "revision");
    revision.data!.maxRevisions = undefined;
    const ids = validateWorkflow(nodes, [revision]).map(
      (problem) => problem.id,
    );
    expect(ids).toContain("disconnected-lonely");
    expect(ids).toContain("unreachable-out");
    expect(ids).toContain("revision-limit-lonely-input");
  });

  it("errors when a specialist has an empty model id", () => {
    const agent = node("a");
    agent.data.model = "";
    const creative = node("c", "creative");
    creative.data.model = "   ";
    creative.data.prompt = detailedPrompt;
    const nodes = [
      node("input", "input"),
      agent,
      creative,
      node("out", "output"),
    ];
    const edges = [
      edge("input", "a"),
      edge("input", "c"),
      edge("a", "out"),
      edge("c", "out"),
    ];
    const ids = validateWorkflow(nodes, edges).map((problem) => problem.id);
    expect(ids).toContain("model-a");
    expect(ids).toContain("model-c");
    expect(
      validateWorkflow(
        [node("input", "input"), node("a"), node("out", "output")],
        [edge("input", "a"), edge("a", "out")],
      ).some((problem) => problem.id.startsWith("model-")),
    ).toBe(false);
  });

  it("warns for weak legacy prompts but still errors for empty prompts", () => {
    const agent = node("a");
    agent.data.prompt = "Define this node contract.";
    const weak = validateWorkflow(
      [node("input", "input"), agent, node("out", "output")],
      [edge("input", "a"), edge("a", "out")],
    );
    expect(weak).toContainEqual(
      expect.objectContaining({ id: "prompt-quality-a", severity: "warning" }),
    );
    agent.data.prompt = "";
    expect(
      validateWorkflow(
        [node("input", "input"), agent, node("out", "output")],
        [edge("input", "a"), edge("a", "out")],
      ),
    ).toContainEqual(
      expect.objectContaining({ id: "prompt-a", severity: "error" }),
    );
  });

  it("schedules independent branches in the same ready batch and joins a merge", () => {
    const nodes = [
      node("input", "input"),
      node("a"),
      node("b"),
      node("merge", "merge"),
      node("out", "output"),
    ];
    const edges = [
      edge("input", "a"),
      edge("input", "b"),
      edge("a", "merge"),
      edge("b", "merge"),
      edge("merge", "out"),
    ];
    expect(readyNodeIds(nodes, edges, new Set(["input"])).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(readyNodeIds(nodes, edges, new Set(["input", "a"]))).toEqual(["b"]);
    expect(readyNodeIds(nodes, edges, new Set(["input", "a", "b"]))).toEqual([
      "merge",
    ]);
  });

  it("auto-layouts dependency depth into increasing columns", () => {
    const nodes = [
      node("input", "input"),
      node("agent"),
      node("out", "output"),
    ];
    const laidOut = autoLayout(nodes, [
      edge("input", "agent"),
      edge("agent", "out"),
    ]);
    const byId = Object.fromEntries(laidOut.map((n) => [n.id, n]));
    expect(byId.input.position.x).toBeLessThan(byId.agent.position.x);
    expect(byId.agent.position.x).toBeLessThan(byId.out.position.x);
  });

  it("rejects required claim criteria at design time", () => {
    const agent = node("agent");
    agent.data.completionCriteria = [
      {
        id: "claim-1",
        label: "I promise",
        kind: "claim",
        enabled: true,
        enforcement: "required",
      },
    ];
    const problems = validateWorkflow(
      [node("input", "input"), agent, node("out", "output")],
      [edge("input", "agent"), edge("agent", "out")],
    );
    expect(
      problems.some((p) => p.id.includes("criterion-claim-required")),
    ).toBe(true);
  });

  it("rejects command criteria without allowlisted templateId", () => {
    const agent = node("agent");
    agent.data.completionCriteria = [
      {
        id: "cmd-1",
        label: "Tests",
        kind: "command",
        enabled: true,
        enforcement: "required",
        templateId: "rm_rf",
      },
    ];
    const problems = validateWorkflow(
      [node("input", "input"), agent, node("out", "output")],
      [edge("input", "agent"), edge("agent", "out")],
    );
    expect(problems.some((p) => p.id.includes("criterion-command"))).toBe(true);
  });

  it("rejects parseable JSON that is not a valid JSON Schema", () => {
    const agent = node("agent");
    agent.data.inputSchema = JSON.stringify({ type: "not-a-json-schema-type" });
    const problems = validateWorkflow(
      [node("input", "input"), agent, node("out", "output")],
      [edge("input", "agent"), edge("agent", "out")],
    );
    expect(
      problems.some((problem) => problem.id === "input-schema-agent"),
    ).toBe(true);
  });

  it("auto-layout finishes on standard-edge design loops (no UI freeze)", () => {
    // designer ↔ creative with standard edges (user RCA case)
    const nodes = [
      node("input", "input"),
      node("designer"),
      node("creative", "creative"),
      node("out", "output"),
    ];
    const edges = [
      edge("input", "designer"),
      edge("designer", "creative"),
      edge("creative", "designer"), // standard feedback loop — previously hung layout
      edge("designer", "out"),
    ];
    const started = Date.now();
    const laidOut = autoLayout(nodes, edges);
    expect(Date.now() - started).toBeLessThan(500);
    expect(laidOut).toHaveLength(4);
    const byId = Object.fromEntries(laidOut.map((n) => [n.id, n]));
    // Loop participants share a column (SCC stack)
    expect(byId.designer.position.x).toBe(byId.creative.position.x);
    expect(byId.input.position.x).toBeLessThan(byId.designer.position.x);
  });

  it("puts revision pairs in the same column with target directly above source", () => {
    // a → b → c with c ⇢ b revision: b and c share one column (b on top of c)
    const nodes = [node("a"), node("b"), node("c")];
    const laidOut = autoLayout(nodes, [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "b", "revision"),
    ]);
    const byId = Object.fromEntries(laidOut.map((n) => [n.id, n]));
    expect(byId.a.position.x).toBeLessThan(byId.b.position.x);
    // Same column — not staggered across columns (that hid the return edge)
    expect(byId.b.position.x).toBe(byId.c.position.x);
    expect(byId.b.position.y).toBeLessThan(byId.c.position.y);
    expect(byId.c.position.y - byId.b.position.y).toBeGreaterThanOrEqual(180);
  });

  it("does not overlap node cards and co-locates builder/reviewer feedback", () => {
    const nodes = [
      node("input", "input"),
      node("research"),
      node("architect"),
      node("builder"),
      node("reviewer"),
      node("out", "output"),
    ];
    const edges = [
      edge("input", "research"),
      edge("input", "architect"),
      edge("research", "builder"),
      edge("architect", "builder"),
      edge("builder", "reviewer"),
      edge("reviewer", "builder", "revision"),
      edge("reviewer", "out"),
    ];
    const laidOut = autoLayout(nodes, edges);
    const width = 286;
    const height = 140;
    for (let i = 0; i < laidOut.length; i++) {
      for (let j = i + 1; j < laidOut.length; j++) {
        const a = laidOut[i].position;
        const b = laidOut[j].position;
        const overlapX = a.x < b.x + width && a.x + width > b.x;
        const overlapY = a.y < b.y + height && a.y + height > b.y;
        expect(overlapX && overlapY).toBe(false);
      }
    }
    const byId = Object.fromEntries(laidOut.map((n) => [n.id, n]));
    expect(byId.builder.position.x).toBe(byId.reviewer.position.x);
    expect(byId.builder.position.y).toBeLessThan(byId.reviewer.position.y);
    expect(byId.out.position.x).toBeGreaterThan(byId.reviewer.position.x);
  });

  it("rejects malformed agent output before downstream routing", () => {
    expect(
      AgentOutputSchema.safeParse({
        status: "success",
        summary: "",
        data: {},
        artifacts: [],
      }).success,
    ).toBe(false);
    expect(
      AgentOutputSchema.safeParse({
        status: "success",
        summary: "Ready",
        data: {},
        artifacts: [],
      }).success,
    ).toBe(true);
  });

  it("validates typed edge contracts and JSON field mappings", () => {
    const nodes = [
      node("input", "input"),
      node("agent"),
      node("approval", "approval"),
      node("out", "output"),
    ];
    const badCondition = edge("input", "agent", "conditional");
    const badApproval = edge("agent", "out", "approval");
    badApproval.data!.mapping = { summary: "summary" };
    const ids = validateWorkflow(nodes, [
      badCondition,
      badApproval,
      edge("agent", "approval"),
      edge("approval", "out"),
    ]).map((problem) => problem.id);
    expect(ids).toContain("condition-input-agent");
    expect(ids).toContain("approval-target-agent-out");
    expect(ids).toContain("mapping-agent-out-summary");
  });
});
