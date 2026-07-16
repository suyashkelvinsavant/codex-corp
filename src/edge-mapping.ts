/**
 * Graph-driven edge field mapping.
 *
 * Shape (EdgeData.mapping): Record<fieldName, jsonPath>
 *   - fieldName: non-empty destination key on the projected payload
 *   - jsonPath: must start with "$." (validated by validateWorkflow)
 *
 * Examples:
 *   { summary: "$.summary", modules: "$.data.modules" }
 *   { firstArtifact: "$.artifacts[0].name" }
 *
 * Semantics:
 *   - Missing / empty mapping → return the full upstream payload (unchanged).
 *   - Present mapping → return only listed fields; missing paths resolve to null.
 *   - Paths support dot segments and simple zero-based [index] accessors.
 *   - No filter expressions, wildcards, or recursive descent.
 */

export type EdgeFieldMapping = Record<string, string>;

const PATH_SEGMENT = /^([^\[\].]+)(?:\[(\d+)\])?$/;

/** Whether a mapping object should project (vs pass-through). */
export function isActiveMapping(
  mapping: EdgeFieldMapping | null | undefined,
): boolean {
  if (!mapping) return false;
  return Object.keys(mapping).some(
    (key) => key.trim().length > 0 && typeof mapping[key] === "string",
  );
}

/**
 * Resolve a simple JSONPath-style selector starting with `$.`.
 * Returns `undefined` when the path is invalid or does not exist.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  if (typeof path !== "string" || !path.startsWith("$.")) return undefined;
  const body = path.slice(2);
  if (!body) return root;

  let current: unknown = root;
  for (const raw of body.split(".")) {
    if (current == null) return undefined;
    const match = raw.match(PATH_SEGMENT);
    if (!match) return undefined;
    const [, key, indexText] = match;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
    if (indexText != null) {
      const index = Number(indexText);
      if (!Array.isArray(current) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
    }
  }
  return current;
}

/**
 * Project an upstream agent/control result through an edge mapping.
 * Unmapped edges return `payload` by reference (full-payload behavior).
 */
export function applyEdgeMapping(
  payload: unknown,
  mapping: EdgeFieldMapping | null | undefined,
): unknown {
  if (!isActiveMapping(mapping)) return payload;

  const projected: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(mapping!)) {
    if (!field.trim() || typeof path !== "string") continue;
    const value = resolveJsonPath(payload, path);
    projected[field] = value === undefined ? null : value;
  }
  return projected;
}

/**
 * Build the upstream context list for a target node from inbound edges.
 * Each entry is either the full source output or a projected object.
 */
export function mapInboundUpstream<T>(
  inbound: Array<{ mapping?: EdgeFieldMapping | null }>,
  resolveSource: (index: number) => T | undefined | null,
): unknown[] {
  const result: unknown[] = [];
  inbound.forEach((edge, index) => {
    const source = resolveSource(index);
    if (source == null) return;
    result.push(applyEdgeMapping(source, edge.mapping));
  });
  return result;
}

/**
 * Normalize a projected (or full) payload into the handoff shape used by the
 * delivery collector: summary string, data object, artifacts array.
 */
export function projectedToHandoffFields(projected: unknown): {
  summary: string;
  data: Record<string, unknown>;
  artifacts: unknown[];
} {
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
    return { summary: "", data: {}, artifacts: [] };
  }
  const record = projected as Record<string, unknown>;
  const dataValue = record.data;
  let data: Record<string, unknown>;
  if (dataValue && typeof dataValue === "object" && !Array.isArray(dataValue)) {
    data = dataValue as Record<string, unknown>;
  } else {
    const {
      summary: _summary,
      artifacts: _artifacts,
      status: _status,
      threadId: _threadId,
      ...rest
    } = record;
    data = rest;
  }
  return {
    summary: String(record.summary ?? ""),
    data,
    artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
  };
}
