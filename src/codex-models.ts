/**
 * Codex CLI model helpers — catalog is loaded live via app-server `model/list`.
 * No permanent hardcoded product model list (Sol/Terra/Luna/etc.).
 * No mock / deterministic entries in the picker.
 */

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

/** Default from a live list: isDefault entry, else first, else empty string. */
export function defaultModelFromList(models: CodexModelOption[]): string {
  const hit = models.find((m) => m.isDefault) ?? models[0];
  if (!hit) return "";
  return hit.id || hit.model || "";
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

/** True when stored model is empty or stripped mock/demo — needs live default. */
export function needsLiveModelDefault(raw: string | undefined | null): boolean {
  return !normalizeStoredModelId(raw ?? "");
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

export function subscribeLiveCodexModels(onStoreChange: () => void): () => void {
  liveCodexModelsListeners.add(onStoreChange);
  return () => {
    liveCodexModelsListeners.delete(onStoreChange);
  };
}
