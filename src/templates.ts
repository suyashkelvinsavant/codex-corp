import type { FlowEdge, FlowNode } from "./model";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { autoLayout } from "./graph";
import { notifyPersistenceError } from "./persistence-events";
import { builtinWorkflowTemplates } from "./node-packs/template-factory";

export const DEFAULT_TEMPLATE_ID = "empty-draft";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  version: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Homescreen card icon id (see workflow-icons.ts). */
  icon?: string;
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
  description: "Empty workspace — create a workflow with Byte.",
  version: "v0.0",
  nodes: [],
  edges: [],
};

/** Built-in product templates (pack-wired process shapes). */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = builtinWorkflowTemplates();

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
let desktopWorkflows: WorkflowTemplate[] | null = null;
const desktopCatalogWrites = new Set<Promise<void>>();

function enqueueCatalogWrite(operation: Promise<unknown>): void {
  const tracked = operation
    .then(() => undefined)
    .catch((error) => notifyPersistenceError("workflow catalog", error))
    .finally(() => desktopCatalogWrites.delete(tracked));
  desktopCatalogWrites.add(tracked);
}

export async function flushDesktopCatalogWrites(): Promise<void> {
  while (desktopCatalogWrites.size) {
    await Promise.all([...desktopCatalogWrites]);
  }
}

function readBrowserCustomWorkflows(): WorkflowTemplate[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(CUSTOM_WORKFLOWS_KEY) ?? "[]",
    );
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readCustomWorkflows(): WorkflowTemplate[] {
  return desktopWorkflows ?? readBrowserCustomWorkflows();
}

export async function hydrateWorkflowCatalog(): Promise<void> {
  if (!isTauri()) return;
  const serialized = await invoke<string[]>("list_workflow_catalog");
  const native = serialized.flatMap((raw) => {
    try {
      const item = JSON.parse(raw) as WorkflowTemplate;
      return item && typeof item.id === "string" ? [item] : [];
    } catch {
      return [];
    }
  });
  const migration = planCatalogMigration(
    native,
    readBrowserCustomWorkflows(),
    readDeletedWorkflows(),
  );
  try {
    await Promise.all(
      migration.imports.map((item) =>
        invoke("save_workflow_catalog_item", {
          templateJson: JSON.stringify(item),
        }),
      ),
    );
  } catch (error) {
    desktopWorkflows = native;
    notifyPersistenceError("workflow catalog migration", error);
    throw error;
  }
  desktopWorkflows = migration.items;
  // Successful one-shot migration must not compete with SQLite on later boots.
  localStorage.removeItem(CUSTOM_WORKFLOWS_KEY);
  localStorage.removeItem(DELETED_WORKFLOWS_KEY);
}

export function planCatalogMigration(
  native: WorkflowTemplate[],
  browser: WorkflowTemplate[],
  deletedIds: string[],
): { items: WorkflowTemplate[]; imports: WorkflowTemplate[] } {
  const deleted = new Set(deletedIds);
  const merged = new Map(native.map((item) => [item.id, item]));
  const imports = browser.filter(
    (item) => !deleted.has(item.id) && !merged.has(item.id),
  );
  for (const item of imports) merged.set(item.id, item);
  return { items: [...merged.values()], imports };
}

export function resetDesktopCatalogCache(): void {
  desktopWorkflows = null;
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
  // Preserve catalog position on update. Appending reordered the list whenever
  // lock/name/etc. changed, so rows jumped under the operator's cursor.
  const index = items.findIndex((item) => item.id === template.id);
  const next =
    index >= 0
      ? items.map((item, i) => (i === index ? template : item))
      : [...items, template];
  if (desktopWorkflows) {
    desktopWorkflows = next;
    enqueueCatalogWrite(
      invoke("save_workflow_catalog_item", {
        templateJson: JSON.stringify(template),
      }),
    );
    return;
  }
  localStorage.setItem(CUSTOM_WORKFLOWS_KEY, JSON.stringify(next));
  localStorage.setItem(
    DELETED_WORKFLOWS_KEY,
    JSON.stringify(readDeletedWorkflows().filter((id) => id !== template.id)),
  );
}

/** Normalize operator-entered version labels to `vMAJOR.MINOR` when possible. */
export function normalizeWorkflowVersion(version: string): string {
  const raw = version.trim();
  if (!raw) return "v0.1";
  const match = /^v?(\d+)(?:\.(\d+))?$/i.exec(raw);
  if (match) return `v${match[1]}.${match[2] ?? "0"}`;
  return raw.slice(0, 32);
}

export function bumpWorkflowVersion(version: string): string {
  const normalized = normalizeWorkflowVersion(version);
  const match = /^v(\d+)\.(\d+)$/.exec(normalized);
  return match ? `v${match[1]}.${Number(match[2]) + 1}` : "v0.1";
}

export type WorkflowMetadataPatch = Partial<
  Pick<
    WorkflowTemplate,
    | "name"
    | "description"
    | "version"
    | "icon"
    | "locked"
    | "templateOrigin"
    | "draft"
  >
>;

export function updateWorkflowMetadata(
  id: string,
  patch: WorkflowMetadataPatch,
): WorkflowTemplate | null {
  const workflow = readCustomWorkflows().find((item) => item.id === id);
  if (!workflow) return null;
  const next: WorkflowTemplate = { ...workflow, ...patch };
  if (typeof patch.name === "string") {
    next.name = patch.name.trim() || "Untitled workflow";
  }
  if (typeof patch.description === "string") {
    next.description = patch.description.trim();
  }
  if (typeof patch.version === "string") {
    next.version = normalizeWorkflowVersion(patch.version);
  }
  if (typeof patch.icon === "string") {
    next.icon = patch.icon.trim() || undefined;
  }
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
  if (desktopWorkflows) {
    desktopWorkflows = desktopWorkflows.filter((item) => item.id !== id);
    enqueueCatalogWrite(invoke("delete_workflow", { id }));
    return;
  }
  localStorage.setItem(
    CUSTOM_WORKFLOWS_KEY,
    JSON.stringify(readCustomWorkflows().filter((item) => item.id !== id)),
  );
  localStorage.setItem(
    DELETED_WORKFLOWS_KEY,
    JSON.stringify([...new Set([...readDeletedWorkflows(), id])]),
  );
}

function compareWorkflowsByName(
  a: WorkflowTemplate,
  b: WorkflowTemplate,
): number {
  const byName = a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

export function listWorkflows(
  options: { includeDrafts?: boolean } = {},
): WorkflowTemplate[] {
  const deleted = new Set(readDeletedWorkflows());
  return readCustomWorkflows()
    .filter(
      (item) => !deleted.has(item.id) && (options.includeDrafts || !item.draft),
    )
    .sort(compareWorkflowsByName);
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

/**
 * Deep-clone a template graph and apply layered auto-layout so factory /
 * first-open canvases match the Auto layout command.
 */
export function cloneTemplateGraphLaidOut(template: WorkflowTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const { nodes, edges } = cloneTemplateGraph(template);
  if (!nodes.length) return { nodes, edges };
  return { nodes: autoLayout(nodes, edges), edges };
}

/**
 * Instantiate a builtin (or any catalog) template as a new user workflow.
 * Does not mark the copy as a template — it appears under Workflows.
 */
export function createWorkflowFromTemplate(
  source: WorkflowTemplate,
  createdAt = Date.now(),
): WorkflowTemplate {
  const { nodes, edges } = cloneTemplateGraphLaidOut(source);
  return {
    id: `workflow-${createdAt.toString(36)}`,
    name: source.name,
    description: source.description,
    version: source.version || "v0.1",
    nodes,
    edges,
    draft: false,
    locked: false,
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
