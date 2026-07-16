import type { FlowEdge, FlowNode } from "./model";

export const DEFAULT_TEMPLATE_ID = "empty-draft";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  version: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Product templates are explicit; ordinary saved workflows stay out of this view. */
  templateOrigin?: "built-in" | "user";
  /** Prevents Workflow Architect mutations. Manual editor changes remain user-controlled. */
  locked?: boolean;
  /** Unsaved blank workflows are hidden until the user explicitly saves them. */
  draft?: boolean;
};

/** Internal editor fallback. It is intentionally not part of the catalog. */
export const EMPTY_WORKFLOW_TEMPLATE: WorkflowTemplate = {
  id: DEFAULT_TEMPLATE_ID,
  name: "Untitled workflow",
  description: "Empty workspace — create a workflow with Workflow Architect.",
  version: "v0.0",
  nodes: [],
  edges: [],
};

/** Built-in product templates. The fresh catalog currently has none. */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [];

export function createBlankWorkflowTemplate(
  createdAt = Date.now(),
): WorkflowTemplate {
  return {
    id: `workflow-${createdAt.toString(36)}`,
    name: "Untitled workflow",
    description: "Blank workflow created manually.",
    version: "v0.1",
    nodes: [],
    edges: [],
    draft: true,
  };
}

const CUSTOM_WORKFLOWS_KEY = "codex-corp-custom-workflows";
const DELETED_WORKFLOWS_KEY = "codex-corp-deleted-workflows";

function readCustomWorkflows(): WorkflowTemplate[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(CUSTOM_WORKFLOWS_KEY) ?? "[]",
    );
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readDeletedWorkflows(): string[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(DELETED_WORKFLOWS_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveCustomWorkflow(template: WorkflowTemplate): void {
  const items = readCustomWorkflows();
  const next = [...items.filter((item) => item.id !== template.id), template];
  localStorage.setItem(CUSTOM_WORKFLOWS_KEY, JSON.stringify(next));
  localStorage.setItem(
    DELETED_WORKFLOWS_KEY,
    JSON.stringify(readDeletedWorkflows().filter((id) => id !== template.id)),
  );
}

export function updateWorkflowMetadata(
  id: string,
  patch: Partial<
    Pick<WorkflowTemplate, "name" | "locked" | "templateOrigin" | "draft">
  >,
): WorkflowTemplate | null {
  const workflow = readCustomWorkflows().find((item) => item.id === id);
  if (!workflow) return null;
  const next = { ...workflow, ...patch };
  saveCustomWorkflow(next);
  return next;
}

export function addWorkflowToTemplates(id: string): WorkflowTemplate | null {
  return updateWorkflowMetadata(id, { templateOrigin: "user" });
}

export function removeWorkflowFromTemplates(
  id: string,
): WorkflowTemplate | null {
  return updateWorkflowMetadata(id, { templateOrigin: undefined });
}

export function deleteWorkflowFromCatalog(id: string): void {
  localStorage.setItem(
    CUSTOM_WORKFLOWS_KEY,
    JSON.stringify(readCustomWorkflows().filter((item) => item.id !== id)),
  );
  localStorage.setItem(
    DELETED_WORKFLOWS_KEY,
    JSON.stringify([...new Set([...readDeletedWorkflows(), id])]),
  );
}

export function listWorkflows(
  options: { includeDrafts?: boolean } = {},
): WorkflowTemplate[] {
  const deleted = new Set(readDeletedWorkflows());
  return readCustomWorkflows().filter(
    (item) => !deleted.has(item.id) && (options.includeDrafts || !item.draft),
  );
}

export function listTemplates(): WorkflowTemplate[] {
  const builtIns = WORKFLOW_TEMPLATES.map((item) => ({
    ...item,
    templateOrigin: "built-in" as const,
  }));
  const userTemplates = listWorkflows().filter(
    (item) => item.templateOrigin === "user",
  );
  return [...builtIns, ...userTemplates];
}

export function getTemplate(id: string): WorkflowTemplate {
  return (
    listWorkflows({ includeDrafts: true }).find(
      (template) => template.id === id,
    ) ??
    WORKFLOW_TEMPLATES.find((template) => template.id === id) ??
    EMPTY_WORKFLOW_TEMPLATE
  );
}

export function isTemplateId(id: string): boolean {
  return listTemplates().some((template) => template.id === id);
}

export function cloneTemplateGraph(template: WorkflowTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  return {
    nodes: structuredClone(template.nodes),
    edges: structuredClone(template.edges),
  };
}

export function templateStats(template: WorkflowTemplate): {
  nodeCount: number;
  edgeCount: number;
} {
  return {
    nodeCount: template.nodes.filter((node) => node.data.kind !== "note")
      .length,
    edgeCount: template.edges.length,
  };
}
