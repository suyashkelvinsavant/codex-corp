/**
 * Codex CLI model helpers — catalog is loaded live via app-server `model/list`.
 * No permanent hardcoded product model list (Sol/Terra/Luna/etc.).
 * No mock / deterministic entries in the picker.
 */

export const DEFAULT_NODE_MODEL_ID = "gpt-5.6-luna";
export const DEFAULT_NODE_EFFORT = "medium";

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  supportedEfforts: string[];
  defaultEffort: string | null;
};

/** Default from a live list: connector default, then first, then empty string. */
export function defaultModelFromList(models: CodexModelOption[]): string {
  const hit = models.find((m) => m.isDefault) ?? models[0];
  if (!hit) return "";
  return hit.id || hit.model || "";
}

/** Specialist-node preference, falling back to the connector's live default. */
export function defaultNodeModelFromList(models: CodexModelOption[]): string {
  const hit = models.find(
    (m) =>
      normalizeStoredModelId(m.id) === DEFAULT_NODE_MODEL_ID ||
      normalizeStoredModelId(m.model) === DEFAULT_NODE_MODEL_ID ||
      normalizeStoredModelId(m.displayName) === DEFAULT_NODE_MODEL_ID,
  );
  if (!hit) return defaultModelFromList(models);
  return hit.id || hit.model || "";
}

/** Preferred effort when supported, then the model's live default, then first. */
export function defaultNodeEffortForModel(
  models: CodexModelOption[],
  modelId: string,
): string {
  const options = effortsForModel(models, modelId);
  if (options.includes(DEFAULT_NODE_EFFORT)) return DEFAULT_NODE_EFFORT;
  const hit = models.find((m) => m.id === modelId || m.model === modelId);
  if (hit?.defaultEffort && options.includes(hit.defaultEffort)) {
    return hit.defaultEffort;
  }
  return options[0] ?? DEFAULT_NODE_EFFORT;
}

export function displayNameForModel(
  models: CodexModelOption[],
  modelId: string,
): string {
  const hit = models.find(
    (m) =>
      m.id === modelId ||
      m.model === modelId ||
      m.displayName === modelId ||
      m.displayName.replace(/-/g, " ").toLowerCase() ===
        modelId.replace(/-/g, " ").toLowerCase(),
  );
  return hit?.displayName ?? modelId;
}

export function effortsForModel(
  models: CodexModelOption[],
  modelId: string,
): string[] {
  const hit = models.find((m) => m.id === modelId || m.model === modelId);
  const efforts = hit?.supportedEfforts?.filter(Boolean) ?? [];
  if (efforts.length) return efforts;
  return ["low", "medium", "high"];
}

/**
 * Normalize legacy UI labels / stored model strings.
 * Strips mock/deterministic/demo to empty (no fake product default).
 * Generic: trim, lowercase, collapse whitespace to hyphens — no Sol/Terra/Luna maps.
 */
export function normalizeStoredModelId(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const normalized = t.toLowerCase().replace(/\s+/g, "-");
  if (
    normalized.includes("mock") ||
    normalized.includes("deterministic") ||
    normalized === "demo"
  ) {
    return "";
  }
  return normalized;
}

/** Drop mock/demo rows; keep real catalog entries from the connector. */
export function sanitizeModelList(
  models: CodexModelOption[] | null | undefined,
): CodexModelOption[] {
  const cleaned = (models ?? []).filter(
    (m) =>
      m?.id &&
      !/mock|deterministic|^demo$/i.test(m.id) &&
      !/mock|deterministic/i.test(m.displayName ?? ""),
  );
  return cleaned;
}

/** True when a stored model is empty, fake, or absent from a supplied live list. */
export function needsLiveModelDefault(
  raw: string | undefined | null,
  models?: CodexModelOption[],
): boolean {
  const normalized = normalizeStoredModelId(raw ?? "");
  if (!normalized) return true;
  if (!models) return false;
  return !models.some(
    (model) =>
      normalizeStoredModelId(model.id) === normalized ||
      normalizeStoredModelId(model.model) === normalized ||
      normalizeStoredModelId(model.displayName) === normalized,
  );
}

/**
 * Shared live model/list snapshot for canvas labels (CorpNode) without prop-drilling.
 * Updated whenever the app receives a connector catalog.
 */
let liveCodexModels: CodexModelOption[] = [];
const liveCodexModelsListeners = new Set<() => void>();

export function publishLiveCodexModels(models: CodexModelOption[]): void {
  liveCodexModels = models;
  for (const listener of liveCodexModelsListeners) listener();
}

export function getLiveCodexModels(): CodexModelOption[] {
  return liveCodexModels;
}

export function subscribeLiveCodexModels(
  onStoreChange: () => void,
): () => void {
  liveCodexModelsListeners.add(onStoreChange);
  return () => {
    liveCodexModelsListeners.delete(onStoreChange);
  };
}
