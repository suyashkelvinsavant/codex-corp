import { describe, expect, it } from "vitest";
import {
  buildMediatorContextDigest,
  companyMediatorDynamicTools,
  executeCompanyMediatorTool,
  type MediatorHostContext,
} from "./company-mediator-tools";
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
      node("input", {
        kind: "input",
        label: "Mission brief",
        status: "completed",
        output: "Ship landing page",
      }),
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
    approvals: [],
    runHistory: [],
    ...over,
  };
}

describe("company-mediator-tools", () => {
  it("exports dynamic tool specs including node inspection", () => {
    const tools = companyMediatorDynamicTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("company_run");
    expect(names).toContain("company_select_app_workspace");
    expect(names).toContain("node_get");
    expect(names).toContain("node_task_progress");
    expect(names).toContain("node_get_events");
  });

  it("workspace tool is narrowly described and returns the operator selection", async () => {
    const tool = companyMediatorDynamicTools().find(
      (item) => item.name === "company_select_app_workspace",
    );
    expect(tool?.description).toMatch(/ONLY after/i);
    expect(tool?.description).toMatch(/Do NOT call for greetings/i);
    expect(tool?.description).toMatch(/workflow information/i);

    const result = await executeCompanyMediatorTool(
      "company_select_app_workspace",
      { suggestedMode: "existing" },
      ctx({
        actions: {
          selectAppWorkspace: async (mode) => ({
            projectMode: mode,
            workspacePath: "C:/projects/existing-app",
          }),
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      selected: true,
      projectMode: "existing",
      workspacePath: "C:/projects/existing-app",
    });
  });

  it("company_list_nodes returns graph roster", async () => {
    const r = await executeCompanyMediatorTool("company_list_nodes", {}, ctx());
    expect(r.success).toBe(true);
    expect(r.text).toContain("Build Agent");
    expect(r.text).toContain("failed");
  });

  it("node_task_progress diagnoses failed builder", async () => {
    const r = await executeCompanyMediatorTool(
      "node_task_progress",
      { label: "Builder" },
      ctx(),
    );
    expect(r.success).toBe(true);
    const data = JSON.parse(r.text) as {
      status: string;
      lastError: { message: string } | null;
      hasOutput: boolean;
    };
    expect(data.status).toBe("failed");
    expect(data.hasOutput).toBe(true);
    expect(data.lastError?.message).toMatch(/Build Agent/i);
  });

  it("company_run invokes host action", async () => {
    let ran = false;
    const r = await executeCompanyMediatorTool(
      "company_run",
      { mission: "New mission" },
      ctx({
        actions: {
          setMission: (m) => {
            expect(m).toBe("New mission");
          },
          run: () => {
            ran = true;
          },
        },
      }),
    );
    expect(r.success).toBe(true);
    expect(ran).toBe(true);
  });

  it("ambiguous labels return candidates", async () => {
    const c = ctx({
      nodes: [
        node("a", { label: "Reviewer Alpha", role: "QA" }),
        node("b", { label: "Reviewer Beta", role: "QA" }),
      ],
    });
    const r = await executeCompanyMediatorTool(
      "node_get",
      { label: "Reviewer" },
      c,
    );
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/Ambiguous|candidates/i);
  });

  it("context digest marks mission as seed and asks for requirements-first greets", () => {
    const digest = buildMediatorContextDigest(ctx());
    expect(digest).toMatch(/MISSION_STATE=PRESENT/);
    expect(digest).toMatch(/confirm before treating/i);
    expect(digest).toMatch(/MEDIATOR_HINT/);
    expect(digest).toMatch(/greetings/i);
    const empty = buildMediatorContextDigest(
      ctx({
        nodes: [node("input", { kind: "input", label: "Mission", output: "" })],
      }),
    );
    expect(empty).toMatch(/MISSION_STATE=EMPTY/);
  });
});
