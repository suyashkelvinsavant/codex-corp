import { invoke } from "@tauri-apps/api/core";
import { native } from "./native-adapter";

export type NodeExperienceRecord = {
  failureClass: string | null;
  stopReason: string | null;
  outcome: string;
  attemptCount: number;
  totalTokens: number;
  latencyMs: number;
  observedAt: string;
};

export type NodeExperienceQuery = {
  workflowId: string;
  nodeId: string;
  role: string;
  model: string;
  effort: string;
};

/**
 * Load durable run experience for a node pattern (role/model/effort).
 * Returns an empty array outside the Tauri desktop shell (e.g. unit tests).
 */
export async function listNodeExperience(
  query: NodeExperienceQuery,
): Promise<NodeExperienceRecord[]> {
  if (!native.isNative) return [];
  const rows = (await invoke<unknown[]>("list_node_experience", query)) ?? [];
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      failureClass: typeof r.failureClass === "string" ? r.failureClass : null,
      stopReason: typeof r.stopReason === "string" ? r.stopReason : null,
      outcome: String(r.outcome ?? ""),
      attemptCount: Number(r.attemptCount ?? 0),
      totalTokens: Number(r.totalTokens ?? 0),
      latencyMs: Number(r.latencyMs ?? 0),
      observedAt: String(r.observedAt ?? ""),
    };
  });
}

export function formatExperienceDigest(records: NodeExperienceRecord[]): string {
  if (!records.length) return "No prior run experience for this node pattern.";
  const successes = records.filter((r) => r.outcome === "success").length;
  const failures = records.length - successes;
  const dominantFailure = records
    .map((r) => r.failureClass)
    .filter(Boolean)
    .reduce<Record<string, number>>((counts, cls) => {
      counts[cls as string] = (counts[cls as string] ?? 0) + 1;
      return counts;
    }, {});
  const topFailure = Object.entries(dominantFailure).sort((a, b) => b[1] - a[1])[0];
  const lines = [
    `Prior runs: ${records.length} (${successes} success, ${failures} non-success).`,
    topFailure
      ? `Most recurring failure class: ${topFailure[0]} (${topFailure[1]} occurrences).`
      : undefined,
    `Latest: ${records[0].outcome} at ${records[0].observedAt} (${records[0].totalTokens} tokens, ${records[0].latencyMs}ms).`,
  ].filter(Boolean);
  return lines.join("\n");
}
