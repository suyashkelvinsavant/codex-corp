import { MarkerType } from "@xyflow/react";
import { defaultPlatformCriteria } from "./completion-criteria";
import { DEFAULT_NODE_EFFORT, DEFAULT_NODE_MODEL_ID } from "./codex-models";
import { validateWorkflow } from "./graph";
import { kindPopColor } from "./kind-colors";
import type { FlowEdge, FlowNode, Kind } from "./model";
import { isSpecialistKind } from "./model";
import {
  bumpWorkflowVersion,
  getTemplate,
  listWorkflows,
  type WorkflowTemplate,
} from "./templates";
import {
  ensureSpecialistQuality,
  isWeakSpecialistPrompt,
} from "./specialist-defaults";
import { latestArchitectDashboardDigestPersisted } from "./dashboard-finance";
import type {
  DynamicToolSpecJson,
  ToolExecResult,
} from "./company-mediator-tools";

export const WORKFLOW_ARCHITECT_SYSTEM_PROMPT = `You are Byte, the top-level Codex Corp companion. You own the company workflow catalog, not a single company run.

Your job is to turn company requirements into robust multi-agent graphs and maintain them over time. Gather requirements before creating a graph: objective, inputs, outputs, constraints, approvals, tools, skills, and definition of done. Use tools for every catalog fact or mutation; never claim a workflow changed unless the tool succeeds.

## Specialist quality (mandatory)
You are responsible for every agent and creative node working at its best. For each specialist you create or patch:
- Write an extremely detailed system prompt (multi-section: mission, process, output contract, constraints) — never leave specialist prompts empty or one-line stubs.
- Customize tools (least-privilege) and skills per node for the role (e.g. Researcher: web search; Builder: shell + patch; Creative: image tools).
- Set a clear role label and description so operators understand the node.
- Prefer ≥120 characters of substantive prompt text; validation rejects weak placeholders.

If a DASHBOARD_FEEDBACK digest is present in context, use it to prefer lower-burn graphs, tighten high-cost specialists, and align designs with profitable workflows.

You have CRUD access to unlocked workflows. A locked workflow is programmatically read-only: never attempt to update, patch, repair, add/remove nodes or edges, or delete it. You may inspect, validate, open, or duplicate a locked workflow and edit the duplicate. If the operator insists on changing the original, ask them to disable its Byte lock in the workflow editor; never ask for or claim an override. For destructive deletion, explain the target and ask for explicit confirmation first. Prefer focused specialist nodes with precise prompts, least-privilege tools/skills, typed handoffs, human gates for irreversible actions, and a final output node. After every mutation sequence, call workflow_validate. Do not describe a workflow as ready while validation errors remain. Summarize exactly what changed and flag remaining risks. Do not run company workflows or implement product code.`;

export type ArchitectActions = {
  save: (workflow: WorkflowTemplate) => Promise<void> | void;
  remove: (id: string) => Promise<void> | void;
  open: (id: string) => void;
};

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  ...(Array.isArray(required) && required.length ? { required } : {}),
  additionalProperties: false,
});

export function workflowArchitectDynamicTools(): DynamicToolSpecJson[] {
  const nodeSchema = object(
    {
      id: { type: "string" },
      label: { type: "string" },
      role: { type: "string" },
      kind: { type: "string" },
      prompt: { type: "string" },
      description: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" } },
      model: {
        type: "string",
        description: "Required for agent and creative nodes",
      },
      effort: { type: "string" },
      requiresApproval: { type: "boolean" },
      cronExpression: { type: "string" },
      cronTimezone: { type: "string" },
      cronEnabled: { type: "boolean" },
      inputSchema: {
        type: "string",
        description: "JSON Schema encoded as a string",
      },
      outputSchema: {
        type: "string",
        description: "JSON Schema encoded as a string",
      },
      conditionRule: object(
        {
          sourceNodeId: { type: "string" },
          path: { type: "string" },
          operator: { type: "string" },
          value: {},
          trueBranch: { type: "string" },
          falseBranch: { type: "string" },
        },
        ["path", "operator", "trueBranch", "falseBranch"],
      ),
    },
    ["id", "label", "role", "kind"],
  );
  const edgeSchema = object(
    {
      source: { type: "string" },
      target: { type: "string" },
      edgeType: { type: "string" },
      condition: { type: "string" },
      maxRevisions: { type: "number" },
      mapping: { type: "object", additionalProperties: { type: "string" } },
    },
    ["source", "target"],
  );
  return [
    {
      type: "function",
      name: "workflow_list",
      description: "List every workflow and its graph size.",
      inputSchema: object({}),
    },
    {
      type: "function",
      name: "workflow_get",
      description:
        "Inspect a workflow including node prompts, tools, skills, and edges.",
      inputSchema: object({ id: { type: "string" } }, ["id"]),
    },
    {
      type: "function",
      name: "workflow_create",
      description:
        "Create a complete workflow graph. Nodes are specialist/control definitions; edges connect node ids.",
      inputSchema: object(
        {
          id: { type: "string", description: "Stable kebab-case id" },
          name: { type: "string" },
          description: { type: "string" },
          nodes: { type: "array", items: nodeSchema },
          edges: { type: "array", items: edgeSchema },
        },
        ["id", "name", "description", "nodes", "edges"],
      ),
    },
    {
      type: "function",
      name: "workflow_update",
      description:
        "Update workflow metadata or replace its nodes/edges. Get it first and preserve fields not being changed.",
      inputSchema: object(
        {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          nodes: { type: "array", items: { type: "object" } },
          edges: { type: "array", items: { type: "object" } },
        },
        ["id"],
      ),
    },
    {
      type: "function",
      name: "workflow_duplicate",
      description: "Duplicate a workflow under a new id and name.",
      inputSchema: object(
        {
          id: { type: "string" },
          newId: { type: "string" },
          newName: { type: "string" },
        },
        ["id", "newId", "newName"],
      ),
    },
    {
      type: "function",
      name: "workflow_delete",
      description: "Delete a workflow after explicit operator confirmation.",
      inputSchema: object(
        { id: { type: "string" }, confirmed: { type: "boolean" } },
        ["id", "confirmed"],
      ),
    },
    {
      type: "function",
      name: "workflow_validate",
      description:
        "Run the application's full executable-graph validator: required input/output, connectivity/reachability, node ids, specialist prompts/models, condition rules, schemas, edge contracts, bounded revisions, and cycles.",
      inputSchema: object({ id: { type: "string" } }, ["id"]),
    },
    {
      type: "function",
      name: "workflow_repair",
      description:
        "Repair deterministic graph defects (dangling/duplicate edges and duplicate node ids), then report any semantic issues that still need judgment. Set apply=false for a preview.",
      inputSchema: object(
        { id: { type: "string" }, apply: { type: "boolean" } },
        ["id"],
      ),
    },
    {
      type: "function",
      name: "workflow_patch_node",
      description:
        "Safely change one node's prompt, role, kind, tools, skills, model, effort, approval requirement, or description without replacing the rest of the graph.",
      inputSchema: object(
        {
          id: { type: "string" },
          nodeId: { type: "string" },
          patch: object({
            label: { type: "string" },
            role: { type: "string" },
            kind: { type: "string" },
            prompt: { type: "string" },
            description: { type: "string" },
            inputSchema: { type: "string" },
            outputSchema: { type: "string" },
            conditionRule: object({
              sourceNodeId: { type: "string" },
              path: { type: "string" },
              operator: { type: "string" },
              value: {},
              trueBranch: { type: "string" },
              falseBranch: { type: "string" },
            }),
            tools: { type: "array", items: { type: "string" } },
            skills: { type: "array", items: { type: "string" } },
            model: { type: "string" },
            effort: { type: "string" },
            requiresApproval: { type: "boolean" },
          }),
        },
        ["id", "nodeId", "patch"],
      ),
    },
    {
      type: "function",
      name: "workflow_add_node",
      description: "Add one configured node to an existing workflow.",
      inputSchema: object({ id: { type: "string" }, node: nodeSchema }, [
        "id",
        "node",
      ]),
    },
    {
      type: "function",
      name: "workflow_remove_node",
      description:
        "Remove a node and its connected edges after explicit confirmation.",
      inputSchema: object(
        {
          id: { type: "string" },
          nodeId: { type: "string" },
          confirmed: { type: "boolean" },
        },
        ["id", "nodeId", "confirmed"],
      ),
    },
    {
      type: "function",
      name: "workflow_add_edge",
      description: "Connect two existing workflow nodes.",
      inputSchema: object({ id: { type: "string" }, edge: edgeSchema }, [
        "id",
        "edge",
      ]),
    },
    {
      type: "function",
      name: "workflow_remove_edge",
      description: "Remove one edge by id.",
      inputSchema: object(
        { id: { type: "string" }, edgeId: { type: "string" } },
        ["id", "edgeId"],
      ),
    },
    {
      type: "function",
      name: "workflow_open_editor",
      description: "Open a workflow in the visual graph editor.",
      inputSchema: object({ id: { type: "string" } }, ["id"]),
    },
  ];
}

function slug(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
function makeNodes(rawNodes: any[]): FlowNode[] {
  return rawNodes.map((raw, index) => {
    if (raw?.data?.kind && raw?.position) {
      const cloned = structuredClone(raw) as FlowNode;
      if (isSpecialistKind(cloned.data.kind)) {
        const quality = ensureSpecialistQuality({
          kind: cloned.data.kind,
          role: cloned.data.role,
          label: cloned.data.label,
          prompt: cloned.data.prompt,
          tools: cloned.data.tools,
          skills: cloned.data.skills,
          description: cloned.data.description,
        });
        cloned.data = {
          ...cloned.data,
          prompt: quality.prompt,
          tools: quality.tools,
          skills: quality.skills,
          description: quality.description,
        };
      }
      return cloned;
    }
    const kind = (
      [
        "agent",
        "creative",
        "cron",
        "input",
        "approval",
        "condition",
        "merge",
        "output",
        "note",
      ].includes(raw.kind)
        ? raw.kind
        : "agent"
    ) as Kind;
    const role = raw.role || (kind === "creative" ? "Creative" : "Specialist");
    const label = raw.label || `Node ${index + 1}`;
    const quality = ensureSpecialistQuality({
      kind,
      role,
      label,
      prompt: raw.prompt || "",
      tools: raw.tools || [],
      skills: raw.skills || [],
      description: raw.description || "",
    });
    return {
      id: slug(raw.id) || `node-${index + 1}`,
      type: "corpNode",
      position: {
        x: 80 + (index % 4) * 310,
        y: 120 + Math.floor(index / 4) * 230,
      },
      data: {
        label,
        role,
        kind,
        status: kind === "input" ? "completed" : "idle",
        model:
          raw.model || (isSpecialistKind(kind) ? DEFAULT_NODE_MODEL_ID : ""),
        effort:
          raw.effort || (isSpecialistKind(kind) ? DEFAULT_NODE_EFFORT : "low"),
        tools: isSpecialistKind(kind) ? quality.tools : raw.tools || [],
        skills: isSpecialistKind(kind) ? quality.skills : raw.skills || [],
        prompt: isSpecialistKind(kind) ? quality.prompt : raw.prompt || "",
        description: isSpecialistKind(kind)
          ? quality.description
          : raw.description || "",
        inputSchema: raw.inputSchema,
        outputSchema: raw.outputSchema,
        conditionRule: raw.conditionRule,
        cronExpression: raw.cronExpression,
        cronTimezone: raw.cronTimezone,
        cronEnabled: raw.cronEnabled,
        duration: "—",
        tokens: 0,
        trace: ["Configured by Byte"],
        requiresApproval: Boolean(raw.requiresApproval),
        completionCriteria:
          kind === "agent" || kind === "creative"
            ? defaultPlatformCriteria()
            : undefined,
        color: kindPopColor(kind),
      },
    } satisfies FlowNode;
  });
}
function makeEdges(rawEdges: any[]): FlowEdge[] {
  return rawEdges.map((raw, index) => {
    if (raw?.data?.edgeType && raw?.id) return structuredClone(raw) as FlowEdge;
    return {
      id: `e-${slug(raw.source)}-${slug(raw.target)}-${index}`,
      source: slug(raw.source),
      target: slug(raw.target),
      type: "signalEdge",
      reconnectable: "target",
      interactionWidth: 24,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: "#52606d",
      },
      data: {
        edgeType: raw.edgeType || "standard",
        condition: raw.condition,
        maxRevisions: raw.maxRevisions,
        mapping: raw.mapping,
      },
    } as FlowEdge;
  });
}
function makeGraph(
  rawNodes: any[],
  rawEdges: any[],
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return { nodes: makeNodes(rawNodes), edges: makeEdges(rawEdges) };
}
function workflowProblems(workflow: WorkflowTemplate): string[] {
  const ids = new Set<string>();
  const problems: string[] = [];
  workflow.nodes.forEach((node) => {
    if (ids.has(node.id)) problems.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (
      isSpecialistKind(node.data.kind) &&
      isWeakSpecialistPrompt(node.data.prompt)
    ) {
      problems.push(
        `${node.id}: specialist needs a detailed system prompt (not empty/placeholder)`,
      );
    }
  });
  const edgeKeys = new Set<string>();
  workflow.edges.forEach((edge) => {
    if (!ids.has(edge.source) || !ids.has(edge.target))
      problems.push(`${edge.id}: missing endpoint`);
    const key = `${edge.source}|${edge.target}|${edge.data?.edgeType ?? "standard"}|${edge.data?.condition ?? ""}`;
    if (edgeKeys.has(key)) problems.push(`${edge.id}: duplicate edge`);
    edgeKeys.add(key);
  });
  validateWorkflow(workflow.nodes, workflow.edges).forEach((problem) =>
    problems.push(`${problem.id}: ${problem.message}`),
  );
  return problems;
}
function introducedWorkflowProblems(
  before: WorkflowTemplate,
  after: WorkflowTemplate,
): string[] {
  const existing = new Set(workflowProblems(before));
  return workflowProblems(after).filter((problem) => !existing.has(problem));
}
async function saveNext(actions: ArchitectActions, workflow: WorkflowTemplate) {
  const next = {
    ...workflow,
    version: bumpWorkflowVersion(workflow.version),
  };
  await actions.save(next);
  return next;
}

/** Optional dashboard digest for architect turns (host may append). */
export async function architectContextExtras(): Promise<string> {
  const digest = await latestArchitectDashboardDigestPersisted();
  return digest ? `\n\n${digest}` : "";
}
const ok = (value: unknown): ToolExecResult => ({
  success: true,
  text: JSON.stringify(value),
});
const fail = (error: string): ToolExecResult => ({
  success: false,
  text: JSON.stringify({ error }),
});

export async function executeWorkflowArchitectTool(
  name: string,
  raw: unknown,
  actions: ArchitectActions,
): Promise<ToolExecResult> {
  const args = (raw && typeof raw === "object" ? raw : {}) as any;
  try {
    if (name === "workflow_list")
      return ok(
        listWorkflows().map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          nodes: w.nodes.length,
          edges: w.edges.length,
          version: w.version,
          locked: Boolean(w.locked),
        })),
      );
    const id = String(args.id ?? "");
    const exists = listWorkflows().find((w) => w.id === id);
    if (name === "workflow_get")
      return exists ? ok(exists) : fail(`Workflow ${id} not found`);
    if (name === "workflow_create") {
      const nextId = slug(args.id);
      if (!nextId) return fail("A valid id is required");
      if (listWorkflows().some((w) => w.id === nextId))
        return fail(`Workflow ${nextId} already exists`);
      const graph = makeGraph(args.nodes || [], args.edges || []);
      const workflow = {
        id: nextId,
        name: String(args.name),
        description: String(args.description),
        version: "v0.1",
        ...graph,
      };
      const problems = workflowProblems(workflow);
      if (problems.length)
        return fail(`Workflow is invalid: ${problems.join("; ")}`);
      await actions.save(workflow);
      return ok({
        created: nextId,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
      });
    }
    if (!exists) return fail(`Workflow ${id} not found`);
    const nonMutating = new Set([
      "workflow_get",
      "workflow_validate",
      "workflow_open_editor",
      "workflow_duplicate",
    ]);
    if (exists.locked && !nonMutating.has(name))
      return fail(
        `Workflow ${id} is locked. Ask the user to disable the Byte lock in the workflow editor, or duplicate it and edit the duplicate.`,
      );
    if (name === "workflow_update") {
      const workflow = {
        ...exists,
        name: args.name ?? exists.name,
        description: args.description ?? exists.description,
        nodes: args.nodes
          ? makeNodes(args.nodes)
          : structuredClone(exists.nodes),
        edges: args.edges
          ? makeEdges(args.edges)
          : structuredClone(exists.edges),
      };
      const problems = introducedWorkflowProblems(exists, workflow);
      if (problems.length)
        return fail(
          `Update would leave an invalid workflow: ${problems.join("; ")}`,
        );
      const saved = await saveNext(actions, workflow);
      return ok({ updated: id, version: saved.version });
    }
    if (name === "workflow_duplicate") {
      const nextId = slug(args.newId);
      if (!nextId || listWorkflows().some((w) => w.id === nextId))
        return fail("New id is invalid or already exists");
      const workflow = structuredClone({
        ...exists,
        id: nextId,
        name: String(args.newName),
        version: "v0.1",
        locked: false,
        templateOrigin: undefined,
      });
      await actions.save(workflow);
      return ok({ duplicated: id, as: nextId });
    }
    if (name === "workflow_delete") {
      if (args.confirmed !== true)
        return fail("Explicit confirmation is required");
      await actions.remove(id);
      return ok({ deleted: id });
    }
    if (name === "workflow_open_editor") {
      actions.open(id);
      return ok({ opened: id });
    }
    if (name === "workflow_validate") {
      const problems = workflowProblems(exists);
      return ok({ valid: problems.length === 0, problems });
    }
    if (name === "workflow_patch_node") {
      const nodeIndex = exists.nodes.findIndex(
        (node) => node.id === String(args.nodeId),
      );
      if (nodeIndex < 0) return fail(`Node ${args.nodeId} not found`);
      const allowed = [
        "label",
        "role",
        "kind",
        "prompt",
        "description",
        "inputSchema",
        "outputSchema",
        "conditionRule",
        "tools",
        "skills",
        "model",
        "effort",
        "requiresApproval",
        "cronExpression",
        "cronTimezone",
        "cronEnabled",
      ];
      const patch = Object.fromEntries(
        Object.entries(args.patch ?? {}).filter(([key]) =>
          allowed.includes(key),
        ),
      );
      const nodes = structuredClone(exists.nodes);
      const nextKind =
        (patch.kind as Kind | undefined) ?? nodes[nodeIndex].data.kind;
      const mergedData = {
        ...nodes[nodeIndex].data,
        ...patch,
        kind: nextKind,
        ...(patch.kind ? { color: kindPopColor(nextKind) } : {}),
      };
      const quality = isSpecialistKind(nextKind)
        ? ensureSpecialistQuality({
            kind: nextKind,
            role: String(mergedData.role ?? nodes[nodeIndex].data.role),
            label: String(mergedData.label ?? nodes[nodeIndex].data.label),
            prompt: String(mergedData.prompt ?? ""),
            tools: Array.isArray(mergedData.tools)
              ? (mergedData.tools as string[])
              : nodes[nodeIndex].data.tools,
            skills: Array.isArray(mergedData.skills)
              ? (mergedData.skills as string[])
              : nodes[nodeIndex].data.skills,
            description: String(
              mergedData.description ?? nodes[nodeIndex].data.description ?? "",
            ),
          })
        : null;
      nodes[nodeIndex] = {
        ...nodes[nodeIndex],
        data: {
          ...mergedData,
          ...(quality
            ? {
                prompt: quality.prompt,
                tools: quality.tools,
                skills: quality.skills,
                description: quality.description,
              }
            : {}),
        },
      };
      const candidate = { ...exists, nodes };
      const problems = introducedWorkflowProblems(exists, candidate);
      if (problems.length)
        return fail(
          `Patch would leave an invalid workflow: ${problems.join("; ")}`,
        );
      const saved = await saveNext(actions, candidate);
      return ok({
        updated: id,
        nodeId: args.nodeId,
        fields: Object.keys(patch),
        version: saved.version,
      });
    }
    if (name === "workflow_add_node") {
      const [node] = makeNodes([args.node ?? {}]);
      if (exists.nodes.some((item) => item.id === node.id))
        return fail(`Node ${node.id} already exists`);
      const saved = await saveNext(actions, {
        ...exists,
        nodes: [...exists.nodes, node],
      });
      return ok({ updated: id, addedNode: node.id, version: saved.version });
    }
    if (name === "workflow_remove_node") {
      if (args.confirmed !== true)
        return fail("Explicit confirmation is required");
      const nodeId = String(args.nodeId);
      if (!exists.nodes.some((node) => node.id === nodeId))
        return fail(`Node ${nodeId} not found`);
      const saved = await saveNext(actions, {
        ...exists,
        nodes: exists.nodes.filter((node) => node.id !== nodeId),
        edges: exists.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      });
      return ok({ updated: id, removedNode: nodeId, version: saved.version });
    }
    if (name === "workflow_add_edge") {
      const [edge] = makeEdges([args.edge ?? {}]);
      const ids = new Set(exists.nodes.map((node) => node.id));
      if (!ids.has(edge.source) || !ids.has(edge.target))
        return fail("Both edge endpoints must exist");
      if (
        exists.edges.some(
          (item) =>
            item.source === edge.source &&
            item.target === edge.target &&
            item.data?.edgeType === edge.data?.edgeType &&
            item.data?.condition === edge.data?.condition,
        )
      )
        return fail("That edge already exists");
      const saved = await saveNext(actions, {
        ...exists,
        edges: [...exists.edges, edge],
      });
      return ok({ updated: id, addedEdge: edge.id, version: saved.version });
    }
    if (name === "workflow_remove_edge") {
      const edgeId = String(args.edgeId);
      if (!exists.edges.some((edge) => edge.id === edgeId))
        return fail(`Edge ${edgeId} not found`);
      const saved = await saveNext(actions, {
        ...exists,
        edges: exists.edges.filter((edge) => edge.id !== edgeId),
      });
      return ok({ updated: id, removedEdge: edgeId, version: saved.version });
    }
    if (name === "workflow_repair") {
      const seenNodes = new Set<string>();
      const nodes = exists.nodes.filter(
        (node) => !seenNodes.has(node.id) && Boolean(seenNodes.add(node.id)),
      );
      const ids = new Set(nodes.map((node) => node.id));
      const seenEdges = new Set<string>();
      const edges = exists.edges.filter((edge) => {
        const key = `${edge.source}|${edge.target}|${edge.data?.edgeType ?? "standard"}|${edge.data?.condition ?? ""}`;
        if (
          !ids.has(edge.source) ||
          !ids.has(edge.target) ||
          seenEdges.has(key)
        )
          return false;
        seenEdges.add(key);
        return true;
      });
      const candidate = { ...exists, nodes, edges };
      const before = workflowProblems(exists);
      const remaining = workflowProblems(candidate);
      const repaired = before.filter((problem) => !remaining.includes(problem));
      if (args.apply === false)
        return ok({ applied: false, repaired, remaining });
      const saved = await saveNext(actions, candidate);
      return ok({ applied: true, repaired, remaining, version: saved.version });
    }
    return fail(`Unknown tool: ${name}`);
  } catch (error) {
    return fail(String(error));
  }
}

export function buildArchitectContextDigest(): string {
  return JSON.stringify({
    role: "workflow-architect",
    catalog: listWorkflows().map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      nodes: w.nodes.length,
      edges: w.edges.length,
      locked: Boolean(w.locked),
    })),
  });
}
