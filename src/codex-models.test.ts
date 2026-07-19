import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_EFFORT,
  DEFAULT_NODE_MODEL_ID,
  defaultNodeEffortForModel,
  defaultModelFromList,
  defaultNodeModelFromList,
  displayNameForModel,
  effortsForModel,
  needsLiveModelDefault,
  normalizeStoredModelId,
  sanitizeModelList,
  type CodexModelOption,
} from "./codex-models";

const fixtureModels: CodexModelOption[] = [
  {
    id: "model-a",
    model: "model-a",
    displayName: "Model A",
    description: "",
    isDefault: false,
    hidden: false,
    supportedEfforts: ["low", "medium"],
    defaultEffort: "low",
  },
  {
    id: "model-b",
    model: "model-b",
    displayName: "Model B",
    description: "Default pick",
    isDefault: true,
    hidden: false,
    supportedEfforts: ["high"],
    defaultEffort: "high",
  },
];

describe("codex models helpers (connector-driven, no hardcoded catalog)", () => {
  it("defaultModelFromList prefers isDefault, then first, then empty", () => {
    expect(defaultModelFromList(fixtureModels)).toBe("model-b");
    expect(defaultModelFromList([fixtureModels[0]!])).toBe("model-a");
    expect(defaultModelFromList([])).toBe("");
  });

  it("prefers GPT-5.6 Luna from the live catalog with medium effort", () => {
    const luna = {
      ...fixtureModels[0]!,
      id: DEFAULT_NODE_MODEL_ID,
      model: DEFAULT_NODE_MODEL_ID,
      displayName: "GPT-5.6 Luna",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "low",
    };
    const models = [...fixtureModels, luna];
    expect(defaultModelFromList(models)).toBe("model-b");
    expect(defaultNodeModelFromList(models)).toBe(DEFAULT_NODE_MODEL_ID);
    expect(defaultNodeEffortForModel(models, luna.id)).toBe(
      DEFAULT_NODE_EFFORT,
    );
  });

  it("falls back safely when Luna or medium is unavailable", () => {
    expect(defaultModelFromList(fixtureModels)).toBe("model-b");
    expect(defaultNodeModelFromList(fixtureModels)).toBe("model-b");
    expect(defaultNodeModelFromList([])).toBe("");
    expect(defaultNodeEffortForModel(fixtureModels, "model-b")).toBe("high");
  });

  it("effortsForModel uses list entry or generic effort fallback", () => {
    expect(effortsForModel(fixtureModels, "model-b")).toEqual(["high"]);
    expect(effortsForModel(fixtureModels, "unknown")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("displayNameForModel resolves from fixture list", () => {
    expect(displayNameForModel(fixtureModels, "model-a")).toBe("Model A");
    expect(displayNameForModel(fixtureModels, "missing-id")).toBe("missing-id");
  });

  it("normalizeStoredModelId strips mock/deterministic/demo to empty", () => {
    expect(normalizeStoredModelId("Mock / deterministic")).toBe("");
    expect(normalizeStoredModelId("deterministic")).toBe("");
    expect(normalizeStoredModelId("demo")).toBe("");
    expect(normalizeStoredModelId("  ")).toBe("");
  });

  it("normalizeStoredModelId applies generic space/case normalization", () => {
    expect(normalizeStoredModelId("GPT-5.6 Luna")).toBe("gpt-5.6-luna");
    expect(normalizeStoredModelId("GPT-5.6-Sol")).toBe("gpt-5.6-sol");
    expect(normalizeStoredModelId("  Some Model  ")).toBe("some-model");
  });

  it("sanitizeModelList drops mock/demo rows", () => {
    const mixed: CodexModelOption[] = [
      ...fixtureModels,
      {
        id: "mock",
        model: "mock",
        displayName: "Mock / deterministic",
        description: "",
        isDefault: false,
        hidden: false,
        supportedEfforts: [],
        defaultEffort: null,
      },
    ];
    const cleaned = sanitizeModelList(mixed);
    expect(cleaned.map((m) => m.id)).toEqual(["model-a", "model-b"]);
  });

  it("needsLiveModelDefault is true for empty/mock and false for real ids", () => {
    expect(needsLiveModelDefault("")).toBe(true);
    expect(needsLiveModelDefault("   ")).toBe(true);
    expect(needsLiveModelDefault("Mock / deterministic")).toBe(true);
    expect(needsLiveModelDefault(undefined)).toBe(true);
    expect(needsLiveModelDefault("model-b")).toBe(false);
    expect(needsLiveModelDefault("model-b", fixtureModels)).toBe(false);
    expect(needsLiveModelDefault("gpt-5.6-luna", fixtureModels)).toBe(true);
  });
});
