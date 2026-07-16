import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestWorkflow } from "./test-workflow-fixture";
import {
  cloneTemplateGraph,
  createBlankWorkflowTemplate,
  DEFAULT_TEMPLATE_ID,
  deleteWorkflowFromCatalog,
  getTemplate,
  isTemplateId,
  listWorkflows,
  listTemplates,
  addWorkflowToTemplates,
  removeWorkflowFromTemplates,
  saveCustomWorkflow,
  templateStats,
} from "./templates";

describe("workflow catalog", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("starts empty with a non-catalog empty editor fallback", () => {
    expect(listTemplates()).toEqual([]);
    expect(isTemplateId(DEFAULT_TEMPLATE_ID)).toBe(false);
    expect(getTemplate("missing")).toMatchObject({
      id: DEFAULT_TEMPLATE_ID,
      nodes: [],
      edges: [],
    });
  });

  it("keeps saved workflows out of templates until explicitly added", () => {
    const workflow = makeTestWorkflow();
    saveCustomWorkflow(workflow);
    expect(listWorkflows().map((item) => item.id)).toEqual([workflow.id]);
    expect(listTemplates()).toEqual([]);
    addWorkflowToTemplates(workflow.id);
    expect(listTemplates().map((item) => item.id)).toEqual([workflow.id]);
    expect(getTemplate(workflow.id).name).toBe(workflow.name);
    expect(templateStats(workflow)).toEqual({ nodeCount: 9, edgeCount: 12 });
  });

  it("creates an empty, uniquely identified manual workflow", () => {
    expect(createBlankWorkflowTemplate(1_234)).toEqual({
      id: "workflow-ya",
      name: "Untitled workflow",
      description: "Blank workflow created manually.",
      version: "v0.1",
      nodes: [],
      edges: [],
      draft: true,
    });
  });

  it("removes a user template without deleting its workflow", () => {
    const workflow = makeTestWorkflow();
    saveCustomWorkflow(workflow);
    addWorkflowToTemplates(workflow.id);
    removeWorkflowFromTemplates(workflow.id);
    expect(listTemplates()).toEqual([]);
    expect(listWorkflows().map((item) => item.id)).toEqual([workflow.id]);
  });

  it("deep-clones user workflow graphs", () => {
    const workflow = makeTestWorkflow();
    const clone = cloneTemplateGraph(workflow);
    clone.nodes[0].data.label = "Changed";
    expect(workflow.nodes[0].data.label).toBe("Mission brief");
  });

  it("deletes workflows from the catalog", () => {
    const workflow = makeTestWorkflow();
    saveCustomWorkflow(workflow);
    deleteWorkflowFromCatalog(workflow.id);
    expect(listWorkflows()).toEqual([]);
  });
});
