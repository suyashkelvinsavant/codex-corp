import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestWorkflow } from "./test-workflow-fixture";
import { validateWorkflow } from "./graph-validation";
import { getPack } from "./node-packs/packs";
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

const ADDITIONAL_BUILTIN_CONTRACTS = [
  {
    id: "product-launch-v1",
    name: "Product launch",
    requiredPacks: [
      "product-manager",
      "researcher",
      "designer",
      "builder",
      "qa-engineer",
    ],
    minimumNodeCount: 8,
  },
  {
    id: "security-review-v1",
    name: "Security review",
    requiredPacks: ["architect", "security-reviewer", "code-reviewer"],
    minimumNodeCount: 6,
  },
  {
    id: "incident-response-v1",
    name: "Incident response",
    requiredPacks: [
      "security-reviewer",
      "architect",
      "backend-engineer",
      "qa-engineer",
      "delivery-agent",
    ],
    minimumNodeCount: 8,
  },
] as const;

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
      software.nodes.find((n) => n.data.kind === "output")?.data,
    ).toMatchObject({
      label: "Release Bundle",
      role: "Verified handoff",
    });
    expect(
      software.nodes
        .filter((node) => node.data.kind === "agent")
        .every(
          (node) =>
            node.data.model === "gpt-5.6-luna" && node.data.effort === "medium",
        ),
    ).toBe(true);
    expect(
      software.nodes.find((node) => node.id === "input")?.data,
    ).toMatchObject({
      status: "idle",
      output: "Describe the product request for the company.",
      missionSource: "template",
    });
    expect(isTemplateId(DEFAULT_TEMPLATE_ID)).toBe(false);
    expect(getTemplate("missing")).toMatchObject({
      id: DEFAULT_TEMPLATE_ID,
      nodes: [],
      edges: [],
    });
  });

  describe("additional built-in templates", () => {
    it("registers exactly three additional templates with stable unique identities", () => {
      const builtIns = listTemplates().filter(
        (template) => template.templateOrigin === "built-in",
      );
      const ids = builtIns.map((template) => template.id);

      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(
        expect.arrayContaining(
          ADDITIONAL_BUILTIN_CONTRACTS.map((contract) => contract.id),
        ),
      );
      expect(builtIns.map((template) => template.name)).toEqual(
        expect.arrayContaining(
          ADDITIONAL_BUILTIN_CONTRACTS.map((contract) => contract.name),
        ),
      );
    });

    it.each(ADDITIONAL_BUILTIN_CONTRACTS)(
      "$name stays executable and cannot reference a missing pack or node",
      (contract) => {
        const template = getTemplate(contract.id);
        const nodeIds = new Set(template.nodes.map((node) => node.id));

        expect(template.nodes.length, contract.id).toBeGreaterThanOrEqual(
          contract.minimumNodeCount,
        );
        expect(template.templateOrigin, contract.id).toBe("built-in");
        expect(template.locked, contract.id).toBe(true);
        expect(
          template.nodes.some((node) => node.data.kind === "input"),
          contract.id,
        ).toBe(true);
        expect(
          template.nodes.some((node) => node.data.kind === "approval"),
          contract.id,
        ).toBe(true);
        expect(
          template.nodes.some((node) => node.data.kind === "output"),
          contract.id,
        ).toBe(true);
        expect(
          template.nodes
            .filter((node) => node.data.kind === "agent")
            .every((node) => getPack(node.data.packId ?? "")),
          contract.id,
        ).toBe(true);
        expect(
          template.edges.every(
            (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
          ),
          contract.id,
        ).toBe(true);
        expect(
          validateWorkflow(template.nodes, template.edges).filter(
            (problem) => problem.severity === "error",
          ),
          contract.id,
        ).toEqual([]);
      },
    );

    it.each(ADDITIONAL_BUILTIN_CONTRACTS)(
      "$name uses the requested specialist packs and bounded execution defaults",
      (contract) => {
        const template = getTemplate(contract.id);
        const packIds = template.nodes
          .map((node) => node.data.packId)
          .filter((packId): packId is string => Boolean(packId));
        const agentNodes = template.nodes.filter(
          (node) => node.data.kind === "agent",
        );

        expect(packIds).toEqual(
          expect.arrayContaining([...contract.requiredPacks]),
        );
        expect(
          agentNodes.every(
            (node) =>
              node.data.maxRetries === 2 &&
              (node.data.timeoutSeconds ?? 0) >= 120 &&
              (node.data.completionCriteria?.length ?? 0) > 0,
          ),
          contract.id,
        ).toBe(true);
      },
    );

    it.each(ADDITIONAL_BUILTIN_CONTRACTS)(
      "$name keeps the release boundary human-controlled",
      (contract) => {
        const template = getTemplate(contract.id);
        const byId = new Map(template.nodes.map((node) => [node.id, node]));
        const output = template.nodes.find(
          (node) => node.data.kind === "output",
        );
        const incoming = template.edges.filter(
          (edge) => edge.target === output?.id,
        );

        expect(
          template.nodes.filter((node) => node.data.kind === "approval"),
        ).toHaveLength(1);
        expect(incoming).toHaveLength(1);
        expect(byId.get(incoming[0]?.source)?.data.kind).toBe("approval");
        expect(
          template.edges.some(
            (edge) =>
              byId.get(edge.source)?.data.kind === "agent" &&
              byId.get(edge.target)?.data.kind === "output",
          ),
        ).toBe(false);
      },
    );

    it.each(ADDITIONAL_BUILTIN_CONTRACTS)(
      "$name includes a bounded revision path without leaking limits to other edges",
      (contract) => {
        const template = getTemplate(contract.id);
        const revisionEdges = template.edges.filter(
          (edge) => edge.data?.edgeType === "revision",
        );
        const nonRevisionEdges = template.edges.filter(
          (edge) => edge.data?.edgeType !== "revision",
        );

        expect(revisionEdges.length, contract.id).toBeGreaterThan(0);
        expect(
          revisionEdges.every(
            (edge) =>
              Number.isInteger(edge.data?.maxRevisions) &&
              (edge.data?.maxRevisions ?? 0) > 0,
          ),
          contract.id,
        ).toBe(true);
        expect(
          nonRevisionEdges.every(
            (edge) => edge.data?.maxRevisions === undefined,
          ),
          contract.id,
        ).toBe(true);
      },
    );
  });

  describe("built-in revision limits", () => {
    it("gives every built-in output node an operator-facing release purpose", () => {
      for (const template of listTemplates().filter(
        (item) => item.templateOrigin === "built-in",
      )) {
        const output = template.nodes.find(
          (node) => node.data.kind === "output",
        );
        expect(output?.data.label, template.id).toBe("Release Bundle");
        expect(output?.data.description, template.id).toMatch(
          /approved artifact hashes|tamper-evident/i,
        );
        expect(output?.data.prompt, template.id).toMatch(
          /compare.*approved.*live|approved.*live.*artifacts/i,
        );
      }
    });
    it("runs Software company specialists in the selected workspace with builder autonomy", () => {
      const software = getTemplate("software-company-v1");
      const builder = software.nodes.find((node) => node.id === "builder");
      expect(builder?.data.approvalPolicy).toBe("never");
      expect(builder?.data.sandboxProfile).toBe("danger-full-access");
      expect(builder?.data.workspacePolicy).toBe("workflow");

      const agents = software.nodes.filter((node) => node.data.kind === "agent");
      expect(agents.length).toBe(5);
      for (const node of agents) {
        if (node.id === "builder") continue;
        const approval = node.data.approvalPolicy ?? "on-request";
        const sandbox = node.data.sandboxProfile ?? "workspace-write";
        expect(["on-request", "untrusted", "never"]).toContain(approval);
        expect(["read-only", "workspace-write", "danger-full-access"]).toContain(
          sandbox,
        );
      }
      expect(agents.every((node) => node.data.workspacePolicy === "workflow")).toBe(
        true,
      );
    });

    it("uses staged release coordinator → demo → release-commit → publish-approval → output", () => {
      const software = getTemplate("software-company-v1");
      const nodeIds = software.nodes.map((n) => n.id);
      expect(nodeIds).toContain("release-coordinator");
      expect(nodeIds).toContain("demo");
      expect(nodeIds).toContain("release-commit");
      expect(nodeIds).toContain("publish-approval");
      const edgeIds = software.edges.map((e) => e.id);
      expect(edgeIds).toContain("e-qa-release-coordinator");
      expect(edgeIds).toContain("e-release-coordinator-demo");
      expect(edgeIds).toContain("e-demo-release-commit");
      expect(edgeIds).toContain("e-release-commit-publish");
      expect(edgeIds).toContain("e-publish-output");
      // The old direct qa→approval→output path should be gone.
      expect(edgeIds).not.toContain("e-qa-approval");
      expect(edgeIds).not.toContain("e-approval-out");
      const coordinator = software.nodes.find(
        (n) => n.id === "release-coordinator",
      );
      expect(coordinator?.data.kind).toBe("agent");
      expect(coordinator?.data.sandboxProfile).toBe("read-only");
      expect(coordinator?.data.approvalPolicy).toBe("never");
    });

    it("gives QA deterministic required test and build gates", () => {
      const qa = getTemplate("software-company-v1").nodes.find(
        (node) => node.id === "qa",
      );
      const requiredCommands = qa?.data.completionCriteria
        ?.filter(
          (criterion) =>
            criterion.enabled &&
            criterion.enforcement === "required" &&
            criterion.kind === "command",
        )
        .map((criterion) => criterion.templateId);
      expect(requiredCommands).toEqual(
        expect.arrayContaining(["npm_test", "npm_run_build"]),
      );
    });

    it("requires Builder to finish dependency setup before handing work to QA", () => {
      const builder = getTemplate("software-company-v1").nodes.find(
        (node) => node.id === "builder",
      );
      expect(builder?.data.packId).toBe("builder");
      expect(builder?.data.approvalPolicy).toBe("never");
      expect(builder?.data.sandboxProfile).toBe("danger-full-access");
      expect(builder?.data.tools).toEqual(
        expect.arrayContaining([
          "Workspace read",
          "Workspace write",
          "Shell",
          "Apply patch",
          "Network",
          "Build",
          "Test",
          "Package install",
        ]),
      );
      expect(builder?.data.developerInstructions).toMatch(
        /install.*declared dependencies|dependency install/i,
      );
      expect(builder?.data.developerInstructions).toMatch(
        /test.*build|build.*test/i,
      );
      expect(builder?.data.developerInstructions).toMatch(
        /do not report success/i,
      );
      expect(builder?.data.developerInstructions).toMatch(
        /do not ask for human approval|do not request human permission/i,
      );
    });

    it("requires QA to report verifier evidence instead of static-only success", () => {
      const qa = getTemplate("software-company-v1").nodes.find(
        (node) => node.id === "qa",
      );
      expect(qa?.data.developerInstructions).toMatch(
        /host.*verifier.*npm test.*npm run build/i,
      );
      expect(qa?.data.developerInstructions).toMatch(
        /do not.*run.*full.*test.*build|do not.*duplicate.*host/i,
      );
      expect(qa?.data.developerInstructions).toMatch(
        /static.*not.*substitute/i,
      );
      expect(qa?.data.developerInstructions).toMatch(
        /needs_revision.*actionable.*builder|actionable.*builder.*needs_revision/i,
      );
      expect(qa?.data.developerInstructions).toMatch(
        /missing.*operator.*residual risk|residual risk.*missing.*operator/i,
      );
      expect(qa?.data.developerInstructions).toMatch(
        /revision.*prior defect|prior defect.*revision/i,
      );
    });

    it("keeps the Software company release gate explicitly human-controlled", () => {
      const approval = getTemplate("software-company-v1").nodes.find(
        (node) => node.data.kind === "approval",
      );
      expect(approval).toBeDefined();
      expect(approval?.data.approvalPolicy).toBeUndefined();
    });

    it("does not silently broaden execution policy on unrelated templates", () => {
      const agents = getTemplate("code-change-delivery-v1").nodes.filter(
        (node) => node.data.kind === "agent",
      );
      expect(agents.some((node) => node.data.approvalPolicy !== "never")).toBe(
        true,
      );
    });

    it("gives implementation and verification nodes production-sized execution budgets", () => {
      const software = getTemplate("software-company-v1");
      expect(
        software.nodes.find((node) => node.id === "pm")?.data.timeoutSeconds,
      ).toBeGreaterThanOrEqual(300);
      expect(
        software.nodes.find((node) => node.id === "architect")?.data
          .timeoutSeconds,
      ).toBeGreaterThanOrEqual(300);
      expect(
        software.nodes.find((node) => node.id === "builder")?.data
          .timeoutSeconds,
      ).toBeGreaterThanOrEqual(600);
      expect(
        software.nodes.find((node) => node.id === "qa")?.data.timeoutSeconds,
      ).toBeGreaterThanOrEqual(600);
    });

    it("makes the Software company template executable", () => {
      const software = getTemplate("software-company-v1");
      expect(
        validateWorkflow(software.nodes, software.edges).filter(
          (problem) => problem.severity === "error",
        ),
      ).toEqual([]);
    });

    it("keeps every built-in template free of revision-limit errors", () => {
      for (const template of listTemplates().filter(
        (item) => item.templateOrigin === "built-in",
      )) {
        expect(
          validateWorkflow(template.nodes, template.edges).filter((problem) =>
            problem.id.startsWith("revision-limit-"),
          ),
          template.id,
        ).toEqual([]);
      }
    });

    it("preserves revision limits when a template becomes a workflow", () => {
      const workflow = createWorkflowFromTemplate(
        getTemplate("software-company-v1"),
        1_700_000_000_000,
      );
      expect(
        workflow.edges.find((edge) => edge.data?.edgeType === "revision")?.data
          ?.maxRevisions,
      ).toBe(2);
    });

    it("uses finite positive integer limits on every built-in revision edge", () => {
      const revisionLimits = listTemplates()
        .filter((item) => item.templateOrigin === "built-in")
        .flatMap((template) =>
          template.edges
            .filter((edge) => edge.data?.edgeType === "revision")
            .map((edge) => edge.data?.maxRevisions),
        );
      expect(revisionLimits.length).toBeGreaterThan(0);
      expect(
        revisionLimits.every(
          (limit) =>
            typeof limit === "number" &&
            Number.isFinite(limit) &&
            Number.isInteger(limit) &&
            limit > 0,
        ),
      ).toBe(true);
    });

    it("does not attach revision limits to non-revision edges", () => {
      const nonRevisionEdges = listTemplates()
        .filter((item) => item.templateOrigin === "built-in")
        .flatMap((template) => template.edges)
        .filter((edge) => edge.data?.edgeType !== "revision");
      expect(
        nonRevisionEdges.every((edge) => edge.data?.maxRevisions === undefined),
      ).toBe(true);
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
