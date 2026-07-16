import { describe, expect, it } from "vitest";
import type { Kind } from "./model";
import { KIND_POP_COLORS, kindPopColor } from "./kind-colors";

const kinds: Kind[] = [
  "agent",
  "creative",
  "approval",
  "condition",
  "merge",
  "input",
  "output",
  "note",
];

describe("kind pop colors (library ↔ canvas SSOT)", () => {
  it("defines a unique-or-shared pop color for every Kind", () => {
    for (const kind of kinds) {
      const hex = kindPopColor(kind);
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(KIND_POP_COLORS[kind]).toBe(hex);
    }
  });

  it("keeps agent distinct from approval and creative (sidebar readability)", () => {
    expect(kindPopColor("agent")).not.toBe(kindPopColor("approval"));
    expect(kindPopColor("agent")).not.toBe(kindPopColor("creative"));
    expect(kindPopColor("input")).not.toBe(kindPopColor("output"));
  });

  it("uses the same map entry for condition and merge (violet control pair)", () => {
    expect(kindPopColor("condition")).toBe(kindPopColor("merge"));
  });
});
