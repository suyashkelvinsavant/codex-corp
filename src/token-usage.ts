/**
 * Live Codex token usage helpers — pure, unit-testable.
 * Sources: thread/tokenUsage notifications, run events, node snapshots.
 */

import type { FlowNode, RunEvent, RunRecord } from "./model";

/** Extract tokens attributable to the latest turn from app-server payloads. */
export function extractTotalTokensFromPayload(payload: unknown): number {
  if (payload == null) return 0;
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return Math.max(0, Math.floor(payload));
  }
  if (typeof payload === "string" && payload.trim()) {
    const asNum = Number(payload);
    if (Number.isFinite(asNum)) return Math.max(0, Math.floor(asNum));
    try {
      return extractTotalTokensFromPayload(JSON.parse(payload));
    } catch {
      return 0;
    }
  }
  if (typeof payload !== "object") return 0;
  const obj = payload as Record<string, unknown>;

  const direct =
    num(obj.tokens) || num(obj.totalTokens) || num(obj.total_tokens);
  if (direct > 0) return direct;

  const tokenUsage = obj.tokenUsage ?? obj.token_usage;
  if (tokenUsage && typeof tokenUsage === "object") {
    const usage = tokenUsage as Record<string, unknown>;
    // `total` is cumulative for the whole thread. Runs can resume a specialist
    // thread, so prefer `last` to avoid charging previous turns again.
    const last = usage.last;
    if (last && typeof last === "object") {
      const breakdown = last as Record<string, unknown>;
      const fromLast =
        num(breakdown.totalTokens) ||
        num(breakdown.total_tokens) ||
        num(breakdown.inputTokens) + num(breakdown.outputTokens);
      if (fromLast > 0) return fromLast;
    }
    const total = usage.total;
    if (total && typeof total === "object") {
      const breakdown = total as Record<string, unknown>;
      const fromTotal =
        num(breakdown.totalTokens) ||
        num(breakdown.total_tokens) ||
        num(breakdown.inputTokens) + num(breakdown.outputTokens);
      if (fromTotal > 0) return fromTotal;
    }
  }

  // Nested under params (raw app-server notification shape)
  if (obj.params) return extractTotalTokensFromPayload(obj.params);
  if (obj.diagnostics) return extractTotalTokensFromPayload(obj.diagnostics);
  return 0;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  // bigint from generated types sometimes serialized oddly
  if (typeof value === "bigint") return Number(value < 0n ? 0n : value);
  return 0;
}

export function isTokenUsageEventType(eventType: string | undefined): boolean {
  if (!eventType) return false;
  const t = eventType.toLowerCase();
  return (
    t.includes("tokenusage") ||
    t.includes("token_usage") ||
    t === "agent.token_usage" ||
    t.endsWith("tokenusage/updated")
  );
}

/** Monotonic max: never decrease a node's observed token total. */
export function applyTokenUsageToNode(
  node: FlowNode,
  tokens: number,
): FlowNode {
  const next = Math.max(0, Math.floor(tokens));
  if (next <= 0) return node;
  const current = Number(node.data.tokens) || 0;
  if (next <= current) return node;
  return {
    ...node,
    data: {
      ...node.data,
      tokens: next,
      trace: [
        ...node.data.trace,
        `Token usage · ${next.toLocaleString()} tok`,
      ].slice(-80),
    },
  };
}

export function tokensFromNodeSnapshot(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const data = (node as { data?: Record<string, unknown> }).data;
  if (!data || typeof data !== "object") return 0;
  const direct = num(data.tokens);
  if (direct > 0) return direct;
  // RuntimeOutput embedded during list_runs hydration
  const structured = data.structuredOutput;
  if (structured && typeof structured === "object") {
    const nested = num((structured as Record<string, unknown>).tokens);
    if (nested > 0) return nested;
  }
  return extractTotalTokensFromPayload(data);
}

/** Sum tokens from nodesJson, then fall back to run events if present. */
export function tokensFromRunRecord(record: RunRecord): number {
  let fromNodes = 0;
  if (record.nodesJson) {
    try {
      const nodes = JSON.parse(record.nodesJson) as unknown;
      if (Array.isArray(nodes)) {
        fromNodes = nodes.reduce(
          (sum, node) => sum + tokensFromNodeSnapshot(node),
          0,
        );
      }
    } catch {
      /* ignore */
    }
  }
  if (fromNodes > 0) return fromNodes;

  let fromEvents = 0;
  if (record.eventsJson) {
    try {
      const events = JSON.parse(record.eventsJson) as unknown;
      if (Array.isArray(events)) {
        const byNode = new Map<string, number>();
        for (const raw of events) {
          if (!raw || typeof raw !== "object") continue;
          const ev = raw as Record<string, unknown>;
          const type = String(ev.type ?? ev.eventType ?? "");
          const tokens =
            extractTotalTokensFromPayload(ev) ||
            extractTotalTokensFromPayload(ev.diagnostics) ||
            (isTokenUsageEventType(type)
              ? extractTotalTokensFromPayload(ev.message)
              : 0);
          if (tokens <= 0) continue;
          const nodeId = String(ev.nodeId ?? ev.node_id ?? "_run");
          byNode.set(nodeId, Math.max(byNode.get(nodeId) ?? 0, tokens));
        }
        fromEvents = [...byNode.values()].reduce((a, b) => a + b, 0);
      }
    } catch {
      /* ignore */
    }
  }
  return fromEvents;
}

export function sumNodeTokens(nodes: FlowNode[]): number {
  return nodes.reduce((sum, node) => sum + (Number(node.data.tokens) || 0), 0);
}

export function tokenEventsFromRunEvents(events: RunEvent[]): number {
  const byNode = new Map<string, number>();
  for (const event of events) {
    if (!isTokenUsageEventType(event.type) && !event.message.includes("tok")) {
      const t = extractTotalTokensFromPayload(event);
      if (t <= 0) continue;
      const key = event.nodeId ?? "_run";
      byNode.set(key, Math.max(byNode.get(key) ?? 0, t));
      continue;
    }
    const tokens =
      extractTotalTokensFromPayload(event.message) ||
      extractTotalTokensFromPayload(event);
    if (tokens <= 0) continue;
    const key = event.nodeId ?? "_run";
    byNode.set(key, Math.max(byNode.get(key) ?? 0, tokens));
  }
  return [...byNode.values()].reduce((a, b) => a + b, 0);
}
