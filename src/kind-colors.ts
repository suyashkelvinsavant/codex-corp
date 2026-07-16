import type { Kind } from "./model";

/**
 * Single source of truth for node “pop” colors.
 * Sidebar library glyphs and canvas node identity (rail, glyph, selection)
 * MUST all resolve through this map so they never drift.
 */
export const KIND_POP_COLORS = {
  agent: "#58A6D8",
  creative: "#E07A9A",
  cron: "#F08A5D",
  approval: "#E8B45B",
  condition: "#B58AD8",
  merge: "#B58AD8",
  input: "#55D6BE",
  output: "#8D98A5",
  note: "#9AA37A",
} as const satisfies Record<Kind, string>;

export type KindPopColor = (typeof KIND_POP_COLORS)[Kind];

/** Canonical pop color for a node kind (library + canvas). */
export function kindPopColor(kind: Kind): string {
  return KIND_POP_COLORS[kind] ?? KIND_POP_COLORS.agent;
}

/** CSS custom-property name for a kind, e.g. --kind-agent. */
export function kindColorCssVar(kind: Kind): string {
  return `--kind-${kind}`;
}

/** Apply kind color tokens onto documentElement (call from appearance init). */
export function applyKindColorCssVars(
  root: CSSStyleDeclaration = document.documentElement.style,
): void {
  (Object.keys(KIND_POP_COLORS) as Kind[]).forEach((kind) => {
    root.setProperty(kindColorCssVar(kind), KIND_POP_COLORS[kind]);
  });
}
