import { expect, test } from "@playwright/test";
import { makeTestWorkflow } from "../src/test-workflow-fixture";

/** Clear browser persistence so auto-load / run history do not leak across tests. */
async function freshWorkspace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("codex-corp-workflow");
    localStorage.removeItem("codex-corp-active-workflow");
    localStorage.removeItem("codex-corp-runs");
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith("codex-corp-workflow:") ||
        key.startsWith("codex-corp-chat:") ||
        key.startsWith("codex-corp-chat-sessions:")
      ) {
        localStorage.removeItem(key);
      }
    }
  });
  await page.evaluate(
    (template) =>
      localStorage.setItem(
        "codex-corp-custom-workflows",
        JSON.stringify([template]),
      ),
    JSON.parse(JSON.stringify(makeTestWorkflow())),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  // Card is role=button (opens chat). Use the nested edit control only.
  await page.locator(".workflow-edit").first().click();
  await expect(page.getByRole("button", { name: "Seed" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Seed" }).click();
}

test("fresh catalog is empty and Settings stays bounded and scrollable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 650 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.getByText("No workflows yet.")).toBeVisible();
  await expect(
    page.getByLabel("Workspace stats").locator("div").first(),
  ).toContainText("0");
  await page
    .getByLabel("Primary")
    .getByRole("button", { name: "Settings" })
    .click();

  const scroller = page.locator(".settings-scroll");
  await expect(scroller).toBeVisible();
  const runtimeRail = page.locator(".settings-runtime-rail");
  await expect(runtimeRail).toBeVisible();
  await expect(
    runtimeRail.getByRole("heading", { name: "Runtime" }),
  ).toBeVisible();
  await expect(
    runtimeRail.getByRole("heading", { name: "Connection" }),
  ).toBeVisible();
  const metrics = await scroller.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      bottom: rect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  const railBox = await runtimeRail.boundingBox();
  const scrollBox = await scroller.boundingBox();
  expect(railBox).not.toBeNull();
  expect(scrollBox).not.toBeNull();
  expect(railBox!.x).toBeGreaterThan(scrollBox!.x + scrollBox!.width - 1);
  expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(
    metrics.viewportHeight,
  );
  expect(await scroller.evaluate((element) => element.scrollWidth)).toBe(
    await scroller.evaluate((element) => element.clientWidth),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  await scroller.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  );
  await expect(
    page.getByRole("button", { name: "Clear all company data" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/settings-actions-redesign.png",
    fullPage: false,
  });
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
  await page.screenshot({
    path: "test-results/settings-redesign.png",
    fullPage: false,
  });
});

test("workspace tabs do not duplicate or change the primary navigation", async ({
  page,
}) => {
  await page.goto("/");

  const primary = page.getByLabel("Primary");
  const workspace = primary.getByRole("button", {
    name: "Workspace",
    exact: true,
  });
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(
    primary.getByRole("button", { name: "Templates", exact: true }),
  ).toHaveCount(0);
  await expect(
    primary.getByRole("button", { name: "Executions", exact: true }),
  ).toHaveCount(0);

  const templates = page.getByRole("tab", {
    name: "Templates",
    exact: true,
  });
  await templates.click();
  await expect(templates).toHaveAttribute("aria-selected", "true");
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();

  await page
    .getByLabel("Application")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await workspace.click();
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await expect(templates).toHaveAttribute("aria-selected", "true");
});

test("creates a blank workflow manually from the home screen", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: /New workflow/i }).click();
  await expect(page.getByRole("button", { name: "Seed" })).toBeVisible();

  const created = await page.evaluate(() => {
    const workflows = JSON.parse(
      localStorage.getItem("codex-corp-custom-workflows") ?? "[]",
    );
    return {
      activeId: localStorage.getItem("codex-corp-active-workflow"),
      workflows,
    };
  });
  expect(created.workflows).toHaveLength(1);
  expect(created.workflows[0]).toMatchObject({
    id: created.activeId,
    name: "Untitled workflow",
    version: "v0.1",
    nodes: [],
    edges: [],
  });
});

test("keeps workflow and template toolbars aligned and themes template actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const search = page.getByRole("textbox", { name: "Search workflows" });
  const workflowSearchBox = await search.boundingBox();
  const newWorkflowBox = await page
    .getByRole("button", { name: "New workflow", exact: true })
    .boundingBox();

  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  const templateSearchBox = await search.boundingBox();
  const addTemplate = page.getByRole("button", {
    name: "Add template",
    exact: true,
  });
  const addTemplateBox = await addTemplate.boundingBox();

  expect(workflowSearchBox).not.toBeNull();
  expect(templateSearchBox).not.toBeNull();
  expect(newWorkflowBox).not.toBeNull();
  expect(addTemplateBox).not.toBeNull();
  expect(templateSearchBox?.x).toBe(workflowSearchBox?.x);
  expect(templateSearchBox?.width).toBe(workflowSearchBox?.width);
  expect(
    Math.round((newWorkflowBox?.x ?? 0) + (newWorkflowBox?.width ?? 0)),
  ).toBe(Math.round((addTemplateBox?.x ?? 0) + (addTemplateBox?.width ?? 0)));

  await addTemplate.click();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCSS(
    "border-radius",
    "8px",
  );
  await expect(
    page.getByRole("button", { name: "Add templates", exact: true }),
  ).toHaveCSS("background-color", "rgb(85, 214, 190)");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize({ width: 520, height: 760 });
  await expect(page.locator(".overview-toolbar")).toHaveCSS(
    "flex-direction",
    "column",
  );
});

async function goToWorkflowsOverview(page: import("@playwright/test").Page) {
  // Editor uses aria-label "Back to overview"; workspace views use tabs.
  const back = page.getByRole("button", { name: /Back to overview/i });
  if (await back.count()) {
    await back.click();
  }
  const workflowsNav = page.getByRole("tab", {
    name: "Workflows",
    exact: true,
  });
  if (await workflowsNav.count()) {
    await workflowsNav.click();
  }
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({
    timeout: 10_000,
  });
}

async function openEditorFromOverview(
  page: import("@playwright/test").Page,
  companyName?: string,
) {
  await goToWorkflowsOverview(page);
  if (companyName) {
    const card = page
      .locator(".workflow-card")
      .filter({ hasText: companyName });
    await card.locator(".workflow-edit").click();
  } else {
    await page.locator(".workflow-edit").first().click();
  }
  await expect(page.getByRole("button", { name: "Seed" })).toBeVisible({
    timeout: 10_000,
  });
}

/** Topbar run control — avoids the inspector "Run company" duplicate. */
function topRunButton(page: import("@playwright/test").Page) {
  return page.getByRole("banner").getByRole("button", {
    name: /Run company|Stop run|Stop/,
  });
}

/** Mission prompt textarea (not the Expand editor control). */
function workflowMissionField(page: import("@playwright/test").Page) {
  return page.getByRole("textbox", { name: "Workflow mission" });
}

function acceptanceNotesField(page: import("@playwright/test").Page) {
  return page.getByRole("textbox", { name: "Acceptance notes" });
}

test("Workflow Architect chat history persists in the left sidebar", async ({
  page,
}) => {
  await freshWorkspace(page);
  await goToWorkflowsOverview(page);
  await page.locator(".overview-architect-launch").click();

  const composer = page.getByPlaceholder(
    "Describe a company workflow, a bug, or a change to agent access…",
  );
  await composer.fill("Remember this architect conversation");
  await composer.press("Enter");
  await expect(page.locator(".architect-history")).toContainText(
    "Remember this architect conversation",
  );

  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page.locator(".overview-architect-launch").click();

  await expect(page.locator(".architect-history")).toContainText(
    "Remember this architect conversation",
  );
  await expect(page.locator(".architect-messages")).toContainText(
    "Remember this architect conversation",
  );
});

test("company chat opens app context only when the mediator requests it", async ({
  page,
}) => {
  await freshWorkspace(page);
  await goToWorkflowsOverview(page);
  await page.locator(".workflow-card").first().click();

  const modal = page.getByRole("dialog", { name: "What are we working on?" });
  await expect(modal).toBeHidden();
  await expect(page.getByPlaceholder(/Message the mediator/i)).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("codex-corp:request-app-workspace", {
        detail: {
          suggestedMode: "existing",
          resolve: (selection: unknown) => {
            (
              window as typeof window & { __workspaceSelection?: unknown }
            ).__workspaceSelection = selection;
          },
        },
      }),
    );
  });
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("radio", { name: /Modify an existing app/i }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(modal).toContainText("identified a project task");
  await expect(modal).toContainText("Codex Corp workspace");

  await page.screenshot({
    path: "test-results/chat-app-context-modal.png",
    fullPage: false,
  });
  await modal.getByRole("button", { name: "Continue to chat" }).click();
  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Existing app/i }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __workspaceSelection?: unknown })
          .__workspaceSelection,
    ),
  ).toMatchObject({ projectMode: "existing" });

  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(modal).toBeHidden();
});

test("edits graph, mission, and inspector without a stub agent runtime", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await freshWorkspace(page);

  const nodes = page.locator(".react-flow__node");
  const edges = page.locator(".react-flow__edge-path");
  // Software company v0.5: 9 nodes (incl. creative) / 12 edges
  await expect(nodes).toHaveCount(9);
  await expect(edges).toHaveCount(12);
  const paths = await edges.evaluateAll((items) =>
    items.map((item) => item.getAttribute("d") ?? ""),
  );
  expect(paths.every((path) => path.includes("C"))).toBe(true);

  const builder = page.locator('.react-flow__node[data-id="builder"]');
  const beforeStyle = await builder.getAttribute("style");
  const box = await builder.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 + 90,
    box!.y + box!.height / 2 + 45,
    { steps: 8 },
  );
  await page.mouse.up();
  expect(await builder.getAttribute("style")).not.toBe(beforeStyle);
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await builder.getAttribute("style")).toBe(beforeStyle);
  await page.getByRole("button", { name: "Redo" }).click();
  expect(await builder.getAttribute("style")).not.toBe(beforeStyle);
  await page.getByRole("button", { name: "Undo" }).click();

  await page.locator('.react-flow__node[data-id="input"]').click();
  await workflowMissionField(page).fill("E2E isolated mission payload");
  await page.locator('.react-flow__node[data-id="research"]').click();
  await page.getByRole("button", { name: "context", exact: true }).click();
  await expect(
    page.locator(".context-row.included small", {
      hasText: "E2E isolated mission payload",
    }),
  ).toBeVisible();
  const inspectorResize = page.getByRole("separator", {
    name: "Resize inspector",
  });
  await inspectorResize.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(inspectorResize).toHaveAttribute("aria-valuenow", "400");
  const drawerResize = page.getByRole("separator", {
    name: "Resize execution drawer",
  });
  await drawerResize.focus();
  await page.keyboard.press("ArrowUp");
  await expect(drawerResize).toHaveAttribute("aria-valuenow", "230");

  // Browser shell has no Live Codex — Validate must fail closed (no stub path).
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(
    page.getByText(/desktop app|desktop shell|no browser stub/i).first(),
  ).toBeVisible({ timeout: 5_000 });
  await page.screenshot({
    path: "test-results/codex-corp-e2e.png",
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test("Run company fails closed without desktop Live Codex shell", async ({
  page,
}) => {
  await freshWorkspace(page);
  await topRunButton(page).click();
  await expect(
    page
      .getByText(/desktop app|desktop shell|no browser stub|Live Codex/i)
      .first(),
  ).toBeVisible({ timeout: 8_000 });
  // Must not complete a synthetic company run.
  await expect(
    page.locator(
      '.react-flow__node:not([data-id="input"]) .corp-node.status-completed',
    ),
  ).toHaveCount(0);
});

test("saves workflow and auto-restores it after reload", async ({ page }) => {
  await freshWorkspace(page);
  await page.locator('.react-flow__node[data-id="input"]').click();
  await workflowMissionField(page).fill("Persisted mission after reload");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText(
    /Saved locally|Saved to SQLite/i,
  );

  await page.reload();
  // App shell reloads on Overview — re-open the graph editor.
  await openEditorFromOverview(page, "Software company");
  await page.locator('.react-flow__node[data-id="input"]').click();
  await expect(workflowMissionField(page)).toHaveValue(
    "Persisted mission after reload",
  );
  await expect(page.locator(".save-state")).toHaveText(
    /Loaded locally|Loaded from SQLite|Migrated|Unsaved|Saved/i,
  );
});

test("tools tab states tool grants as advisory/display-only and MCP as not connected", async ({
  page,
}) => {
  await freshWorkspace(page);
  await page.locator('.react-flow__node[data-id="builder"]').click();
  await page.getByRole("button", { name: "tools", exact: true }).click();
  await expect(page.getByTestId("tools-boundary-helper")).toContainText(
    /advisory allow-list|MCP is not connected/i,
  );
  await page.getByRole("button", { name: /MCP servers/i }).click();
  await expect(
    page.getByRole("button", { name: /MCP servers/i }),
  ).toContainText(/not connected/i);
  await expect(page.getByText("Selected · not connected")).toBeVisible();
});

test("mission constraints, acceptance notes, and completion criteria are editable and persist", async (
  { page },
  testInfo,
) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await freshWorkspace(page);

  // —— Mission brief: constraints + acceptance notes ——
  await page.locator('.react-flow__node[data-id="input"]').click();
  await workflowMissionField(page).fill(
    "E2E contract mission for an interactive inventory board",
  );
  const constraints = page.getByTestId("mission-constraints");
  await expect(constraints).toBeVisible();
  await constraints.fill("No backend API\nKeyboard accessible");
  await acceptanceNotesField(page).fill(
    "Inventory can be filtered, edited, and reviewed with a keyboard",
  );
  await expect(page.getByTestId("composed-mission-preview")).toContainText(
    "E2E contract mission for an interactive inventory board",
  );
  await expect(page.getByTestId("composed-mission-preview")).toContainText(
    "Keyboard accessible",
  );
  await expect(page.getByTestId("composed-mission-preview")).toContainText(
    "Inventory can be filtered",
  );

  // —— Quality Gate: real completion criteria checkboxes ——
  await page.locator('.react-flow__node[data-id="reviewer"]').click();
  await page.getByRole("button", { name: "instructions", exact: true }).click();
  await expect(page.getByTestId("completion-criteria-list")).toBeVisible();
  await expect(page.getByTestId("criterion-structured_json")).toBeVisible();
  const structured = page.getByRole("checkbox", {
    name: /Enable criterion: Return structured JSON output/i,
  });
  await expect(structured).toBeChecked();
  await expect(structured).toBeDisabled();
  await page.getByTestId("criterion-draft").fill("Flag missing a11y notes");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const customCriterion = page.getByRole("checkbox", {
    name: /Enable criterion: Flag missing a11y notes/i,
  });
  await expect(customCriterion).toBeChecked();
  await customCriterion.uncheck();
  await expect(customCriterion).not.toBeChecked();
  await customCriterion.check();

  // Re-select node — values stay on graph state
  await page.locator('.react-flow__node[data-id="builder"]').click();
  await page.locator('.react-flow__node[data-id="reviewer"]').click();
  await page.getByRole("button", { name: "instructions", exact: true }).click();
  await expect(structured).toBeChecked();
  await expect(structured).toBeDisabled();
  await expect(
    page.getByRole("checkbox", {
      name: /Enable criterion: Flag missing a11y notes/i,
    }),
  ).toBeChecked();

  await page.locator('.react-flow__node[data-id="input"]').click();
  await expect(page.getByTestId("mission-constraints")).toHaveValue(
    /Keyboard accessible/,
  );
  await expect(acceptanceNotesField(page)).toHaveValue(
    /Inventory can be filtered/,
  );

  // Criteria stay pending until a Live Codex desktop run evaluates them.
  await page.locator('.react-flow__node[data-id="reviewer"]').click();
  await page.getByRole("button", { name: "instructions", exact: true }).click();
  await expect(page.getByTestId("criterion-concise_summary")).toHaveAttribute(
    "data-eval",
    "pending",
  );

  await page.screenshot({
    path: testInfo.outputPath("ui-inspector-criteria.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test("edge field mapping is editable and persists on the selected edge", async ({
  page,
}) => {
  await freshWorkspace(page);
  await page.locator('.react-flow__edge[data-id="e-research-builder"]').click();
  const mapping = page.getByLabel("Edge field mapping JSON");
  await expect(mapping).toBeVisible();
  await mapping.fill(
    JSON.stringify(
      {
        summary: "$.summary",
        modules: "$.data.modules",
      },
      null,
      2,
    ),
  );
  await mapping.blur();
  // Re-select edge and confirm mapping stuck (not full-payload default).
  await page.locator('.react-flow__node[data-id="builder"]').click();
  await page.locator('.react-flow__edge[data-id="e-research-builder"]').click();
  await expect(page.getByLabel("Edge field mapping JSON")).toHaveValue(
    /"modules"\s*:\s*"\$\.data\.modules"/,
  );
});
