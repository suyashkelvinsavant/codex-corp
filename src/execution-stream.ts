export type ExecutionStreamKind =
  | "reasoning-summary"
  | "plan"
  | "console"
  | "diff"
  | "file-change"
  | "warning"
  | "lifecycle";

export type ExecutionStreamSurface = "workflow-node" | "workflow-chat";

export type ExecutionStreamEvent = {
  streamKey: string;
  nodeId: string;
  nodeLabel?: string;
  surface: ExecutionStreamSurface;
  kind: ExecutionStreamKind;
  text: string;
  at: number;
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  messageId?: string;
  complete?: boolean;
};

export const MAX_STREAM_LINES = 16;
const MAX_LINE_CHARS = 4_000;

export type ExecutionStreamLine = {
  kind: ExecutionStreamKind;
  text: string;
  at: number;
};

export type ExecutionStreamBuffer = {
  streamKey: string;
  nodeId: string;
  surface: ExecutionStreamSurface;
  lines: ExecutionStreamLine[];
  complete: boolean;
};

export function createStreamBuffer(
  streamKey: string,
  nodeId = "",
  surface: ExecutionStreamSurface = "workflow-node",
): ExecutionStreamBuffer {
  return { streamKey, nodeId, surface, lines: [], complete: false };
}

/**
 * Append a stream event to a bounded buffer.
 *
 * Line coalescing invariant: a delta updates the current visible line; it
 * never creates a new log row by itself. A new row is created only when:
 *  - the model emits an actual newline;
 *  - the semantic stream kind changes (e.g. reasoning → console);
 *  - the current stream completes;
 *  - the previous line already ended with a newline.
 */
export function appendStreamEvent(
  buffer: ExecutionStreamBuffer,
  event: ExecutionStreamEvent,
): ExecutionStreamBuffer {
  if (event.streamKey !== buffer.streamKey) return buffer;
  const lines = [...buffer.lines];
  const text = event.text;
  const complete = event.complete ?? buffer.complete;
  if (text === "") {
    return boundLines({ ...buffer, lines, complete });
  }
  const last = lines[lines.length - 1];
  const startsNewLine =
    !last ||
    last.kind !== event.kind ||
    text.startsWith("\n") ||
    last.text.endsWith("\n");
  if (startsNewLine) {
    const cleaned = text.replace(/^\n+/, "");
    if (cleaned === "") {
      return boundLines({ ...buffer, lines, complete });
    }
    pushMultiLine(lines, event.kind, cleaned, event.at);
  } else {
    const combined = (last.text + text).slice(0, MAX_LINE_CHARS);
    lines[lines.length - 1] = { ...last, text: combined };
  }
  return boundLines({ ...buffer, lines, complete });
}

function pushMultiLine(
  lines: ExecutionStreamLine[],
  kind: ExecutionStreamKind,
  text: string,
  at: number,
): void {
  const segments = text.split("\n");
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    const value = isLast ? segment : `${segment}\n`;
    if (value === "\n" && lines.length > 0) {
      const prev = lines[lines.length - 1];
      if (!prev.text.endsWith("\n")) {
        lines[lines.length - 1] = { ...prev, text: `${prev.text}\n` };
      }
      continue;
    }
    if (value === "" || value === "\n") continue;
    lines.push({ kind, text: value.slice(0, MAX_LINE_CHARS), at });
  }
}

function boundLines(buffer: ExecutionStreamBuffer): ExecutionStreamBuffer {
  if (buffer.lines.length <= MAX_STREAM_LINES) return buffer;
  return { ...buffer, lines: buffer.lines.slice(-MAX_STREAM_LINES) };
}

export function streamLines(buffer: ExecutionStreamBuffer): string[] {
  return buffer.lines.map((line) => line.text.replace(/\n$/, ""));
}
