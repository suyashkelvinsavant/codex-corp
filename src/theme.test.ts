import { describe, expect, it } from "vitest";
import {
  accentOnSurface,
  buildAppearanceCssVars,
  contrastRatio,
  DEFAULT_APPEARANCE,
  onAccentColor,
  primaryButtonPair,
  relativeLuminance,
  type AppearancePrefs,
} from "./theme";

describe("appearance contrast tokens", () => {
  it("picks dark text on light accents and light text on dark accents", () => {
    expect(relativeLuminance("#55d6be")).toBeGreaterThan(0.45);
    expect(onAccentColor("#55d6be")).toBe("#0b1210");
    expect(onAccentColor("#1a3a5c")).toBe("#f4fffc");
  });

  it("sets light-mode selected surfaces that keep dark readable text", () => {
    const prefs: AppearancePrefs = {
      mode: "light",
      accent: "#55d6be",
      bodyWeight: "500",
    };
    const vars = buildAppearanceCssVars(prefs);
    expect(vars["--accent"]).toBe("#55d6be");
    expect(vars["--primary-fg"]).toBe("#0b1210");
    // Soft selected bg is a pale mix (high white component) — not near-black.
    const soft = vars["--nav-active-bg"];
    expect(soft.startsWith("#")).toBe(true);
    expect(relativeLuminance(soft)).toBeGreaterThan(0.7);
    const softText = vars["--nav-active-fg"];
    expect(relativeLuminance(softText)).toBeLessThan(0.4);
    // Selected nav must not be pale-on-pale or white-on-dark-slab.
    expect(relativeLuminance(soft)).toBeGreaterThan(
      relativeLuminance(softText),
    );
  });

  it("propagates custom accent into primary tokens for dark mode", () => {
    const vars = buildAppearanceCssVars({
      mode: "dark",
      accent: "#b58ad8",
      bodyWeight: "550",
    });
    expect(vars["--accent"]).toBe("#b58ad8");
    expect(vars["--cyan"]).toBe("#b58ad8");
    expect(vars["--body-weight"]).toBe("550");
    expect(vars["--nav-active-bg"].startsWith("#")).toBe(true);
    // Primary may be darkened for contrast but stays on the violet family.
    expect(vars["--primary-bg"].startsWith("#")).toBe(true);
  });

  it("keeps primary CTA contrast above WCAG large-text floor for all presets", () => {
    for (const accent of [
      "#ffffff",
      "#55d6be",
      "#e8b45b",
      "#b58ad8",
      "#f06d6a",
      "#58a6d8",
    ]) {
      const pair = primaryButtonPair(accent);
      expect(contrastRatio(pair.bg, pair.fg)).toBeGreaterThan(3);
      const vars = buildAppearanceCssVars({
        mode: "light",
        accent,
        bodyWeight: "500",
      });
      expect(
        contrastRatio(vars["--primary-bg"], vars["--primary-fg"]),
      ).toBeGreaterThan(3);
      // Soft selected never uses dark slab.
      expect(relativeLuminance(vars["--nav-active-bg"])).toBeGreaterThan(0.65);
      expect(relativeLuminance(vars["--nav-active-fg"])).toBeLessThan(0.45);
    }
  });

  it("defaults dark mode to pitch black stage, grey chrome, white accent", () => {
    expect(DEFAULT_APPEARANCE).toMatchObject({
      mode: "dark",
      accent: "#ffffff",
    });
    const vars = buildAppearanceCssVars({
      mode: "dark",
      accent: "#ffffff",
      bodyWeight: "500",
    });
    expect(vars["--foundry"]).toBe("#000000");
    expect(vars["--topbar-bg"]).toBe("#141416");
    expect(vars["--panel"]).toBe("#141416");
    expect(vars["--surface-2"]).toBe("#1a1a1e");
    expect(vars["--accent"]).toBe("#ffffff");
    expect(vars["--primary-bg"]).toBe("#ffffff");
    expect(vars["--primary-fg"]).toBe("#0b1210");
    expect(relativeLuminance(vars["--foundry"])).toBeLessThan(0.02);
    // Chrome sits clearly above pure black so sidebars/bottom bars read as grey.
    expect(relativeLuminance(vars["--panel"])).toBeGreaterThan(
      relativeLuminance(vars["--foundry"]),
    );
  });

  it("keeps icons/chips readable when light mode uses white accent", () => {
    expect(accentOnSurface("#ffffff", "#ffffff")).not.toBe("#ffffff");
    expect(
      contrastRatio(accentOnSurface("#ffffff", "#ffffff"), "#ffffff"),
    ).toBeGreaterThan(3);

    const vars = buildAppearanceCssVars({
      mode: "light",
      accent: "#ffffff",
      bodyWeight: "500",
    });
    // Pure white stays available for fills (primary buttons).
    expect(vars["--accent"]).toBe("#ffffff");
    expect(vars["--primary-bg"]).toBe("#ffffff");
    // Mark token is darkened for paint-on-surface (icons, version chips, tabs).
    expect(vars["--accent-mark"]).toBeDefined();
    expect(vars["--accent-mark"].toLowerCase()).not.toBe("#ffffff");
    expect(
      contrastRatio(vars["--accent-mark"], vars["--panel"]),
    ).toBeGreaterThan(3);
    // Soft chip wash is not pure white-on-white.
    expect(relativeLuminance(vars["--chip-bg"])).toBeLessThan(0.95);
    expect(relativeLuminance(vars["--chip-fg"])).toBeLessThan(0.4);
  });

  it("keeps accent-mark high-contrast on dark chrome for white accent", () => {
    const vars = buildAppearanceCssVars({
      mode: "dark",
      accent: "#ffffff",
      bodyWeight: "500",
    });
    expect(vars["--accent-mark"].toLowerCase()).toBe("#ffffff");
    expect(
      contrastRatio(vars["--accent-mark"], vars["--panel"]),
    ).toBeGreaterThan(3);
  });
});
