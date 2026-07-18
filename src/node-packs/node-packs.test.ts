import { describe, expect, it } from "vitest";
import { isWeakSpecialistPrompt } from "../specialist-defaults";
import { NEUTRAL_HARNESS_CORE } from "./harness-core";
import { instantiatePackById, instantiatePackForRole } from "./instantiate";
import {
  effectiveDeveloperInstructions,
  migrateInstructionFields,
} from "./migrate";
import { getPack, listPacksForCatalog } from "./packs";

describe("node packs", () => {
  it("lists catalog with empty-agent last", () => {
    const packs = listPacksForCatalog();
    expect(packs.length).toBeGreaterThan(5);
    expect(packs[packs.length - 1]?.id).toBe("empty-agent");
    expect(packs.every((p) => p.baseInstructions.includes("Company graph"))).toBe(
      true,
    );
  });

  it("instantiates dual instruction fields from pack", () => {
    const inst = instantiatePackById("architect");
    expect(inst).not.toBeNull();
    expect(inst!.baseInstructions).toBe(NEUTRAL_HARNESS_CORE);
    expect(inst!.developerInstructions.toLowerCase()).toMatch(/architect/);
    expect(inst!.prompt).toBe(inst!.developerInstructions);
    expect(inst!.packId).toBe("architect");
  });

  it("rehydrates pack-matched legacy prompt from pack (no double harness)", () => {
    const pack = getPack("researcher")!;
    const migrated = migrateInstructionFields({
      kind: "agent",
      packId: "researcher",
      prompt: "old single blob that must not double with harness",
    });
    expect(migrated.baseInstructions).toBe(pack.baseInstructions);
    expect(migrated.developerInstructions).toBe(pack.developerInstructions);
    expect(migrated.developerInstructions).not.toContain(
      "old single blob that must not double",
    );
  });

  it("routes unmatched legacy prompt to developer only", () => {
    const custom =
      "You are a custom analyst with a carefully authored multi-line brief.\n\nMission\n- Only answer X.";
    const migrated = migrateInstructionFields({
      kind: "agent",
      role: "Custom Analyst",
      prompt: custom,
    });
    expect(migrated.developerInstructions).toBe(custom);
    expect(migrated.baseInstructions).toBe(NEUTRAL_HARNESS_CORE);
    expect(effectiveDeveloperInstructions(migrated)).toBe(custom);
  });

  it("keeps explicit dual fields", () => {
    const migrated = migrateInstructionFields({
      kind: "agent",
      baseInstructions: "BASE",
      developerInstructions: "DEV",
      prompt: "ignored when dual set",
    });
    expect(migrated.baseInstructions).toBe("BASE");
    expect(migrated.developerInstructions).toBe("DEV");
  });

  it("maps role labels to packs", () => {
    const frontend = instantiatePackForRole("Frontend Engineer", "agent");
    expect(frontend.packId).toBe("frontend-engineer");
    const creative = instantiatePackForRole("Creative", "creative");
    expect(creative.packId).toBe("creative");
    expect(creative.kind).toBe("creative");
  });

  it("catalog Software Engineer pack instantiates a non-weak developer prompt", () => {
    // B0 / plan VII: Agent drop → role catalog → Senior Software Engineer produces
    // a non-weak contract (focused unit stand-in for catalog/pack e2e).
    const packs = listPacksForCatalog();
    const senior = packs.find((p) => p.id === "senior-software-engineer");
    expect(senior).toBeDefined();
    const inst = instantiatePackById("senior-software-engineer");
    expect(inst).not.toBeNull();
    expect(inst!.developerInstructions.length).toBeGreaterThan(120);
    expect(isWeakSpecialistPrompt(inst!.developerInstructions)).toBe(false);
    expect(inst!.baseInstructions).toContain("Company graph");
  });
});
