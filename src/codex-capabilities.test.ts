import { describe, expect, it } from "vitest";
import {
  capabilityRelevanceScore,
  reconcileCapabilitySelections,
  sanitizeCapabilityInventory,
} from "./codex-capabilities";

describe("Codex connector capability inventory", () => {
  it("keeps only enabled, uniquely identified connector capabilities", () => {
    const result = sanitizeCapabilityInventory({
      skills: [
        {
          name: "imagegen",
          description: "Images",
          scope: "system",
          enabled: true,
        },
        {
          name: "imagegen",
          description: "Duplicate",
          scope: "user",
          enabled: true,
        },
        { name: "disabled", description: "", scope: "user", enabled: false },
      ],
      tools: [
        {
          id: "apps::figma.generate",
          server: "apps",
          name: "figma.generate",
          title: "Generate",
          description: "",
          readOnly: false,
          destructive: false,
        },
        {
          id: "apps::figma.generate",
          server: "apps",
          name: "figma.generate",
          title: "Duplicate",
          description: "",
          readOnly: false,
          destructive: false,
        },
      ],
      skillErrors: [],
      collaborationModes: [],
      permissionProfiles: [],
      apps: [],
      hooks: [],
      provider: {
        namespaceTools: true,
        imageGeneration: true,
        webSearch: true,
      },
      enabledRuntimeFeatures: ["apps"],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(["imagegen"]);
    expect(result.tools.map((tool) => tool.id)).toEqual([
      "apps::figma.generate",
    ]);
  });

  it("ranks capabilities from node context without granting them", () => {
    expect(
      capabilityRelevanceScore(
        "Product designer creating visual image assets",
        "imagegen creates and edits bitmap visuals",
      ),
    ).toBeGreaterThan(
      capabilityRelevanceScore(
        "Product designer creating visual image assets",
        "GitHub pull request review",
      ),
    );
  });

  it("migrates obsolete creative ids only when live imagegen exists", () => {
    const inventory = sanitizeCapabilityInventory({
      skills: [
        {
          name: "imagegen",
          description: "Images",
          scope: "system",
          enabled: true,
        },
      ],
      tools: [],
      skillErrors: [],
      collaborationModes: [],
      permissionProfiles: [],
      apps: [],
      hooks: [],
      provider: {
        namespaceTools: true,
        imageGeneration: true,
        webSearch: true,
      },
      enabledRuntimeFeatures: [],
    });
    expect(
      reconcileCapabilitySelections(
        "creative",
        ["hero", "logo"],
        "hero",
        ["missing::tool"],
        inventory,
      ),
    ).toEqual({
      skills: ["imagegen"],
      activeSkill: "imagegen",
      connectorTools: [],
    });
  });
});
