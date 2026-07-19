import { describe, expect, it } from "vitest";
import {
  capabilityRelevanceScore,
  isRealtimeUnavailableError,
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
      realtimeConversationAvailable: true,
      account: null,
      authMode: null,
      requiresOpenaiAuth: false,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(["imagegen"]);
    expect(result.tools.map((tool) => tool.id)).toEqual([
      "apps::figma.generate",
    ]);
    expect(result.realtimeConversationAvailable).toBe(true);
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
      realtimeConversationAvailable: false,
      account: null,
      authMode: null,
      requiresOpenaiAuth: false,
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

  it.each([
    [
      'Codex app-server error: {"code":-32600,"message":"thread t does not support realtime conversation"}',
      true,
    ],
    ["JSON-RPC -32601: method not found", true],
    ["Realtime conversation requires API key auth", true],
    ["Microphone permission denied", false],
    ["Realtime websocket closed unexpectedly", false],
  ])("classifies permanent realtime availability failures", (message, expected) => {
    expect(isRealtimeUnavailableError(message)).toBe(expected);
  });

  it("fails closed when capability discovery omits realtime support", () => {
    const result = sanitizeCapabilityInventory(undefined);
    expect(result.realtimeConversationAvailable).toBe(false);
  });
});
