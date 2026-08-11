import type { TraceRecord } from "./model";
import type { ExecutionStreamKind } from "./execution-stream";

const MAX_STREAM_PREVIEW_CHARS = 900;

export function appendTypedTrace(
  current: Array<string | TraceRecord>,
  entry: TraceRecord,
  maxEntries = 80,
  maxTextChars = 64_000,
): Array<string | TraceRecord> {
  const boundedEntry = { ...entry, text: entry.text.slice(-8_000) };
  const next = [...current, boundedEntry].slice(-maxEntries);
  let size = next.reduce(
    (total, item) => total + (typeof item === "string" ? item.length : item.text.length),
    0,
  );
  while (next.length > 1 && size > maxTextChars) {
    const removed = next.shift();
    size -= typeof removed === "string" ? removed.length : (removed?.text.length ?? 0);
  }
  return next;
}

/**
 * App-server message deltas are already correctly spaced fragments. Keep their
 * exact order, but bound the retained preview so long turns cannot inflate the
 * graph state or force increasingly expensive renders.
 */
export function appendStreamPreview(
  current: string | undefined,
  delta: string,
  maxChars = MAX_STREAM_PREVIEW_CHARS,
): string {
  if (!delta) return current ?? "";
  const next = `${current ?? ""}${delta}`;
  return next.length > maxChars ? next.slice(-maxChars) : next;
}

const AGENT_MESSAGE_DELTA_TYPES = new Set([
  "item/agentMessage/delta",
  "agent.message.delta",
]);

export function isAgentMessageDelta(eventType: string): boolean {
  return AGENT_MESSAGE_DELTA_TYPES.has(eventType);
}

export function normalizeStreamEventType(rawType: string): string {
  if (rawType === "agent.message.delta") return "item/agentMessage/delta";
  return rawType;
}

export function classifyStreamKind(eventType: string): ExecutionStreamKind | null {
  switch (eventType) {
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return "reasoning-summary";
    case "item/plan/delta":
    case "turn/plan/updated":
      return "plan";
    case "item/commandExecution/outputDelta":
    case "process/outputDelta":
      return "console";
    case "turn/diff/updated":
      return "diff";
    case "item/fileChange/patchUpdated":
      return "file-change";
    case "warning":
    case "guardianWarning":
    case "configWarning":
    case "deprecationNotice":
      return "warning";
    default:
      return null;
  }
}

const STREAMING_EVENT_TYPES = new Set([
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
  "turn/plan/updated",
  "item/commandExecution/outputDelta",
  "process/outputDelta",
  "turn/diff/updated",
  "item/fileChange/patchUpdated",
  "warning",
  "guardianWarning",
  "configWarning",
  "deprecationNotice",
]);

export function isStreamingTraceEvent(eventType: string): boolean {
  return STREAMING_EVENT_TYPES.has(eventType);
}

export function traceEventLabel(eventType: string): string {
  switch (eventType) {
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return "Reasoning";
    case "item/plan/delta":
    case "turn/plan/updated":
      return "Plan";
    case "item/commandExecution/outputDelta":
    case "process/outputDelta":
      return "Console";
    case "turn/diff/updated":
      return "Diff";
    case "item/fileChange/patchUpdated":
      return "File changes";
    case "warning":
    case "guardianWarning":
    case "configWarning":
    case "deprecationNotice":
      return "Warning";
    default:
      return eventType;
  }
}
