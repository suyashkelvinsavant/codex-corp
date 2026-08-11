import type { ExecutionStreamBuffer, ExecutionStreamKind } from "./execution-stream";
import { streamLines } from "./execution-stream";

const KIND_LABELS: Record<ExecutionStreamKind, string> = {
  "reasoning-summary": "Reasoning summary",
  plan: "Plan",
  console: "Console",
  diff: "Diff",
  "file-change": "File changes",
  warning: "Warning",
  lifecycle: "Lifecycle",
};

export type ExecutionStreamDisclosureProps = {
  buffer: ExecutionStreamBuffer | undefined;
  expanded: boolean;
  onToggle: () => void;
  label?: string;
};

export function ExecutionStreamDisclosure({
  buffer,
  expanded,
  onToggle,
  label,
}: ExecutionStreamDisclosureProps) {
  if (!buffer || buffer.lines.length === 0) return null;
  const lines = streamLines(buffer);
  const lastKind = buffer.lines[buffer.lines.length - 1].kind;
  const kindLabel = KIND_LABELS[lastKind] ?? "Stream";
  const header = label ?? `${kindLabel} (${buffer.lines.length})`;
  return (
    <div className={`execution-stream-disclosure${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="execution-stream-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> {header}
      </button>
      {expanded && (
        <div className="execution-stream-viewport" role="log">
          {lines.map((line, index) => (
            <div key={index} className="execution-stream-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
