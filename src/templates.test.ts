import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestWorkflow } from "./test-workflow-fixture";
import {
  cloneTemplateGraph,
  cloneTemplateGraphLaidOut,
  createBlankWorkflowTemplate,
  createWorkflowFromTemplate,
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
  updateWorkflowMetadata,
  normalizeWorkflowVersion,
  getTemplate as getCatalogTemplate,
  planCatalogMigration,
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

  it("ships builtin pack-wired templates and keeps empty editor fallback non-catalog", () => {
    const builtInIds = listTemplates()
      .filter((t) => t.templateOrigin === "built-in")
      .map((t) => t.id);
    expect(builtInIds).toEqual(
      expect.arrayContaining([
        "software-company-v1",
        "code-change-delivery-v1",
        "launch-review-v1",
      ]),
    );
    const software = getTemplate("software-company-v1");
    expect(
      software.nodes.some((n) => n.data.packId === "product-manager"),
    ).toBe(true);
    expect(software.nodes.some((n) => n.data.baseInstructions)).toBe(true);
    expect(
      software.nodes
        .filter((node) => node.data.kind === "agent")
        .every(
          (node) =>
            node.data.model === "gpt-5.6-luna" && node.data.effort === "medium",
        ),
    ).toBe(true);
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
    expect(
      listTemplates()
        .filter((t) => t.templateOrigin === "user")
        .map((item) => item.id),
    ).toEqual([]);
    addWorkflowToTemplates(workflow.id);
    expect(
      listTemplates()
        .filter((t) => t.templateOrigin === "user")
        .map((item) => item.id),
    ).toEqual([workflow.id]);
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
    expect(
      listTemplates()
        .filter((t) => t.templateOrigin === "user")
        .map((t) => t.id),
    ).toEqual([]);
    expect(listWorkflows().map((item) => item.id)).toEqual([workflow.id]);
  });

  it("deep-clones user workflow graphs", () => {
    const workflow = makeTestWorkflow();
    const clone = cloneTemplateGraph(workflow);
    clone.nodes[0].data.label = "Changed";
    expect(workflow.nodes[0].data.label).toBe("Mission brief");
  });

  it("creates a user workflow copy from a builtin template with laid-out graph", () => {
    const source = getTemplate("software-company-v1");
    expect(source.templateOrigin).toBe("built-in");
    const instance = createWorkflowFromTemplate(source, 1_700_000_000_000);
    expect(instance.id).toMatch(/^workflow-/);
    expect(instance.id).not.toBe(source.id);
    expect(instance.name).toBe(source.name);
    expect(instance.templateOrigin).toBeUndefined();
    expect(instance.draft).toBe(false);
    expect(instance.locked).toBe(false);
    expect(instance.nodes.length).toBe(source.nodes.length);
    expect(instance.edges.length).toBe(source.edges.length);
    // Auto-layout should place pipeline nodes into increasing columns.
    const input = instance.nodes.find((n) => n.id === "input");
    const output = instance.nodes.find((n) => n.id === "output");
    expect(input && output && output.position.x > input.position.x).toBe(true);
    saveCustomWorkflow(instance);
    expect(listWorkflows().map((w) => w.id)).toContain(instance.id);
    expect(
      listTemplates()
        .filter((t) => t.id === instance.id)
        .map((t) => t.id),
    ).toEqual([]);
  });

  it("cloneTemplateGraphLaidOut does not mutate the source template", () => {
    const source = getTemplate("code-change-delivery-v1");
    const before = source.nodes.map((n) => ({ ...n.position }));
    const laidOut = cloneTemplateGraphLaidOut(source);
    expect(source.nodes.map((n) => n.position)).toEqual(before);
    expect(laidOut.nodes.length).toBe(source.nodes.length);
  });

  it("deletes workflows from the catalog", () => {
    const workflow = makeTestWorkflow();
    saveCustomWorkflow(workflow);
    deleteWorkflowFromCatalog(workflow.id);
    expect(listWorkflows()).toEqual([]);
  });

  it("round-trips editable name, description, and version metadata", () => {
    const workflow = createBlankWorkflowTemplate(99);
    saveCustomWorkflow(workflow);
    expect(normalizeWorkflowVersion("1.4")).toBe("v1.4");
    expect(normalizeWorkflowVersion("v2")).toBe("v2.0");

    const updated = updateWorkflowMetadata(workflow.id, {
      name: "Launch crew",
      description: "Validates startup ideas end-to-end",
      version: "1.2",
    });
    expect(updated).toMatchObject({
      id: workflow.id,
      name: "Launch crew",
      description: "Validates startup ideas end-to-end",
      version: "v1.2",
    });
    expect(getCatalogTemplate(workflow.id)).toMatchObject({
      name: "Launch crew",
      description: "Validates startup ideas end-to-end",
      version: "v1.2",
    });
    expect(listWorkflows({ includeDrafts: true })[0]?.description).toBe(
      "Validates startup ideas end-to-end",
    );
  });

  it("persists a homescreen icon on workflow metadata", () => {
    const workflow = {
      ...makeTestWorkflow(),
      id: "wf-icon",
      name: "Icon company",
      draft: false,
    };
    saveCustomWorkflow(workflow);
    const updated = updateWorkflowMetadata(workflow.id, { icon: "rocket" });
    expect(updated?.icon).toBe("rocket");
    expect(getCatalogTemplate(workflow.id).icon).toBe("rocket");
  });

  it("lists workflows by name and keeps order stable when lock toggles", () => {
    const zebra = {
      ...makeTestWorkflow(),
      id: "wf-z",
      name: "Zebra ops",
      draft: false,
      locked: false,
    };
    const alpha = {
      ...makeTestWorkflow(),
      id: "wf-a",
      name: "Alpha crew",
      draft: false,
      locked: false,
    };
    const mid = {
      ...makeTestWorkflow(),
      id: "wf-m",
      name: "Mid pipeline",
      draft: false,
      locked: false,
    };
    // Save out of name order — list must still sort alphabetically.
    saveCustomWorkflow(zebra);
    saveCustomWorkflow(alpha);
    saveCustomWorkflow(mid);
    expect(listWorkflows().map((item) => item.name)).toEqual([
      "Alpha crew",
      "Mid pipeline",
      "Zebra ops",
    ]);

    updateWorkflowMetadata(alpha.id, { locked: true });
    expect(listWorkflows().map((item) => item.id)).toEqual([
      "wf-a",
      "wf-m",
      "wf-z",
    ]);
    expect(listWorkflows()[0]?.locked).toBe(true);
  });

  it("keeps native records authoritative during one-shot migration", () => {
    const native = { ...makeTestWorkflow(), id: "same", name: "Native" };
    const staleBrowser = { ...native, name: "Stale browser" };
    const browserOnly = { ...native, id: "legacy", name: "Legacy" };
    const deleted = { ...native, id: "deleted", name: "Deleted" };
    const result = planCatalogMigration(
      [native],
      [staleBrowser, browserOnly, deleted],
      ["deleted"],
    );
    expect(result.items.find((item) => item.id === "same")?.name).toBe(
      "Native",
    );
    expect(result.imports.map((item) => item.id)).toEqual(["legacy"]);
    expect(result.items.some((item) => item.id === "deleted")).toBe(false);
  });
});
