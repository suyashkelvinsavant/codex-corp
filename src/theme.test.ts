import { describe, expect, it } from "vitest";
import {
  buildAppearanceCssVars,
  contrastRatio,
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
});
