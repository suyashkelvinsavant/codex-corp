/**
 * Appearance preferences — applied live via CSS variables (no save button).
 * All pages read tokens from documentElement so accent/mode stay E2E consistent.
 */
import { applyKindColorCssVars } from "./kind-colors";

export type ThemeMode = "dark" | "light";
export type BodyWeight = "450" | "500" | "550" | "600";

export type AppearancePrefs = {
  mode: ThemeMode;
  /** Hex accent, e.g. #55d6be */
  accent: string;
  bodyWeight: BodyWeight;
};

export const THEME_STORAGE_KEY = "codex-corp-appearance";

export const ACCENT_PRESETS: { id: string; label: string; hex: string }[] = [
  { id: "teal", label: "Foundry teal", hex: "#55d6be" },
  { id: "amber", label: "Signal amber", hex: "#e8b45b" },
  { id: "violet", label: "Circuit violet", hex: "#b58ad8" },
  { id: "coral", label: "Alert coral", hex: "#f06d6a" },
  { id: "sky", label: "Blue wire", hex: "#58a6d8" },
];

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  mode: "dark",
  accent: "#55d6be",
  bodyWeight: "500",
};

export function loadAppearance(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return {
      mode: parsed.mode === "light" ? "light" : "dark",
      accent:
        typeof parsed.accent === "string" &&
        /^#[0-9a-fA-F]{6}$/.test(parsed.accent)
          ? parsed.accent
          : DEFAULT_APPEARANCE.accent,
      bodyWeight: (["450", "500", "550", "600"] as BodyWeight[]).includes(
        parsed.bodyWeight as BodyWeight,
      )
        ? (parsed.bodyWeight as BodyWeight)
        : DEFAULT_APPEARANCE.bodyWeight,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(prefs: AppearancePrefs): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota */
  }
}

function clamp(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => clamp(x).toString(16).padStart(2, "0")).join("")}`;
}

/** Mix hex toward other color by t (0..1). */
export function mix(hex: string, other: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(hex);
  const [br, bg, bb] = hexToRgb(other);
  return rgbToHex(
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  );
}

/** Relative luminance 0..1 (sRGB). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two hex colors (WCAG). */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text color that contrasts on a solid accent fill. */
export function onAccentColor(accent: string): string {
  const black = "#0b1210";
  const white = "#f4fffc";
  return contrastRatio(accent, black) >= contrastRatio(accent, white)
    ? black
    : white;
}

/**
 * Primary CTA pair: solid fill + readable label.
 * Mid-luminance accents (e.g. amber) are darkened so text stays legible.
 */
export function primaryButtonPair(accent: string): { bg: string; fg: string } {
  const black = "#0b1210";
  const white = "#f4fffc";
  let bg = accent;
  let fg = onAccentColor(bg);
  if (contrastRatio(bg, fg) >= 3) return { bg, fg };

  // Prefer darken + light text for mid tones (amber, light violet).
  for (const t of [0.18, 0.28, 0.38, 0.5]) {
    bg = mix(accent, "#000000", t);
    fg = white;
    if (contrastRatio(bg, fg) >= 3) return { bg, fg };
  }
  // Fallback: pure black text on original accent.
  return { bg: accent, fg: black };
}

/**
 * Pure token map for CSS variables — unit-testable without a DOM.
 * Light mode never uses dark slab + pale text for selected controls.
 */
export function buildAppearanceCssVars(
  prefs: AppearancePrefs,
): Record<string, string> {
  const accent = prefs.accent;
  const onAccent = onAccentColor(accent);
  const primary = primaryButtonPair(accent);
  const bodyWeight = prefs.bodyWeight;
  const fontMedium = bodyWeight === "450" ? "500" : bodyWeight;

  const base: Record<string, string> = {
    "--accent": accent,
    "--cyan": accent,
    "--accent-on": onAccent,
    "--body-weight": bodyWeight,
    "--font-medium": fontMedium,
    "--primary-bg": primary.bg,
    "--primary-fg": primary.fg,
  };

  if (prefs.mode === "light") {
    // Soft selected surfaces: pale tint of accent + dark readable text.
    const soft = mix(accent, "#ffffff", 0.88);
    const softBorder = mix(accent, "#ffffff", 0.5);
    // Bias strongly toward near-black so selected labels stay readable.
    const softText = mix(accent, "#0b1210", 0.72);
    const edgeStroke = "#8a97a4";
    return {
      ...base,
      "--foundry": "#f2f5f7",
      "--graphite": "#e6ebf0",
      "--panel": "#ffffff",
      "--wire": "#c5ced6",
      "--wire2": "#a8b4c0",
      "--text": "#141a21",
      "--text-muted": "#3d4a56",
      "--text-dim": "#5a6774",
      "--surface": "#ffffff",
      "--surface-2": "#eef2f5",
      "--border": "#d0d8e0",
      "--topbar-bg": "#f7f9fb",
      "--shadow": "rgba(20, 30, 40, 0.12)",
      "--accent-soft": soft,
      "--accent-soft-border": softBorder,
      "--accent-soft-text": softText,
      "--nav-active-bg": soft,
      "--nav-active-fg": softText,
      "--nav-active-border": softBorder,
      "--chip-bg": soft,
      "--chip-fg": softText,
      "--hover-bg": mix(accent, "#ffffff", 0.94),
      "--hover-fg": "#141a21",
      "--edge-stroke": edgeStroke,
      "--port-bg": edgeStroke,
      "--port-border": "#ffffff",
      "--canvas-dot": "#c5ced6",
      "--minimap-mask": "rgba(242, 245, 247, 0.72)",
    };
  }

  const soft = mix(accent, "#0b0d10", 0.82);
  const softBorder = mix(accent, "#0b0d10", 0.45);
  const softText = mix(accent, "#e8eef4", 0.12);
  const edgeStroke = "#52606d";
  return {
    ...base,
    "--foundry": "#0b0d10",
    "--graphite": "#12161c",
    "--panel": "#151a21",
    "--wire": "#29313b",
    "--wire2": "#35414d",
    "--text": "#e8eef4",
    "--text-muted": "#b4c0cc",
    "--text-dim": "#8f9caa",
    "--surface": "#12171c",
    "--surface-2": "#151a20",
    "--border": "#2a333c",
    "--topbar-bg": "#0e1115",
    "--shadow": "rgba(0, 0, 0, 0.45)",
    "--accent-soft": soft,
    "--accent-soft-border": softBorder,
    "--accent-soft-text": softText,
    "--nav-active-bg": soft,
    "--nav-active-fg": softText,
    "--nav-active-border": softBorder,
    "--chip-bg": soft,
    "--chip-fg": mix(accent, "#e8eef4", 0.2),
    "--hover-bg": mix(accent, "#0b0d10", 0.9),
    "--hover-fg": "#e8eef4",
    "--edge-stroke": edgeStroke,
    "--port-bg": edgeStroke,
    "--port-border": "#151a21",
    "--canvas-dot": "#26303a",
    "--minimap-mask": "rgba(8, 10, 13, 0.76)",
  };
}

export function applyAppearance(prefs: AppearancePrefs): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", prefs.mode);
  // Drive native form controls (select popup, scrollbars) to match theme.
  root.style.colorScheme = prefs.mode;
  const vars = buildAppearanceCssVars(prefs);
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  // Kind pop colors (library ↔ canvas) — independent of theme accent
  applyKindColorCssVars(root.style);
  saveAppearance(prefs);
}

export function initAppearance(): AppearancePrefs {
  const prefs = loadAppearance();
  applyAppearance(prefs);
  return prefs;
}

/** Test helper: read computed accent tokens from document. */
export function readAppearanceTokens(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  return {
    theme: document.documentElement.getAttribute("data-theme") ?? "",
    accent: s.getPropertyValue("--accent").trim(),
    primaryBg: s.getPropertyValue("--primary-bg").trim(),
    primaryFg: s.getPropertyValue("--primary-fg").trim(),
    navActiveBg: s.getPropertyValue("--nav-active-bg").trim(),
    navActiveFg: s.getPropertyValue("--nav-active-fg").trim(),
    foundry: s.getPropertyValue("--foundry").trim(),
    text: s.getPropertyValue("--text").trim(),
    bodyWeight: s.getPropertyValue("--body-weight").trim(),
  };
}
