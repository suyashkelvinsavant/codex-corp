import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeWorkflowArchitectTool,
  workflowArchitectDynamicTools,
} from "./workflow-architect-tools";
import { saveCustomWorkflow, type WorkflowTemplate } from "./templates";
import { makeTestWorkflow } from "./test-workflow-fixture";

describe("workflow architect tools", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
    saveCustomWorkflow(makeTestWorkflow());
  });

  afterEach(() => vi.unstubAllGlobals());
  it("exposes catalog CRUD, targeted graph editing, validation, and repair", () => {
    const names = workflowArchitectDynamicTools().map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "workflow_list",
        "workflow_get",
        "workflow_create",
        "workflow_update",
        "workflow_duplicate",
        "workflow_delete",
        "workflow_patch_node",
        "workflow_add_node",
        "workflow_remove_node",
        "workflow_add_edge",
        "workflow_remove_edge",
        "workflow_validate",
        "workflow_repair",
        "workflow_open_editor",
        "workflow_node_experience",
      ]),
    );
  });

  it("exposes sandbox, approval, and workspace policy in architect tool schemas", () => {
    const tools = workflowArchitectDynamicTools();
    const create = tools.find((tool) => tool.name === "workflow_create")!;
    const add = tools.find((tool) => tool.name === "workflow_add_node")!;
    const patch = tools.find((tool) => tool.name === "workflow_patch_node")!;
    const createNodeProps = (create.inputSchema as any).properties.nodes.items
      .properties;
    const addNodeProps = (add.inputSchema as any).properties.node.properties;
    const patchProps = (patch.inputSchema as any).properties.patch.properties;

    for (const props of [createNodeProps, addNodeProps, patchProps]) {
      expect(props).toHaveProperty("sandboxProfile");
      expect(props).toHaveProperty("approvalPolicy");
      expect(props).toHaveProperty("workspacePolicy");
      expect(props.sandboxProfile.enum).toEqual([
        "read-only",
        "workspace-write",
        "danger-full-access",
      ]);
      expect(props.approvalPolicy.enum).toEqual([
        "on-request",
        "untrusted",
        "never",
      ]);
      expect(props.workspacePolicy.enum).toEqual(["isolated", "workflow"]);
    }
  });

  it("preserves the untouched graph when updating workflow metadata", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_update",
      { id: "software-company", description: "Updated by the architect" },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    expect(saved?.description).toBe("Updated by the architect");
    expect(saved?.version).toBe("v0.7");
    expect(
      saved?.nodes.find((node) => node.id === "builder")?.data.prompt.length,
    ).toBeGreaterThan(100);
    expect(
      saved?.nodes.find((node) => node.id === "builder")?.data.tools.length,
    ).toBeGreaterThan(0);
    expect(
      saved?.edges.find((edge) => edge.id === "e-reviewer-builder")?.data
        ?.edgeType,
    ).toBe("revision");
  });

  it("patches one specialist without replacing its other configuration", async () => {
    let saved: WorkflowTemplate | undefined;
    const detailed = `You are the Frontend Engineer builder for this company.

Mission
- Implement only the approved file plan from upstream design and architecture.

Process
1. Read the approved plan and mission constraints.
2. Apply the smallest code change set that satisfies acceptance criteria.
3. Report residual risks without inventing scope.

Output contract
- Structured status, summary, data, and code artifacts for the reviewer.`;
    const result = await executeWorkflowArchitectTool(
      "workflow_patch_node",
      {
        id: "software-company",
        nodeId: "builder",
        patch: {
          prompt: detailed,
          skills: ["frontend-design"],
        },
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    const builder = saved?.nodes.find((node) => node.id === "builder");
    expect(builder?.data.prompt).toBe(detailed);
    expect(builder?.data.skills).toEqual(["frontend-design"]);
    expect(builder?.data.tools.length).toBeGreaterThan(0);
    expect(builder?.data.role).toBe("Frontend Engineer");
  });

  it("normalizes weak specialist patches via ensureSpecialistQuality", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_patch_node",
      {
        id: "software-company",
        nodeId: "builder",
        patch: {
          prompt: "todo",
          tools: [],
          skills: [],
        },
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );
    expect(result.success).toBe(true);
    const builder = saved?.nodes.find((node) => node.id === "builder");
    expect(builder?.data.prompt.length).toBeGreaterThan(120);
    expect(builder?.data.tools.length).toBeGreaterThan(0);
    expect(builder?.data.prompt.toLowerCase()).not.toBe("todo");
  });

  it("defaults newly added specialist nodes to GPT-5.6 Luna medium", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_add_node",
      {
        id: "software-company",
        node: {
          id: "researcher-2",
          label: "Researcher 2",
          role: "Researcher",
          kind: "agent",
          prompt:
            "Research the assigned question, verify claims against primary sources, document uncertainty, and return concise evidence with source attribution for downstream specialists.",
        },
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    const node = saved?.nodes.find((item) => item.id === "researcher-2");
    expect(node?.data.model).toBe("gpt-5.6-luna");
    expect(node?.data.effort).toBe("medium");
  });

  it("propagates pack policy fields when adding a Builder specialist", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_add_node",
      {
        id: "software-company",
        node: {
          id: "builder-2",
          label: "Builder 2",
          role: "Builder",
          kind: "agent",
          prompt:
            "Implement the approved frontend, run the build, and verify with tests.",
        },
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    const node = saved?.nodes.find((item) => item.id === "builder-2");
    expect(node?.data.sandboxProfile).toBe("danger-full-access");
    expect(node?.data.approvalPolicy).toBe("never");
    expect(node?.data.workspacePolicy).toBe("workflow");
  });

  it("preserves explicit sandbox, approval, and workspace policy when adding a node", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_add_node",
      {
        id: "software-company",
        node: {
          id: "builder-2",
          label: "Builder 2",
          role: "Builder",
          kind: "agent",
          model: "gpt-5",
          prompt: "Implement and verify.",
          sandboxProfile: "workspace-write",
          approvalPolicy: "on-request",
          workspacePolicy: "isolated",
        },
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    const node = saved?.nodes.find((item) => item.id === "builder-2");
    expect(node?.data.sandboxProfile).toBe("workspace-write");
    expect(node?.data.approvalPolicy).toBe("on-request");
    expect(node?.data.workspacePolicy).toBe("isolated");
  });

  it("preserves explicit sandbox, approval, and workspace policy when creating a workflow", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_create",
      {
        id: "policy-graph",
        name: "Policy graph",
        description: "Tests policy preservation",
        nodes: [
          {
            id: "in",
            label: "Mission brief",
            role: "Control",
            kind: "input",
          },
          {
            id: "b",
            label: "Builder",
            role: "Builder",
            kind: "agent",
            model: "gpt-5",
            prompt: "Implement the approved design, run tests, and build.",
            sandboxProfile: "workspace-write",
            approvalPolicy: "on-request",
            workspacePolicy: "isolated",
          },
          {
            id: "out",
            label: "Release",
            role: "Control",
            kind: "output",
          },
        ],
        edges: [
          { source: "in", target: "b" },
          { source: "b", target: "out" },
        ],
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    const builder = saved?.nodes.find((item) => item.id === "b");
    expect(builder?.data.sandboxProfile).toBe("workspace-write");
    expect(builder?.data.approvalPolicy).toBe("on-request");
    expect(builder?.data.workspacePolicy).toBe("isolated");
  });

  it("allows the architect to patch sandbox, approval, and workspace policy", async () => {
    let saved: WorkflowTemplate | undefined;
    const result = await executeWorkflowArchitectTool(
      "workflow_patch_node",
      {
        id: "software-company",
        nodeId: "builder",
        patch: {
          sandboxProfile: "danger-full-access",
          approvalPolicy: "never",
          workspacePolicy: "workflow",
        },
      },
      {
        save: (workflow) => {
          saved = workflow;
        },
        remove: vi.fn(),
        open: vi.fn(),
      },
    );

    expect(result.success).toBe(true);
    const builder = saved?.nodes.find((node) => node.id === "builder");
    expect(builder?.data.sandboxProfile).toBe("danger-full-access");
    expect(builder?.data.approvalPolicy).toBe("never");
    expect(builder?.data.workspacePolicy).toBe("workflow");
  });

  it("requires confirmation before deleting a workflow or node", async () => {
    const actions = { save: vi.fn(), remove: vi.fn(), open: vi.fn() };
    const workflow = await executeWorkflowArchitectTool(
      "workflow_delete",
      { id: "software-company", confirmed: false },
      actions,
    );
    const node = await executeWorkflowArchitectTool(
      "workflow_remove_node",
      { id: "software-company", nodeId: "builder", confirmed: false },
      actions,
    );

    expect(workflow.success).toBe(false);
    expect(node.success).toBe(false);
    expect(actions.remove).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("rejects a newly authored graph that fails the full executable validator", async () => {
    const actions = { save: vi.fn(), remove: vi.fn(), open: vi.fn() };
    const result = await executeWorkflowArchitectTool(
      "workflow_create",
      {
        id: "invalid-architect-graph",
        name: "Invalid graph",
        description: "Missing an input and output",
        nodes: [
          {
            id: "worker",
            label: "Worker",
            role: "Specialist",
            kind: "agent",
            prompt: "Do the work.",
            model: "gpt-5",
          },
        ],
        edges: [],
      },
      actions,
    );

    expect(result.success).toBe(false);
    expect(result.text).toMatch(/missing-input/);
    expect(result.text).toMatch(/missing-output/);
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("returns full validator findings through workflow_validate", async () => {
    const result = await executeWorkflowArchitectTool(
      "workflow_validate",
      { id: "software-company" },
      { save: vi.fn(), remove: vi.fn(), open: vi.fn() },
    );

    expect(result.success).toBe(true);
    const report = JSON.parse(result.text) as {
      valid: boolean;
      problems: string[];
    };
    expect(report.valid).toBe(false);
    expect(
      report.problems.some((problem) => problem.startsWith("model-")),
    ).toBe(true);
  });

  it("blocks Architect edits to locked workflows but allows duplication", async () => {
    const locked = { ...makeTestWorkflow(), locked: true };
    saveCustomWorkflow(locked);
    const actions = { save: vi.fn(), remove: vi.fn(), open: vi.fn() };
    const update = await executeWorkflowArchitectTool(
      "workflow_patch_node",
      { id: locked.id, nodeId: "builder", patch: { prompt: "Override" } },
      actions,
    );
    expect(update.success).toBe(false);
    expect(update.text).toMatch(/disable the Byte lock/i);
    expect(actions.save).not.toHaveBeenCalled();

    const duplicate = await executeWorkflowArchitectTool(
      "workflow_duplicate",
      { id: locked.id, newId: "safe-copy", newName: "Safe copy" },
      actions,
    );
    expect(duplicate.success).toBe(true);
    expect(actions.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "safe-copy", locked: false }),
    );
  });
});
