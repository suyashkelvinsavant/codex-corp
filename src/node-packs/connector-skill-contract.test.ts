import { describe, expect, it } from "vitest";
import { reconcileCapabilitySelections } from "../codex-capabilities";
import { ensureSpecialistQuality } from "../specialist-defaults";
import { instantiatePackById, instantiatePackForRole } from "./instantiate";
import { listPacksForCatalog } from "./packs";

describe("builtin pack connector-skill contract", () => {
  it("does not turn Product Manager role guidance into a saved-skill request", () => {
    expect(instantiatePackById("product-manager")?.skills).toEqual([]);
  });

  it("does not seed any catalog pack with unavailable connector skills", () => {
    for (const pack of listPacksForCatalog()) {
      expect(instantiatePackById(pack.id)?.skills, pack.id).toEqual([]);
    }
  });

  it("keeps newly created role nodes free of connector-skill selections", () => {
    expect(instantiatePackForRole("Frontend Engineer").skills).toEqual([]);
    expect(instantiatePackForRole("Creative", "creative").skills).toEqual([]);
  });

  it("preserves an explicit operator connector-skill selection", () => {
    const ensured = ensureSpecialistQuality({
      kind: "agent",
      role: "Product Manager",
      prompt:
        "An operator-authored contract that is deliberately long enough to remain authoritative.\n\nMission\n- Define the product boundary and acceptance criteria for the current request.",
      skills: ["installed-skill"],
    });
    expect(ensured.skills).toEqual(["installed-skill"]);
  });

  it("does not overwrite an explicit selection that shares a role hint name", () => {
    const ensured = ensureSpecialistQuality({
      kind: "agent",
      role: "Product Manager",
      prompt: "todo",
      skills: ["product-spec", "installed-skill"],
    });
    expect(ensured.skills).toEqual(["product-spec", "installed-skill"]);
  });

  it("still filters stale persisted connector selections against live capability inventory", () => {
    expect(
      reconcileCapabilitySelections(
        "agent",
        ["product-spec", "installed-skill"],
        "product-spec",
        [],
        {
          skills: [
            {
              name: "installed-skill",
              description: "Installed",
              scope: "workspace",
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
            namespaceTools: false,
            imageGeneration: false,
            webSearch: false,
          },
          enabledRuntimeFeatures: [],
          realtimeConversationAvailable: false,
          account: null,
          authMode: null,
          requiresOpenaiAuth: false,
        },
      ),
    ).toEqual({
      skills: ["installed-skill"],
      activeSkill: "installed-skill",
      connectorTools: [],
    });
  });
});
