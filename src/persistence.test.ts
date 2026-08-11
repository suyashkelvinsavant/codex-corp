import { describe, expect, it } from "vitest";
import {
  buildPersistedRunNodes,
  normalizeLoadedWorkflowState,
  parseRunRecords,
  parseWorkflowSnapshot,
  rehydrateRunRecord,
  serializeWorkflowSnapshot,
  shouldApplyAutoloadSnapshot,
  shouldAutosaveBeforeTemplateSwitch,
  shouldReplaceEdgesFromRun,
  templateSwitchBaselineEvents,
  WORKFLOW_SCHEMA_VERSION,
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
  it("restores workflow workspace ownership across five persisted payload shapes", () => {
    const graphJson = JSON.stringify({ nodes: [node("qa")], edges: [] });

    // Attack vector 1: current native record restores its selected workspace.
    expect(
      normalizeLoadedWorkflowState({
        graphJson,
        workspacePath: "C:\\workspaces\\coffee",
      }),
    ).toEqual({ graphJson, workspacePath: "C:\\workspaces\\coffee" });
    // Attack vector 2: legacy browser/raw graph values remain readable.
    expect(normalizeLoadedWorkflowState(graphJson)).toEqual({
      graphJson,
      workspacePath: null,
    });
    // Attack vector 3: blank native paths cannot masquerade as a workspace.
    expect(
      normalizeLoadedWorkflowState({ graphJson, workspacePath: "   " }),
    ).toEqual({ graphJson, workspacePath: null });
    // Attack vector 4: malformed graph payloads fail closed.
    expect(
      normalizeLoadedWorkflowState({ graphJson: 7, workspacePath: "C:\\x" }),
    ).toBeNull();
    // Attack vector 5: missing records remain missing.
    expect(normalizeLoadedWorkflowState(null)).toBeNull();
  });

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

  it("repairs a stale completed Mission brief seed without changing real mission state", () => {
    const seededInput = node("input", "input");
    seededInput.data.status = "completed";
    seededInput.data.output = "Describe the product request for the company.";
    const authoredInput = node("authored-input", "input");
    authoredInput.data.status = "completed";
    authoredInput.data.output = "Build a simple landing page.";

    const snapshot = parseWorkflowSnapshot(
      JSON.stringify({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [seededInput, authoredInput],
        edges: [],
      }),
    );

    expect(snapshot?.nodes[0].data.status).toBe("idle");
    expect(snapshot?.nodes[1].data.status).toBe("completed");
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
    expect(snapshot?.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(snapshot?.nodes[0].data.workspacePolicy).toBe("isolated");
    expect(snapshot?.nodes[0].data).not.toHaveProperty("memoryMode");
    expect(snapshot?.nodes[0].data).not.toHaveProperty("environmentVariables");
    expect(snapshot?.nodes[0].data).not.toHaveProperty("maxRevisions");
    expect(snapshot?.nodes[0].data.requiresApproval).toBe(false);
    expect(snapshot?.migrationNotices).toHaveLength(1);
    expect(snapshot?.edges[0].data?.maxRevisions).toBe(4);
  });

  it("preserves the durable approval gate in current snapshots", () => {
    const specialist = node("agent");
    specialist.data.requiresApproval = true;
    const snapshot = parseWorkflowSnapshot(
      JSON.stringify({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [specialist],
        edges: [],
      }),
    );
    expect(snapshot?.nodes[0].data.requiresApproval).toBe(true);
    expect(snapshot?.migrationNotices).toBeUndefined();
  });

  it("renames only the legacy default Delivery control during schema migration", () => {
    const legacyOutput = node("output", "output");
    Object.assign(legacyOutput.data, {
      label: "Delivery",
      role: "Control",
      model: "Collector",
    });
    const customOutput = node("custom-output", "output");
    Object.assign(customOutput.data, {
      label: "Publish to customer portal",
      role: "Custom release",
      model: "Collector",
    });

    const migrated = parseWorkflowSnapshot(
      JSON.stringify({
        schemaVersion: WORKFLOW_SCHEMA_VERSION - 1,
        nodes: [legacyOutput, customOutput],
        edges: [],
      }),
    );

    expect(migrated?.nodes[0].data).toMatchObject({
      label: "Release Bundle",
      role: "Verified handoff",
    });
    expect(migrated?.nodes[1].data).toMatchObject({
      label: "Publish to customer portal",
      role: "Custom release",
    });
    expect(migrated?.migrationNotices).toContain(
      "Renamed the default Delivery control to Release Bundle and clarified its verified handoff purpose.",
    );
  });

  it("repairs the affected Software Company policy across v2 and v4 saved snapshots", () => {
    const softwareNodes = [
      node("input", "input"),
      node("pm"),
      node("architect"),
      node("builder"),
      node("qa"),
      node("approval", "approval"),
      node("output", "output"),
    ];
    for (const specialist of softwareNodes.filter(
      (item) => item.data.kind === "agent",
    )) {
      specialist.data.approvalPolicy = "on-request";
      specialist.data.sandboxProfile = "workspace-write";
      specialist.data.workspacePolicy = "workflow";
    }
    softwareNodes.find((item) => item.id === "pm")!.data.packId =
      "product-manager";
    softwareNodes.find((item) => item.id === "architect")!.data.packId =
      "architect";
    softwareNodes.find((item) => item.id === "builder")!.data.packId =
      "frontend-engineer";
    softwareNodes.find((item) => item.id === "qa")!.data.packId = "qa-engineer";
    const edges = [
      {
        id: "e-in-pm",
        source: "input",
        target: "pm",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-pm-arch",
        source: "pm",
        target: "architect",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-arch-builder",
        source: "architect",
        target: "builder",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-builder-qa",
        source: "builder",
        target: "qa",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-qa-approval",
        source: "qa",
        target: "approval",
        data: { edgeType: "approval" as const },
      },
      {
        id: "e-approval-out",
        source: "approval",
        target: "output",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-qa-builder-rev",
        source: "qa",
        target: "builder",
        data: { edgeType: "revision" as const, maxRevisions: 2 },
      },
    ];
    for (const sourceVersion of [2, WORKFLOW_SCHEMA_VERSION]) {
      const migrated = parseWorkflowSnapshot(
        JSON.stringify({
          schemaVersion: sourceVersion,
          nodes: softwareNodes,
          edges,
        }),
      );
      const migratedBuilder = migrated?.nodes.find(
        (item) => item.id === "builder",
      );
      const migratedOthers = migrated?.nodes.filter(
        (item) =>
          item.data.kind === "agent" &&
          item.id !== "builder" &&
          item.id !== "release-coordinator",
      );
      expect(migratedBuilder?.data.packId).toBe("builder");
      expect(migratedBuilder?.data.approvalPolicy).toBe("never");
      expect(migratedBuilder?.data.sandboxProfile).toBe("danger-full-access");
      expect(
        migratedBuilder?.data.developerInstructions,
      ).toMatch(
        /do not ask for human approval|do not request human permission/i,
      );
      expect(
        migratedOthers?.every(
          (item) => item.data.approvalPolicy === "on-request",
        ),
      ).toBe(true);
      expect(
        migratedOthers?.every(
          (item) => item.data.sandboxProfile === "workspace-write",
        ),
      ).toBe(true);
      expect(migrated?.migrationNotices).toContain(
        "Upgraded the Software Company builder to autonomous build/test/package-install permissions and kept other specialists on-request.",
      );
    }

    // A current snapshot that already uses the new builder pack and autonomy
    // values must not be overwritten.
    const currentNodes: FlowNode[] = JSON.parse(
      JSON.stringify(softwareNodes),
    );
    const currentBuilderData = currentNodes.find(
      (item) => item.id === "builder",
    )!.data;
    currentBuilderData.packId = "builder";
    currentBuilderData.approvalPolicy = "never";
    currentBuilderData.sandboxProfile = "danger-full-access";
    currentBuilderData.tools = [
      "Workspace read",
      "Workspace write",
      "Shell",
      "Apply patch",
      "Network",
      "Build",
      "Test",
      "Package install",
    ];
    const current = parseWorkflowSnapshot(
      JSON.stringify({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: currentNodes,
        edges,
      }),
    );
    const currentBuilder = current?.nodes.find(
      (item) => item.id === "builder",
    );
    expect(currentBuilder?.data.packId).toBe("builder");
    expect(currentBuilder?.data.approvalPolicy).toBe("never");
    expect(currentBuilder?.data.sandboxProfile).toBe("danger-full-access");
    expect(current?.migrationNotices ?? []).not.toContain(
      "Upgraded the Software Company builder to autonomous build/test/package-install permissions and kept other specialists on-request.",
    );
  });

  it("migrates the old qa→approval→output shape to staged release nodes", () => {
    const legacyNodes = [
      node("input", "input"),
      node("pm"),
      node("architect"),
      node("builder"),
      node("qa"),
      node("approval", "approval"),
      node("output", "output"),
    ];
    for (const specialist of legacyNodes.filter(
      (item) => item.data.kind === "agent",
    )) {
      specialist.data.approvalPolicy = "on-request";
      specialist.data.sandboxProfile = "workspace-write";
      specialist.data.workspacePolicy = "workflow";
    }
    legacyNodes.find((item) => item.id === "builder")!.data.packId = "builder";
    legacyNodes.find((item) => item.id === "builder")!.data.approvalPolicy =
      "never";
    legacyNodes.find((item) => item.id === "builder")!.data.sandboxProfile =
      "danger-full-access";
    const legacyEdges = [
      {
        id: "e-in-pm",
        source: "input",
        target: "pm",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-pm-arch",
        source: "pm",
        target: "architect",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-arch-builder",
        source: "architect",
        target: "builder",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-builder-qa",
        source: "builder",
        target: "qa",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-qa-approval",
        source: "qa",
        target: "approval",
        data: { edgeType: "approval" as const },
      },
      {
        id: "e-approval-out",
        source: "approval",
        target: "output",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-qa-builder-rev",
        source: "qa",
        target: "builder",
        data: { edgeType: "revision" as const, maxRevisions: 2 },
      },
    ];
    const migrated = parseWorkflowSnapshot(
      JSON.stringify({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: legacyNodes,
        edges: legacyEdges,
      }),
    );
    expect(migrated?.nodes.map((n) => n.id)).toContain("release-coordinator");
    expect(migrated?.nodes.map((n) => n.id)).toContain("demo");
    expect(migrated?.nodes.map((n) => n.id)).toContain("release-commit");
    expect(migrated?.nodes.map((n) => n.id)).toContain("publish-approval");
    expect(migrated?.nodes.map((n) => n.id)).not.toContain("approval");
    const edgeIds = migrated?.edges.map((e) => e.id) ?? [];
    expect(edgeIds).toContain("e-qa-release-coordinator");
    expect(edgeIds).toContain("e-release-coordinator-demo");
    expect(edgeIds).toContain("e-demo-release-commit");
    expect(edgeIds).toContain("e-release-commit-publish");
    expect(edgeIds).toContain("e-publish-output");
    expect(edgeIds).not.toContain("e-qa-approval");
    expect(edgeIds).not.toContain("e-approval-out");
    expect(migrated?.migrationNotices).toContain(
      "Upgraded the Software Company release flow to staged AI-mediated release: Release Coordinator → Demo → Release commit → Publish approval.",
    );
  });

  it("does not migrate a snapshot that already has release-coordinator", () => {
    const nodesWithCoordinator = [
      node("input", "input"),
      node("pm"),
      node("architect"),
      node("builder"),
      node("qa"),
      node("output", "output"),
      {
        id: "release-coordinator",
        type: "default" as const,
        position: { x: 0, y: 600 },
        data: {
          kind: "agent" as const,
          label: "Release Coordinator",
          packId: "release-coordinator",
          role: "Release Coordinator",
          status: "idle" as const,
          sandboxProfile: "read-only" as const,
          approvalPolicy: "never" as const,
          workspacePolicy: "workflow" as const,
        },
      },
    ];
    for (const specialist of nodesWithCoordinator.filter(
      (item) => item.data.kind === "agent" && item.id !== "release-coordinator",
    )) {
      specialist.data.approvalPolicy = "on-request";
      specialist.data.sandboxProfile = "workspace-write";
      specialist.data.workspacePolicy = "workflow";
    }
    nodesWithCoordinator.find((item) => item.id === "builder")!.data.packId =
      "builder";
    nodesWithCoordinator.find((item) => item.id === "builder")!.data.approvalPolicy =
      "never";
    nodesWithCoordinator.find((item) => item.id === "builder")!.data.sandboxProfile =
      "danger-full-access";
    const edgesWithCoordinator = [
      {
        id: "e-in-pm",
        source: "input",
        target: "pm",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-pm-arch",
        source: "pm",
        target: "architect",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-arch-builder",
        source: "architect",
        target: "builder",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-builder-qa",
        source: "builder",
        target: "qa",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-qa-release-coordinator",
        source: "qa",
        target: "release-coordinator",
        data: { edgeType: "standard" as const },
      },
      {
        id: "e-release-coordinator-output",
        source: "release-coordinator",
        target: "output",
        data: { edgeType: "standard" as const },
      },
    ];
    const migrated = parseWorkflowSnapshot(
      JSON.stringify({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: nodesWithCoordinator,
        edges: edgesWithCoordinator,
      }),
    );
    expect(migrated?.migrationNotices ?? []).not.toContain(
      "Upgraded the Software Company release flow to staged AI-mediated release: Release Coordinator → Demo → Release commit → Publish approval.",
    );
  });

  it("repairs persisted role skill hints without dropping explicit connector selections", () => {
    const specialist = node("product-manager");
    Object.assign(specialist.data, {
      packId: "product-manager",
      skills: ["product-spec", "installed-skill"],
    });
    const snapshot = parseWorkflowSnapshot(
      JSON.stringify({ schemaVersion: 2, nodes: [specialist], edges: [] }),
    );
    expect(snapshot?.nodes[0].data.skills).toEqual(["installed-skill"]);
    expect(snapshot?.migrationNotices).toEqual([
      "Removed obsolete role skill hints from saved specialists; connector skills must be selected from the live workspace inventory.",
    ]);
  });

  it("round-trips current-schema connector selections across five adversarial shapes", () => {
    const cases = [
      // Attack vector 1: an installed skill may intentionally share one pack hint.
      { packId: "product-manager", skills: ["product-spec"] },
      // Attack vector 2: a hint collision must not remove siblings or reorder them.
      {
        packId: "product-manager",
        skills: ["product-spec", "installed-skill"],
      },
      // Attack vector 3: preserve multiple selections that all match role hints.
      {
        packId: "frontend-engineer",
        skills: ["frontend-design", "react"],
      },
      // Attack vector 4: unknown packs still preserve explicit selections.
      { packId: "workspace-pack", skills: ["product-spec"] },
      // Attack vector 5: an explicitly empty selection remains empty.
      { packId: "product-manager", skills: [] },
    ];

    for (const testCase of cases) {
      const specialist = node(testCase.packId);
      Object.assign(specialist.data, testCase);
      const snapshot = parseWorkflowSnapshot(
        JSON.stringify({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [specialist],
          edges: [],
        }),
      );
      expect(snapshot?.nodes[0].data.skills).toEqual(testCase.skills);
      expect(snapshot?.migrationNotices).toBeUndefined();
    }
  });

  describe("missing revision-limit repair", () => {
    const parseEdge = (data: Record<string, unknown>) =>
      parseWorkflowSnapshot(
        JSON.stringify({
          schemaVersion: 2,
          nodes: [node("agent")],
          edges: [
            {
              id: "revision",
              source: "review",
              target: "agent",
              data,
            },
          ],
        }),
      );

    it("backfills the limit omitted by affected template instances", () => {
      const snapshot = parseEdge({ edgeType: "revision" });
      expect(snapshot?.edges[0].data?.maxRevisions).toBe(2);
      expect(snapshot?.migrationNotices).toContain(
        "Added the missing revision limit to an affected saved workflow.",
      );
    });

    it("preserves an explicit positive revision limit", () => {
      expect(
        parseEdge({ edgeType: "revision", maxRevisions: 7 })?.edges[0].data
          ?.maxRevisions,
      ).toBe(7);
    });

    it("does not hide an explicitly invalid zero limit", () => {
      expect(
        parseEdge({ edgeType: "revision", maxRevisions: 0 })?.edges[0].data
          ?.maxRevisions,
      ).toBe(0);
    });

    it("does not reinterpret an explicit null limit as the factory omission", () => {
      expect(
        parseEdge({ edgeType: "revision", maxRevisions: null })?.edges[0].data
          ?.maxRevisions,
      ).toBeNull();
    });

    it("does not add a revision limit to standard edges", () => {
      expect(
        parseEdge({ edgeType: "standard" })?.edges[0].data,
      ).not.toHaveProperty("maxRevisions");
    });
  });

  it("serializes the current schema and rejects unknown future versions", () => {
    const raw = serializeWorkflowSnapshot([node("agent")], []);
    expect(JSON.parse(raw).schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(
      parseWorkflowSnapshot(
        JSON.stringify({
          schemaVersion: WORKFLOW_SCHEMA_VERSION + 1,
          nodes: [node("agent")],
          edges: [],
        }),
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
    expect(rehydrated.deliveryStatus).toBe("pending");
    expect(
      rehydrated.nodes?.find((n) => n.id === "builder")?.data.structuredOutput,
    ).toEqual({ modules: ["x"] });
  });

  it("derives a trusted delivery status from the run inspector path (P5)", () => {
    const outputNode = {
      id: "output",
      type: "corpNode",
      position: { x: 0, y: 0 },
      data: {
        label: "output",
        role: "Verified handoff",
        kind: "output" as const,
        status: "completed",
        structuredOutput: {
          status: "success",
          approvedArtifacts: [
            {
              artifactKey: "builder::0::App.tsx",
              contentHash: "sha256:abc",
              sourceNodeId: "builder",
              name: "App.tsx",
              hostOrdinal: 0,
            },
          ],
          liveArtifactRefs: [
            {
              artifactKey: "builder::0::App.tsx",
              contentHash: "sha256:abc",
              sourceNodeId: "builder",
              name: "App.tsx",
              hostOrdinal: 0,
            },
          ],
          verificationSummary: [
            {
              results: [
                {
                  id: "cmd-1",
                  kind: "command",
                  passed: true,
                  enforcement: "required",
                  source: "runtime",
                },
              ],
              passBitOwner: "runtime",
            },
          ],
        },
      },
    };
    const record: RunRecord = {
      id: "run-trusted",
      workflowId: "software-company",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventsJson: "[]",
      nodesJson: JSON.stringify([outputNode]),
      edgesJson: "[]",
    };
    expect(rehydrateRunRecord(record).deliveryStatus).toBe("success");
  });

  it("never contradicts a failed run in the inspector path (P5)", () => {
    // Even with a stale "success-looking" bundle snapshot, a failed run must
    // resolve to Delivery failed — fail closed.
    const staleBundle = {
      id: "output",
      type: "corpNode",
      position: { x: 0, y: 0 },
      data: {
        label: "output",
        role: "Verified handoff",
        kind: "output" as const,
        status: "failed",
        structuredOutput: {
          status: "success",
          approvedArtifacts: [],
          liveArtifactRefs: [],
          verificationSummary: [],
        },
      },
    };
    const record: RunRecord = {
      id: "run-failed",
      workflowId: "software-company",
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventsJson: "[]",
      nodesJson: JSON.stringify([staleBundle]),
      edgesJson: "[]",
    };
    expect(rehydrateRunRecord(record).deliveryStatus).toBe("failed");
  });

  it("flags a stale pair-compare bundle in the inspector path (P5)", () => {
    const stale = {
      id: "output",
      type: "corpNode",
      position: { x: 0, y: 0 },
      data: {
        label: "output",
        role: "Verified handoff",
        kind: "output",
        status: "completed",
        structuredOutput: {
          status: "success",
          approvedArtifacts: [
            {
              artifactKey: "builder::0::App.tsx",
              contentHash: "sha256:approved",
              sourceNodeId: "builder",
              name: "App.tsx",
              hostOrdinal: 0,
            },
          ],
          liveArtifactRefs: [
            {
              artifactKey: "builder::0::App.tsx",
              contentHash: "sha256:stale",
              sourceNodeId: "builder",
              name: "App.tsx",
              hostOrdinal: 0,
            },
          ],
          verificationSummary: [
            {
              results: [
                {
                  id: "cmd-1",
                  kind: "command",
                  passed: true,
                  enforcement: "required",
                  source: "runtime",
                },
              ],
              passBitOwner: "runtime",
            },
          ],
        },
      },
    };
    const record: RunRecord = {
      id: "run-stale",
      workflowId: "software-company",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventsJson: "[]",
      nodesJson: JSON.stringify([stale]),
      edgesJson: "[]",
    };
    expect(rehydrateRunRecord(record).deliveryStatus).toBe("failed");
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
