import { describe, expect, it } from "vitest";
import {
  buildPersistedRunNodes,
  parseRunRecords,
  parseWorkflowSnapshot,
  rehydrateRunRecord,
  serializeWorkflowSnapshot,
  shouldApplyAutoloadSnapshot,
  shouldAutosaveBeforeTemplateSwitch,
  shouldReplaceEdgesFromRun,
  templateSwitchBaselineEvents,
} from "./persistence";
import type { FlowNode, Kind, RunRecord } from "./model";

const node = (id: string, kind: Kind = "agent"): FlowNode => ({
  id,
  type: "corpNode",
  position: { x: 0, y: 0 },
  data: {
    label: id,
    role: id,
    kind,
    status: "queued",
    model: "gpt-5.6-luna",
    effort: "low",
    tools: [],
    prompt: "p",
    description: "",
    duration: "—",
    tokens: 0,
    trace: ["Ready"],
    color: "#fff",
  },
});

describe("persistence helpers", () => {
  it("parses valid workflow snapshots and rejects garbage", () => {
    const good = parseWorkflowSnapshot(
      JSON.stringify({
        nodes: [node("input", "input")],
        edges: [],
      }),
    );
    expect(good?.nodes).toHaveLength(1);
    expect(parseWorkflowSnapshot(null)).toBeNull();
    expect(parseWorkflowSnapshot("{")).toBeNull();
    expect(
      parseWorkflowSnapshot(JSON.stringify({ nodes: [], edges: [] })),
    ).toBeNull();
  });

  it("normalizes legacy specialist settings without changing revision edges", () => {
    const legacy = node("agent");
    Object.assign(legacy.data, {
      memoryMode: "persistent",
      environmentVariables: ["SECRET"],
      maxRevisions: 9,
      workspacePolicy: "custom",
      requiresApproval: true,
    });
    const snapshot = parseWorkflowSnapshot(
      JSON.stringify({
        nodes: [legacy],
        edges: [
          {
            id: "revision",
            source: "review",
            target: "agent",
            data: { edgeType: "revision", maxRevisions: 4 },
          },
        ],
      }),
    );
    expect(snapshot?.schemaVersion).toBe(2);
    expect(snapshot?.nodes[0].data.workspacePolicy).toBe("isolated");
    expect(snapshot?.nodes[0].data).not.toHaveProperty("memoryMode");
    expect(snapshot?.nodes[0].data).not.toHaveProperty("environmentVariables");
    expect(snapshot?.nodes[0].data).not.toHaveProperty("maxRevisions");
    expect(snapshot?.nodes[0].data.requiresApproval).toBe(false);
    expect(snapshot?.migrationNotices).toHaveLength(1);
    expect(snapshot?.edges[0].data?.maxRevisions).toBe(4);
  });

  it("preserves the durable approval gate in schema-version 2 snapshots", () => {
    const specialist = node("agent");
    specialist.data.requiresApproval = true;
    const snapshot = parseWorkflowSnapshot(
      JSON.stringify({ schemaVersion: 2, nodes: [specialist], edges: [] }),
    );
    expect(snapshot?.nodes[0].data.requiresApproval).toBe(true);
    expect(snapshot?.migrationNotices).toBeUndefined();
  });

  it("serializes current snapshots as v2 and rejects unknown future versions", () => {
    const raw = serializeWorkflowSnapshot([node("agent")], []);
    expect(JSON.parse(raw).schemaVersion).toBe(2);
    expect(
      parseWorkflowSnapshot(
        JSON.stringify({ schemaVersion: 3, nodes: [node("agent")], edges: [] }),
      ),
    ).toBeNull();
  });

  it("builds persisted run nodes with statuses, structured data, and artifacts", () => {
    const base = [
      node("input", "input"),
      node("builder"),
      node("output", "output"),
    ];
    const outputs = {
      input: {
        summary: "Mission text",
        data: { isolated: true },
        artifacts: [],
      },
      builder: {
        summary: "Built app",
        data: { modules: ["CaptureShell"] },
        artifacts: [
          {
            id: "a1",
            name: "app-shell.tsx",
            kind: "code" as const,
            content: "export function CaptureShell() {}",
          },
        ],
        threadId: "019f-live-builder-thread",
      },
      output: {
        summary: "Delivery ready",
        data: { schemaVersion: "codex-corp.delivery.v1" },
        artifacts: [
          {
            id: "delivery-bundle",
            name: "delivery-bundle.json",
            kind: "json" as const,
            content: JSON.stringify({ mission: "x", specialistHandoffs: [1] }),
          },
        ],
      },
    };
    const completed = new Set(["input", "builder", "output"]);
    const snapshot = buildPersistedRunNodes(
      base,
      outputs,
      completed,
      new Set(),
    );
    const byId = Object.fromEntries(snapshot.map((n) => [n.id, n]));
    expect(byId.builder.data.status).toBe("completed");
    expect(byId.builder.data.output).toBe("Built app");
    expect(byId.builder.data.structuredOutput).toEqual({
      modules: ["CaptureShell"],
    });
    expect(byId.builder.data.artifacts?.[0]?.name).toBe("app-shell.tsx");
    expect(byId.output.data.artifacts?.[0]?.content).toContain(
      "specialistHandoffs",
    );
    expect(byId.builder.data.threadId).toBe("019f-live-builder-thread");
  });

  it("rehydrates run records including delivery artifact detection", () => {
    const nodes = buildPersistedRunNodes(
      [node("output", "output"), node("builder")],
      {
        output: {
          summary: "done",
          data: { ok: true },
          artifacts: [
            {
              id: "d",
              name: "delivery-bundle.json",
              kind: "json",
              content:
                '{"schemaVersion":"codex-corp.delivery.v1","mission":"m"}',
            },
          ],
        },
        builder: {
          summary: "built",
          data: { modules: ["x"] },
          artifacts: [],
        },
      },
      new Set(["output", "builder"]),
      new Set(),
    );
    const record: RunRecord = {
      id: "run-1",
      workflowId: "software-company",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventsJson: JSON.stringify([
        { id: "e1", at: "t", type: "run.completed", message: "done" },
      ]),
      nodesJson: JSON.stringify(nodes),
      edgesJson: JSON.stringify([]),
    };
    const rehydrated = rehydrateRunRecord(record);
    expect(rehydrated.events).toHaveLength(1);
    expect(rehydrated.nodes).toHaveLength(2);
    expect(rehydrated.deliveryArtifactPresent).toBe(true);
    expect(
      rehydrated.nodes?.find((n) => n.id === "builder")?.data.structuredOutput,
    ).toEqual({ modules: ["x"] });
  });

  it("normalizes run history arrays from localStorage JSON", () => {
    const raw = JSON.stringify([
      {
        id: "abc",
        workflowId: "software-company",
        status: "completed",
        createdAt: "t",
        eventsJson: "[]",
        nodesJson: "[]",
      },
      { not: "a run" },
    ]);
    const records = parseRunRecords(raw);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("abc");
    expect(parseRunRecords("nope")).toEqual([]);
  });

  it("applies auto-load only when the user has not mutated the canvas", () => {
    expect(shouldApplyAutoloadSnapshot(false)).toBe(true);
    expect(shouldApplyAutoloadSnapshot(true)).toBe(false);
  });

  it("distinguishes missing edges from an explicit empty edge list", () => {
    expect(shouldReplaceEdgesFromRun(null)).toBe(false);
    expect(shouldReplaceEdgesFromRun(undefined)).toBe(false);
    expect(shouldReplaceEdgesFromRun([])).toBe(true);
    expect(shouldReplaceEdgesFromRun([{ id: "e1" } as never])).toBe(true);

    const oldRecord: RunRecord = {
      id: "legacy",
      workflowId: "software-company",
      status: "completed",
      createdAt: "t",
      eventsJson: JSON.stringify([
        { id: "e", at: "t", type: "run.completed", message: "old" },
      ]),
      // no nodesJson / edgesJson — pre-increment browser records
    };
    const legacy = rehydrateRunRecord(oldRecord);
    expect(legacy.events).toHaveLength(1);
    expect(legacy.nodes).toBeNull();
    expect(legacy.edges).toBeNull();
    expect(shouldReplaceEdgesFromRun(legacy.edges)).toBe(false);
    expect(legacy.deliveryArtifactPresent).toBe(false);

    const emptyEdges = rehydrateRunRecord({
      ...oldRecord,
      id: "empty-edges",
      nodesJson: JSON.stringify([node("output", "output")]),
      edgesJson: "[]",
    });
    expect(emptyEdges.edges).toEqual([]);
    expect(shouldReplaceEdgesFromRun(emptyEdges.edges)).toBe(true);
  });

  it("autosaves only when leaving a different idle template", () => {
    expect(
      shouldAutosaveBeforeTemplateSwitch(
        "software-company",
        "idea-validation",
        false,
      ),
    ).toBe(true);
    expect(
      shouldAutosaveBeforeTemplateSwitch(
        "software-company",
        "software-company",
        false,
      ),
    ).toBe(false);
    expect(
      shouldAutosaveBeforeTemplateSwitch(
        "software-company",
        "idea-validation",
        true,
      ),
    ).toBe(false);
  });

  it("builds a clean timeline baseline for template switches", () => {
    const baseline = templateSwitchBaselineEvents(
      "Conditional launch review",
      "t0",
    );
    expect(baseline).toHaveLength(1);
    expect(baseline[0].type).toBe("workflow.template");
    expect(baseline[0].message).toContain("Conditional launch review");
    expect(baseline.some((e) => e.type === "run.completed")).toBe(false);
  });
});
