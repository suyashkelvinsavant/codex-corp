const MAX_STREAM_PREVIEW_CHARS = 900;

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

export function isAgentMessageDelta(eventType: string): boolean {
  return eventType === "item/agentMessage/delta";
}
