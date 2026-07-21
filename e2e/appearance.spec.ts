import { expect, test, type Page } from "@playwright/test";
import { makeTestWorkflow } from "../src/test-workflow-fixture";

async function resetAppearance(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("codex-corp-appearance");
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith("codex-corp-workflow:") ||
        key.startsWith("codex-corp-chat") ||
        key.startsWith("codex-corp-chat-sessions:")
      ) {
        localStorage.removeItem(key);
      }
    }
    localStorage.removeItem("codex-corp-active-workflow");
    localStorage.removeItem("codex-corp-runs");
  });
  await page.evaluate(
    (workflow) =>
      localStorage.setItem(
        "codex-corp-custom-workflows",
        JSON.stringify([workflow]),
      ),
    JSON.parse(JSON.stringify(makeTestWorkflow())),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
}

/** Sidebar primary nav (not overview tabs that reuse the same labels). */
function sidebarNav(page: Page, name: string) {
  return page.getByLabel("Primary").getByRole("button", { name, exact: true });
}

function workspaceTab(page: Page, name: string) {
  return page
    .getByLabel("Workspace views")
    .getByRole("tab", { name, exact: true });
}

async function openWorkspaceView(page: Page, name: string) {
  await sidebarNav(page, "Workspace").click();
  const tab = workspaceTab(page, name);
  await tab.click();
  return tab;
}

async function openSettings(page: Page) {
  await sidebarNav(page, "Settings").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Appearance/i })).toBeVisible();
}

async function readTokens(page: Page) {
  return page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      accent: s.getPropertyValue("--accent").trim(),
      primaryBg: s.getPropertyValue("--primary-bg").trim(),
      primaryFg: s.getPropertyValue("--primary-fg").trim(),
      navBg: s.getPropertyValue("--nav-active-bg").trim(),
      navFg: s.getPropertyValue("--nav-active-fg").trim(),
      foundry: s.getPropertyValue("--foundry").trim(),
      bodyWeight: s.getPropertyValue("--body-weight").trim(),
      text: s.getPropertyValue("--text").trim(),
    };
  });
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Perceptual brightness 0–255 for rgb()/rgba()/color(srgb …) computed colors. */
function rgbBrightness(color: string): number {
  const s = color.trim().toLowerCase();
  if (!s || s === "transparent") return 255;
  // color(srgb r g b / a) — channels are 0..1 floats
  const srgb = s.match(
    /color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*[0-9.]+)?\s*\)/,
  );
  if (srgb) {
    const r = Math.round(parseFloat(srgb[1]) * 255);
    const g = Math.round(parseFloat(srgb[2]) * 255);
    const b = Math.round(parseFloat(srgb[3]) * 255);
    return (r * 299 + g * 587 + b * 114) / 1000;
  }
  // rgb(r, g, b) or rgba(r, g, b, a) — 0..255
  const rgb = s.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/);
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    return (r * 299 + g * 587 + b * 114) / 1000;
  }
  // Fallback: first three integers (legacy)
  const ints = s.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  return (ints[0] * 299 + ints[1] * 587 + ints[2] * 114) / 1000;
}

async function assertReadableSelected(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  mode: "light" | "dark",
) {
  await expect(locator).toBeVisible();
  const styles = await effectiveSurface(locator);
  const textBright = rgbBrightness(styles.color);
  const bgBright = rgbBrightness(styles.background);
  if (mode === "light") {
    // Dark-ish text on pale selected surface (not white-on-dark).
    expect(textBright).toBeLessThan(140);
    expect(bgBright).toBeGreaterThan(180);
  } else {
    // Text is not near-black on dark selected surface.
    expect(textBright).toBeGreaterThan(120);
  }
}

async function setAccent(page: Page, label: string, hex: string) {
  await openSettings(page);
  await page.getByRole("button", { name: label }).click();
  const tokens = await readTokens(page);
  expect(tokens.accent.toLowerCase()).toBe(hex.toLowerCase());
  return tokens;
}

/** Resolve effective solid background (walk ancestors if transparent). */
async function effectiveSurface(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((el) => {
    let node: Element | null = el;
    let background = "rgba(0, 0, 0, 0)";
    while (node && node instanceof Element) {
      const s = getComputedStyle(node);
      const bg = s.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        background = bg;
        break;
      }
      node = node.parentElement;
    }
    const s = getComputedStyle(el);
    return { color: s.color, background };
  });
}

/** Assert an element is a light surface with dark readable text (not residual dark chrome). */
async function assertLightSurface(
  locator: ReturnType<Page["locator"]>,
  opts: { minBg?: number; maxText?: number } = {},
) {
  const minBg = opts.minBg ?? 200;
  const maxText = opts.maxText ?? 120;
  await expect(locator).toBeVisible();
  const styles = await effectiveSurface(locator);
  const bg = rgbBrightness(styles.background);
  const fg = rgbBrightness(styles.color);
  // Reject near-black chrome (#0e1217 / #141920 territory).
  expect(bg).toBeGreaterThan(minBg);
  expect(fg).toBeLessThan(maxText);
  return styles;
}

async function enableLightMode(page: Page) {
  await openSettings(page);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  const tokens = await readTokens(page);
  expect(tokens.theme).toBe("light");
  return tokens;
}

test.describe("appearance theme E2E", () => {
  test("light mode keeps selected controls readable and accent propagates to all pages", async ({
    page,
  }) => {
    await resetAppearance(page);
    await openSettings(page);

    const light = page.getByRole("button", { name: "Light", exact: true });
    await light.click();

    let tokens = await readTokens(page);
    expect(tokens.theme).toBe("light");
    expect(tokens.foundry.toLowerCase()).not.toBe("#0b0d10");
    expect(contrastRatio(tokens.primaryBg, tokens.primaryFg)).toBeGreaterThan(
      3,
    );
    expect(luminance(tokens.navBg)).toBeGreaterThan(0.7);
    expect(luminance(tokens.navFg)).toBeLessThan(0.45);
    expect(contrastRatio(tokens.navBg, tokens.navFg)).toBeGreaterThan(3);

    // Selected Light mode toggle itself must stay readable.
    await assertReadableSelected(page, light, "light");

    // Selected sidebar nav uses soft tokens.
    const workflowsNav = await openWorkspaceView(page, "Workflows");
    await expect(
      page.getByRole("heading", { name: "Workflows" }),
    ).toBeVisible();
    await assertReadableSelected(page, workflowsNav, "light");

    // Change accent to circuit violet — must stick across pages.
    await setAccent(page, "Circuit violet", "#b58ad8");
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");
    // Primary fill stays violet-family and contrasts with label.
    expect(contrastRatio(tokens.primaryBg, tokens.primaryFg)).toBeGreaterThan(
      3,
    );
    expect(tokens.theme).toBe("light");

    // —— Workflows page + sidebar brand ——
    await openWorkspaceView(page, "Workflows");
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");
    expect(tokens.theme).toBe("light");
    const brandAccent = await page
      .locator(".overview-nav .brand-mark span")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // violet rgb ~ (181, 138, 216)
    expect(brandAccent).toMatch(/rgb\(/);
    const brandRgb = brandAccent.match(/\d+/g)?.map(Number) ?? [];
    expect(brandRgb[0]).toBeGreaterThan(120);
    expect(brandRgb[2]).toBeGreaterThan(150);

    const editBtn = page.locator(".workflow-edit").first();
    await assertReadableSelected(page, editBtn, "light");

    // —— Templates page ——
    await openWorkspaceView(page, "Templates");
    await expect(
      page.getByRole("heading", { name: "Templates" }),
    ).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");
    expect(tokens.theme).toBe("light");
    await assertReadableSelected(
      page,
      workspaceTab(page, "Templates"),
      "light",
    );

    // —— Executions page ——
    await openWorkspaceView(page, "Executions");
    await expect(
      page.getByRole("heading", { name: "Executions" }),
    ).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");
    expect(tokens.theme).toBe("light");

    // —— Settings page (mode + accent still active) ——
    await openSettings(page);
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");
    expect(tokens.theme).toBe("light");
    await assertReadableSelected(
      page,
      page.getByRole("button", { name: "Light", exact: true }),
      "light",
    );

    // —— Chat page inherits accent + theme ——
    await openWorkspaceView(page, "Workflows");
    await page.locator(".workflow-card").first().click();
    await expect(page.locator(".agent-chat-edit")).toBeVisible();
    await expect(page.getByText("Brief Byte")).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.theme).toBe("light");
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");

    const newChat = page.locator(".agent-chat-new");
    await expect(newChat).toBeVisible();
    await assertReadableSelected(page, newChat, "light");

    // Chat rail brand uses accent.
    const railMark = page
      .locator(".agent-chat-rail-mark, .brand-mark span")
      .first();
    if (await railMark.count()) {
      const markColor = await railMark.evaluate((el) => {
        const s = getComputedStyle(el);
        return s.backgroundColor !== "rgba(0, 0, 0, 0)"
          ? s.backgroundColor
          : s.color;
      });
      expect(markColor).toMatch(/rgb\(/);
    }

    // —— Editor page inherits the same appearance ——
    await page.locator(".agent-chat-edit").click();
    await expect(
      page
        .locator(".commandbar")
        .getByRole("button", { name: "Fit", exact: true }),
    ).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.theme).toBe("light");
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");

    const editorOverview = page.locator(".commandbar .workflow-back");
    await expect(editorOverview).toBeVisible();
    const editorOverviewStyles = await editorOverview.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    // Light-mode chip: darkish text on soft accent fill
    expect(rgbBrightness(editorOverviewStyles.color)).toBeLessThan(200);

    // Topbar brand still violet.
    const editorBrand = await page
      .locator(".topbar .brand-mark span")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const er = editorBrand.match(/\d+/g)?.map(Number) ?? [];
    expect(er[0]).toBeGreaterThan(120);
    expect(er[2]).toBeGreaterThan(150);

    // Persist across reload (lands on overview/workflows)
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Workflows" }),
    ).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.theme).toBe("light");
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");
  });

  test("dark mode accent and body weight apply on templates and sidebar", async ({
    page,
  }) => {
    await resetAppearance(page);
    await openSettings(page);
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByRole("button", { name: "Alert coral" }).click();
    await page.getByRole("button", { name: "Semibold", exact: true }).click();

    let tokens = await readTokens(page);
    expect(tokens.theme).toBe("dark");
    expect(tokens.accent.toLowerCase()).toBe("#f06d6a");
    expect(tokens.bodyWeight).toBe("600");

    await openWorkspaceView(page, "Templates");
    await expect(
      page.getByRole("heading", { name: "Templates" }),
    ).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#f06d6a");
    expect(tokens.theme).toBe("dark");

    const templatesNav = workspaceTab(page, "Templates");
    await assertReadableSelected(page, templatesNav, "dark");

    const brand = await page
      .locator(".overview-nav .brand-mark span")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // coral #f06d6a ≈ rgb(240, 109, 106)
    const rgb = brand.match(/\d+/g)?.map(Number) ?? [];
    expect(rgb[0]).toBeGreaterThan(200);
    expect(rgb[1]).toBeLessThan(140);
  });

  test("each overview section and editor keep accent after change", async ({
    page,
  }) => {
    await resetAppearance(page);
    await setAccent(page, "Blue wire", "#58a6d8");

    const sections: { nav: string; heading: string }[] = [
      { nav: "Workflows", heading: "Workflows" },
      { nav: "Templates", heading: "Templates" },
      { nav: "Executions", heading: "Executions" },
      { nav: "Settings", heading: "Settings" },
    ];

    for (const { nav, heading } of sections) {
      if (nav === "Settings") {
        await openSettings(page);
      } else {
        await openWorkspaceView(page, nav);
      }
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      const tokens = await readTokens(page);
      expect(tokens.accent.toLowerCase()).toBe("#58a6d8");
      const activeNav =
        nav === "Settings" ? sidebarNav(page, nav) : workspaceTab(page, nav);
      const styles = await effectiveSurface(activeNav);
      expect(styles.color).toBeTruthy();
      expect(styles.background).toBeTruthy();
      expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
    }

    await openWorkspaceView(page, "Workflows");
    await page.locator(".workflow-edit").first().click();
    await expect(
      page
        .locator(".commandbar")
        .getByRole("button", { name: "Fit", exact: true }),
    ).toBeVisible();
    let tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#58a6d8");

    // Compatibility modal (settings) also themed
    await page.locator(".commandbar .workflow-back").click();
    await expect(
      page.getByRole("heading", { name: "Workflows" }),
    ).toBeVisible();
    await openSettings(page);
    await page
      .getByRole("button", { name: /Open compatibility panel/i })
      .click();
    await expect(page.getByRole("dialog", { name: /Runtime/i })).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#58a6d8");
    await page.getByRole("button", { name: "Done" }).click();
  });

  test("chat page and editor share accent after violet selection in light mode", async ({
    page,
  }) => {
    await resetAppearance(page);
    await openSettings(page);
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page
      .getByRole("button", { name: "Signal amber", exact: true })
      .click();

    let tokens = await readTokens(page);
    expect(tokens.theme).toBe("light");
    expect(tokens.accent.toLowerCase()).toBe("#e8b45b");

    await openWorkspaceView(page, "Workflows");
    await page.locator(".workflow-card").first().click();
    await expect(page.getByText("Brief Byte")).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#e8b45b");
    expect(tokens.theme).toBe("light");

    await page.locator(".agent-chat-edit").click();
    await expect(
      page
        .locator(".commandbar")
        .getByRole("button", { name: "Fit", exact: true }),
    ).toBeVisible();
    tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#e8b45b");
    expect(tokens.theme).toBe("light");
  });

  test("light mode surfaces: executions, compatibility modal, chat, editor chrome", async ({
    page,
  }) => {
    await resetAppearance(page);
    await enableLightMode(page);

    // —— Executions: list/empty not dark-on-dark ——
    await openWorkspaceView(page, "Executions");
    await expect(
      page.getByRole("heading", { name: "Executions" }),
    ).toBeVisible();
    await assertLightSurface(page.locator(".overview-list-panel").first());
    await assertLightSurface(page.locator(".overview-main").first(), {
      minBg: 180,
    });
    const execEmptyOrRow = page
      .locator(".execution-row, .workflow-empty")
      .first();
    await expect(execEmptyOrRow).toBeVisible();
    const execStyles = await execEmptyOrRow.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    // Body/empty text must be dark enough to read on light page.
    expect(rgbBrightness(execStyles.color)).toBeLessThan(160);
    // Row background (if row) should be light; empty may be transparent so skip bg floor then.
    if (await page.locator(".execution-row").count()) {
      await assertLightSurface(page.locator(".execution-row").first());
    }

    // —— Compatibility panel: light modal chrome ——
    await openSettings(page);
    await page
      .getByRole("button", { name: /Open compatibility panel/i })
      .click();
    const dialog = page.getByRole("dialog", { name: /Runtime/i });
    await expect(dialog).toBeVisible();
    const modal = page.locator(".compatibility-modal");
    await assertLightSurface(modal);
    const modalTitle = modal.locator("h2").first();
    await assertLightSurface(modalTitle, { minBg: 200, maxText: 80 });
    const modalBody = modal.locator(".metric span").first();
    const bodyStyles = await modalBody.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    expect(rgbBrightness(bodyStyles.color)).toBeLessThan(160);
    // Inputs (if present) are light.
    const modalInput = modal.locator("input").first();
    if (await modalInput.count()) {
      const inputStyles = await modalInput.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      expect(rgbBrightness(inputStyles.background)).toBeGreaterThan(180);
      expect(rgbBrightness(inputStyles.color)).toBeLessThan(140);
    }
    // Reject classic dark modal hex winners via brightness (not hardcoded hex strings).
    const modalBgBright = rgbBrightness(
      await modal.evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    expect(modalBgBright).toBeGreaterThan(200);
    await page.getByRole("button", { name: "Done" }).click();

    // —— Chat shell/rail/stage ——
    await openWorkspaceView(page, "Workflows");
    await page.locator(".workflow-card").first().click();
    await expect(page.getByText("Brief Byte")).toBeVisible();
    await assertLightSurface(page.locator(".agent-chat-shell"), { minBg: 180 });
    await assertLightSurface(page.locator(".agent-chat-rail"), { minBg: 200 });
    await assertLightSurface(page.locator(".agent-chat-stage"), { minBg: 180 });
    await assertLightSurface(page.locator(".agent-chat-top h1"), {
      minBg: 180,
      maxText: 80,
    });
    await assertLightSurface(page.locator(".agent-composer"), { minBg: 200 });

    // —— Editor chrome ——
    await page.locator(".agent-chat-edit").click();
    await expect(
      page
        .locator(".commandbar")
        .getByRole("button", { name: "Fit", exact: true }),
    ).toBeVisible();
    await assertLightSurface(page.locator(".app-shell"), { minBg: 180 });
    await assertLightSurface(page.locator(".topbar"), { minBg: 200 });
    await assertLightSurface(page.locator(".commandbar"), { minBg: 200 });
    await assertLightSurface(page.locator(".node-library"), { minBg: 200 });
    await assertLightSurface(page.locator(".inspector"), { minBg: 200 });
    await assertLightSurface(page.locator(".canvas-panel"), { minBg: 180 });
    // Inspector body text not near-white on dark.
    const inspectorHeader = page
      .locator(".inspector-header h2, .inspector-header")
      .first();
    if (await inspectorHeader.count()) {
      const ih = await inspectorHeader.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      expect(rgbBrightness(ih.color)).toBeLessThan(120);
    }

    // Nested residual chrome: inspector action bar (non-primary buttons).
    const inspectorActions = page.locator(".inspector-actions");
    await expect(inspectorActions).toBeVisible();
    await assertLightSurface(inspectorActions, { minBg: 200 });
    const nonPrimary = inspectorActions.locator("button:not(.primary)").first();
    await expect(nonPrimary).toBeVisible();
    await assertLightSurface(nonPrimary, { minBg: 180, maxText: 100 });
    // Primary stays high-contrast but may be accent-colored (not required light bg).
    const primary = inspectorActions.locator("button.primary").first();
    if (await primary.count()) {
      const pStyles = await primary.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      // Must not be pale-on-pale or white-on-near-black residual.
      expect(rgbBrightness(pStyles.color)).not.toBeNaN();
      expect(rgbBrightness(pStyles.background)).toBeGreaterThan(40);
    }

    // Nested residual chrome: workflow identity trigger and editor modal.
    const workflowIdentity = page.locator(".workflow-identity-trigger");
    await expect(workflowIdentity).toBeVisible();
    await assertLightSurface(workflowIdentity, { minBg: 180, maxText: 100 });
    await workflowIdentity.click();
    const workflowName = page.getByRole("textbox", { name: "Workflow name" });
    await expect(workflowName).toBeVisible();
    const nameStyles = await effectiveSurface(workflowName);
    expect(rgbBrightness(nameStyles.color)).toBeLessThan(100);
    expect(rgbBrightness(nameStyles.background)).toBeGreaterThan(180);
    await page.getByRole("button", { name: "Cancel" }).click();

    const overviewChip = page.locator(".commandbar .workflow-back");
    await expect(overviewChip).toBeVisible();
    await assertLightSurface(overviewChip, { minBg: 180, maxText: 100 });

    // Top-actions non-primary (Validate) must not be dark slab + pale text.
    const validateBtn = page
      .locator(".top-actions button")
      .filter({ hasText: /Validate/i });
    await expect(validateBtn).toBeVisible();
    await assertLightSurface(validateBtn, { minBg: 180, maxText: 100 });

    // Header Codex health chip (top-actions) — never residual dark slab.
    const codexHealth = page.locator(".top-actions .codex-health");
    await expect(codexHealth).toBeVisible();
    const badgeStyles = await effectiveSurface(codexHealth);
    expect(rgbBrightness(badgeStyles.background)).toBeGreaterThan(160);
    // Label remains readable (darkish on pale, or amber-tinted on pale for .fault).
    expect(rgbBrightness(badgeStyles.color)).toBeLessThan(200);

    // Control inspector banner (Entry/input node) — not #141a20 black card.
    // Seed if graph empty, then select the mission input node.
    const seedBtn = page.getByRole("button", { name: "Seed", exact: true });
    if (await seedBtn.isEnabled()) {
      await seedBtn.click();
    }
    const inputNode = page.locator('.react-flow__node[data-id="input"]');
    await expect(inputNode).toBeVisible({ timeout: 10_000 });
    await inputNode.click();
    const controlBanner = page.locator(".control-banner");
    await expect(controlBanner).toBeVisible();
    await assertLightSurface(controlBanner, { minBg: 180, maxText: 100 });
    const bannerTitle = controlBanner.locator("b").first();
    await expect(bannerTitle).toBeVisible();
    const bannerTitleStyles = await effectiveSurface(bannerTitle);
    expect(rgbBrightness(bannerTitleStyles.color)).toBeLessThan(100);
    expect(rgbBrightness(bannerTitleStyles.background)).toBeGreaterThan(180);
    const bannerBody = controlBanner.locator("small").first();
    await expect(bannerBody).toBeVisible();
    const bannerBodyStyles = await effectiveSurface(bannerBody);
    expect(rgbBrightness(bannerBodyStyles.color)).toBeLessThan(160);

    // Graph nodes: light panel body (not #151a21), soft icon glyph chips.
    const anyNode = page.locator(".corp-node").first();
    await expect(anyNode).toBeVisible();
    // Deselect via canvas empty area so we sample unselected surface.
    await page.locator(".canvas-panel").click({ position: { x: 20, y: 20 } });
    const unselected = page.locator(".corp-node:not(.selected)").first();
    await expect(unselected).toBeVisible();
    const unselectedStyles = await unselected.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    expect(rgbBrightness(unselectedStyles.background)).toBeGreaterThan(200);
    expect(rgbBrightness(unselectedStyles.color)).toBeLessThan(100);

    // Select agent node for selected wash + glyph.
    const agentNode = page.locator('.react-flow__node[data-id="research"]');
    await expect(agentNode).toBeVisible();
    await agentNode.click();
    const selectedCard = agentNode.locator(".corp-node");
    await expect(selectedCard).toHaveClass(/selected/);
    const selectedStyles = await selectedCard.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    // Selected is soft wash of panel — still light, not near-black.
    expect(rgbBrightness(selectedStyles.background)).toBeGreaterThan(180);
    expect(rgbBrightness(selectedStyles.color)).toBeLessThan(100);

    const roleGlyph = selectedCard.locator(".role-glyph");
    await expect(roleGlyph).toBeVisible();
    const glyphStyles = await roleGlyph.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    // Icon background is a pale tint (light), not dark #141a20.
    expect(rgbBrightness(glyphStyles.background)).toBeGreaterThan(180);

    // Library sidebar icon chips also light-tinted.
    const libGlyph = page.locator(".library-glyph").first();
    await expect(libGlyph).toBeVisible();
    const libStyles = await libGlyph.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    expect(rgbBrightness(libStyles.background)).toBeGreaterThan(180);

    // If legacy picker trigger is ever re-mounted, keep it light.
    const legacyPicker = page.locator(".workflow-picker-trigger");
    if (await legacyPicker.count()) {
      await assertLightSurface(legacyPicker, { minBg: 180, maxText: 100 });
      await legacyPicker.click();
      const menu = page.locator(".workflow-picker-menu");
      if (await menu.count()) {
        await assertLightSurface(menu, { minBg: 200, maxText: 100 });
      }
    }
  });

  test("workflow cards, templates version, and execution drawer tabs are themed and readable", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await resetAppearance(page);
    await enableLightMode(page);
    // Distinct accent so version / dots / icons prove token wiring.
    await page.getByRole("button", { name: "Circuit violet" }).click();
    let tokens = await readTokens(page);
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");

    // —— Workflow list card icon chip (not dark #1a242c) ——
    await openWorkspaceView(page, "Workflows");
    await expect(
      page.getByRole("heading", { name: "Workflows" }),
    ).toBeVisible();
    const cardIcon = page.locator(".workflow-card-icon").first();
    await expect(cardIcon).toBeVisible();
    const iconStyles = await cardIcon.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    expect(rgbBrightness(iconStyles.background)).toBeGreaterThan(180);
    // Icon ink is violet-ish (accent), not near-black.
    expect(rgbBrightness(iconStyles.color)).toBeGreaterThan(80);

    // —— Templates: version badge uses accent + readable body type ——
    await openWorkspaceView(page, "Templates");
    await expect(
      page.getByRole("heading", { name: "Templates" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add template", exact: true })
      .click();
    const templatePicker = page.getByRole("dialog", {
      name: "Add workflows as templates",
    });
    await templatePicker.locator('input[type="checkbox"]').first().check();
    await templatePicker
      .getByRole("button", { name: "Add 1 template", exact: true })
      .click();
    const version = page
      .locator(".template-card .workflow-version-tag")
      .first();
    await expect(version).toBeVisible();
    const versionStyles = await version.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        color: s.color,
        fontSize: parseFloat(s.fontSize),
        fontFamily: s.fontFamily,
        fontWeight: s.fontWeight,
      };
    });
    // Accent color (violet channels), not grey.
    const vRgb = versionStyles.color.match(/\d+/g)?.map(Number) ?? [];
    expect(vRgb[0]).toBeGreaterThan(120);
    expect(vRgb[2]).toBeGreaterThan(150);
    expect(versionStyles.fontSize).toBeGreaterThanOrEqual(10);
    const title = page.locator(".template-card h3").first();
    const titleStyles = await title.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: parseFloat(s.fontSize), color: s.color };
    });
    expect(titleStyles.fontSize).toBeGreaterThanOrEqual(14);
    expect(rgbBrightness(titleStyles.color)).toBeLessThan(80);

    // —— Editor execution drawer: every tab + empty/timeline chrome ——
    await openWorkspaceView(page, "Workflows");
    await page.locator(".workflow-edit").first().click();
    await expect(
      page
        .locator(".commandbar")
        .getByRole("button", { name: "Fit", exact: true }),
    ).toBeVisible();

    // Open EXECUTION bar if collapsed.
    const execToggle = page.locator(".drawer-toggle");
    await expect(execToggle).toBeVisible();
    if (!(await page.locator(".drawer-body").isVisible())) {
      await execToggle.click();
    }
    await expect(page.locator(".drawer-body")).toBeVisible();

    // Toggle label size / accent icon.
    const toggleStyles = await execToggle.evaluate((el) => {
      const s = getComputedStyle(el);
      const icon = el.querySelector("svg");
      const is = icon ? getComputedStyle(icon) : null;
      const b = el.querySelector("b");
      const bs = b ? getComputedStyle(b) : null;
      return {
        fontSize: parseFloat(s.fontSize),
        iconColor: is?.color ?? "",
        labelSize: bs ? parseFloat(bs.fontSize) : 0,
      };
    });
    expect(toggleStyles.labelSize).toBeGreaterThanOrEqual(11);
    expect(rgbBrightness(toggleStyles.iconColor)).toBeGreaterThan(80);

    const tabs = [
      "Timeline",
      "Runs",
      "Approvals",
      "Logs",
      "Problems",
      "Artifacts",
      "Usage",
    ] as const;

    for (const tab of tabs) {
      const tabBtn = page
        .locator(".drawer-body nav button")
        .filter({ hasText: new RegExp(`^${tab}`, "i") });
      await expect(tabBtn).toBeVisible();
      await tabBtn.click();
      await expect(tabBtn).toHaveClass(/active/);
      const tabStyles = await tabBtn.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          fontSize: parseFloat(s.fontSize),
          color: s.color,
          background: s.backgroundColor,
        };
      });
      expect(tabStyles.fontSize).toBeGreaterThanOrEqual(11);
      // Active tab is soft accent surface, not dark #182028.
      expect(rgbBrightness(tabStyles.background)).toBeGreaterThan(160);

      if (tab === "Timeline") {
        // If events exist, active dots use accent; otherwise empty is fine.
        const dots = page.locator(".event-dot");
        if ((await dots.count()) > 0) {
          const activeDot = page.locator(".event-dot.active").first();
          if (await activeDot.count()) {
            const d = await activeDot.evaluate((el) => {
              const s = getComputedStyle(el);
              return { background: s.backgroundColor, border: s.borderColor };
            });
            // Violet-ish accent fill.
            const rgb = d.background.match(/\d+/g)?.map(Number) ?? [];
            expect(rgb[0] ?? 0).toBeGreaterThan(100);
            expect(rgb[2] ?? 0).toBeGreaterThan(120);
          }
          const row = page.locator(".event-list button").first();
          const rowSize = await row.evaluate((el) =>
            parseFloat(getComputedStyle(el).fontSize),
          );
          expect(rowSize).toBeGreaterThanOrEqual(11);
        }
      }

      if (tab === "Runs") {
        const empty = page.locator(".drawer-empty");
        if (await empty.count()) {
          await expect(empty).toContainText(/No previous runs/i);
          const emptyStyles = await empty.evaluate((el) => {
            const s = getComputedStyle(el);
            const icon = el.querySelector("svg");
            const is = icon ? getComputedStyle(icon) : null;
            return {
              fontSize: parseFloat(s.fontSize),
              color: s.color,
              iconColor: is?.color ?? "",
            };
          });
          expect(emptyStyles.fontSize).toBeGreaterThanOrEqual(12);
          expect(rgbBrightness(emptyStyles.color)).toBeLessThan(160);
          // Accent icon (violet).
          const irgb = emptyStyles.iconColor.match(/\d+/g)?.map(Number) ?? [];
          expect(irgb[0] ?? 0).toBeGreaterThan(100);
          expect(irgb[2] ?? 0).toBeGreaterThan(120);
        }
      }

      if (tab === "Problems" || tab === "Artifacts") {
        const empty = page.locator(".drawer-empty");
        if (await empty.count()) {
          const emptyStyles = await empty.evaluate((el) => {
            const s = getComputedStyle(el);
            const icon = el.querySelector("svg");
            const is = icon ? getComputedStyle(icon) : null;
            return {
              fontSize: parseFloat(s.fontSize),
              iconColor: is?.color ?? "",
            };
          });
          expect(emptyStyles.fontSize).toBeGreaterThanOrEqual(12);
          if (emptyStyles.iconColor) {
            expect(rgbBrightness(emptyStyles.iconColor)).toBeGreaterThan(80);
          }
        }
      }
    }

    // Left library resizer: accent highlight + drag changes --library-width.
    const libraryResizer = page.locator(".library-resizer");
    await expect(libraryResizer).toBeVisible();
    const widthBefore = await page.evaluate(() =>
      getComputedStyle(document.querySelector(".workspace")!)
        .getPropertyValue("--library-width")
        .trim(),
    );
    await libraryResizer.hover();
    const libResizerStyles = await libraryResizer.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        boxShadow: s.boxShadow,
        cursor: s.cursor,
      };
    });
    expect(libResizerStyles.cursor).toMatch(/col-resize|ew-resize/);
    expect(libResizerStyles.boxShadow).toMatch(/rgb\(|rgba\(|color\(/i);
    const libShadowRgb =
      libResizerStyles.boxShadow.match(/\d+/g)?.map(Number) ?? [];
    expect(libShadowRgb.some((channel) => channel > 120)).toBe(true);
    const libBox = await libraryResizer.boundingBox();
    expect(libBox).not.toBeNull();
    await page.mouse.move(libBox!.x + libBox!.width / 2, libBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(libBox!.x + libBox!.width / 2 + 48, libBox!.y + 40, {
      steps: 6,
    });
    await page.mouse.up();
    const widthAfter = await page.evaluate(() =>
      getComputedStyle(document.querySelector(".workspace")!)
        .getPropertyValue("--library-width")
        .trim(),
    );
    expect(widthAfter).not.toBe(widthBefore);
    expect(parseInt(widthAfter, 10)).toBeGreaterThan(parseInt(widthBefore, 10));

    // Inspector + execution drawer resizers highlight with accent (not hard-coded teal).
    const inspectorResizer = page.locator(".inspector-resizer");
    await expect(inspectorResizer).toBeVisible();
    await inspectorResizer.hover();
    const resizerStyles = await inspectorResizer.evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, boxShadow: s.boxShadow };
    });
    // Accent wash present (violet under Circuit violet selection).
    expect(resizerStyles.boxShadow).toMatch(/rgb\(|rgba\(|color\(/i);
    expect(resizerStyles.boxShadow).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\)/);
    const shadowRgb = resizerStyles.boxShadow.match(/\d+/g)?.map(Number) ?? [];
    expect(shadowRgb.some((channel) => channel > 120)).toBe(true);

    // Open drawer so horizontal resizer mounts, then check its hover ring.
    if (!(await page.locator(".drawer-body").isVisible())) {
      await page.locator(".drawer-toggle").click();
    }
    const drawerResizer = page.locator(".drawer-resizer");
    await expect(drawerResizer).toBeVisible();
    await drawerResizer.hover();
    const drawerResizerStyles = await drawerResizer.evaluate((el) => {
      const s = getComputedStyle(el);
      return { boxShadow: s.boxShadow, background: s.backgroundColor };
    });
    expect(drawerResizerStyles.boxShadow).toMatch(/rgb\(|rgba\(|color\(/i);
    const dRgb = drawerResizerStyles.boxShadow.match(/\d+/g)?.map(Number) ?? [];
    expect(dRgb.some((channel) => channel > 120)).toBe(true);

    tokens = await readTokens(page);
    expect(tokens.theme).toBe("light");
    expect(tokens.accent.toLowerCase()).toBe("#b58ad8");

    // Collapsible library / inspector / execution bar.
    await page.getByRole("button", { name: "Collapse node library" }).click();
    await expect(page.locator(".workspace")).toHaveClass(/library-collapsed/);
    await expect(
      page.getByRole("button", { name: "Expand node library" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Expand node library" }).click();
    await expect(page.locator(".workspace")).not.toHaveClass(
      /library-collapsed/,
    );

    await page.getByRole("button", { name: "Collapse inspector" }).click();
    await expect(page.locator(".workspace")).toHaveClass(/inspector-collapsed/);
    await page.getByRole("button", { name: "Expand inspector" }).click();
    await expect(page.locator(".workspace")).not.toHaveClass(
      /inspector-collapsed/,
    );

    // Bottom execution bar already toggles via EXECUTION control.
    const wasDrawerOpen = await page.locator(".drawer-body").isVisible();
    await page.locator(".drawer-toggle").click();
    if (wasDrawerOpen) {
      await expect(page.locator(".drawer-body")).toBeHidden();
    } else {
      await expect(page.locator(".drawer-body")).toBeVisible();
    }
    await page.locator(".drawer-toggle").click(); // restore

    // Agent inspector tabs follow light surfaces + accent active tab.
    const agentNode = page.locator('.react-flow__node[data-id="research"]');
    await agentNode.click();
    await expect(page.locator(".inspector-tabs")).toBeVisible();
    const inspectorTabs = [
      "overview",
      "instructions",
      "context",
      "I/O",
      "tools",
      "trace",
      "config",
    ];
    for (const name of inspectorTabs) {
      const tab = page
        .locator(".inspector-tabs button")
        .filter({ hasText: new RegExp(`^${name}$`, "i") });
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveClass(/active/);
      const tabColor = await tab.evaluate((el) => getComputedStyle(el).color);
      // Active tab uses accent (violet) — not pure grey.
      const rgb = tabColor.match(/\d+/g)?.map(Number) ?? [];
      expect(rgb[0] ?? 0).toBeGreaterThan(80);
      const content = page.locator(".inspector-content");
      const contentStyles = await content.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      expect(rgbBrightness(contentStyles.background)).toBeGreaterThan(180);
      expect(rgbBrightness(contentStyles.color)).toBeLessThan(120);

      if (name === "context") {
        const row = page.locator(".context-row").first();
        if (await row.count()) {
          const rs = await row.evaluate((el) => {
            const s = getComputedStyle(el);
            return { color: s.color, background: s.backgroundColor };
          });
          expect(rgbBrightness(rs.background)).toBeGreaterThan(160);
          expect(rgbBrightness(rs.color)).toBeLessThan(140);
        }
      }
    }

    // Port connectors use themed colors (not fixed dark fill only).
    const port = page.locator(".port").first();
    await expect(port).toBeVisible();
    const portBg = await port.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(portBg).toMatch(/rgb|color\(/i);

    // Config tab selects: light surface + accent focus highlight (not hard-coded teal).
    const configTab = page
      .locator(".inspector-tabs button")
      .filter({ hasText: /^config$/i });
    await configTab.click();
    const configSelect = page.locator(".inspect-section select").first();
    await expect(configSelect).toBeVisible();
    const selectMeta = await configSelect.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        color: s.color,
        background: s.backgroundColor,
        accentColor: s.accentColor,
        colorScheme: s.colorScheme,
      };
    });
    expect(rgbBrightness(selectMeta.background)).toBeGreaterThan(180);
    expect(rgbBrightness(selectMeta.color)).toBeLessThan(100);
    // accent-color CSS property should be the theme accent (violet).
    const accentToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
        .toLowerCase(),
    );
    expect(accentToken).toBe("#b58ad8");
    // Computed accent-color may be rgb form of the token.
    if (selectMeta.accentColor && selectMeta.accentColor !== "auto") {
      const aRgb = selectMeta.accentColor.match(/\d+/g)?.map(Number) ?? [];
      if (aRgb.length >= 3) {
        expect(aRgb[0]).toBeGreaterThan(140);
        expect(aRgb[2]).toBeGreaterThan(160);
        // Not default teal-ish (low red high green)
        expect(aRgb[1]).toBeLessThan(200);
      }
    }
    await configSelect.focus();
    const selectFocus = await configSelect.evaluate((el) => {
      const s = getComputedStyle(el);
      return { borderColor: s.borderColor, boxShadow: s.boxShadow };
    });
    expect(
      selectFocus.boxShadow !== "none" ||
        selectFocus.borderColor.match(/rgb|color\(/i),
    ).toBeTruthy();

    // Library glyphs keep kind pop colors (not forced to theme accent).
    if (
      await page
        .locator(".workspace.library-collapsed")
        .isVisible()
        .catch(() => false)
    ) {
      await page.getByRole("button", { name: "Expand node library" }).click();
    }
    await expect(page.locator(".node-library:not(.is-collapsed)")).toBeVisible({
      timeout: 5_000,
    });
    const agentGlyph = page.locator(".library-glyph.agent");
    await expect(agentGlyph).toBeVisible();
    const agentGlyphColor = await agentGlyph.evaluate(
      (el) => getComputedStyle(el).color,
    );
    // Canvas agent (research) must match library agent glyph exactly.
    const researchGlyph = page.locator(
      '.react-flow__node[data-id="research"] .role-glyph',
    );
    await expect(researchGlyph).toBeVisible();
    const canvasAgentColor = await researchGlyph.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(canvasAgentColor).toBe(agentGlyphColor);

    const approvalGlyph = page.locator(".library-glyph.approval");
    await expect(approvalGlyph).toBeVisible();
    const libraryApproval = await approvalGlyph.evaluate(
      (el) => getComputedStyle(el).color,
    );
    const approvalNode = page.locator(
      '.react-flow__node[data-id="approval"] .role-glyph',
    );
    await expect(approvalNode).toBeVisible();
    const canvasApproval = await approvalNode.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(canvasApproval).toBe(libraryApproval);
    // Approval (amber) ≠ agent (sky)
    expect(canvasApproval).not.toBe(canvasAgentColor);

    const inputGlyph = page.locator(".library-glyph.input");
    await expect(inputGlyph).toBeVisible();
    const libraryInput = await inputGlyph.evaluate(
      (el) => getComputedStyle(el).color,
    );
    const inputNode = page.locator(
      '.react-flow__node[data-id="input"] .role-glyph',
    );
    await expect(inputNode).toBeVisible();
    const canvasInput = await inputNode.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(canvasInput).toBe(libraryInput);
  });
});
