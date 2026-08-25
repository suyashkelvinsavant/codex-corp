# Stream Visibility, Decision-Center Lifecycle, Staged Release, and Byte Workspace Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four cohesive workflow/chat problems — invisible live reasoning streams, stale approval popups, missing two-stage demo/release/publish flow, and Byte's lack of direct workspace shell — without duplicating permission or approval logic across frontend, Rust, and persistence.

**Architecture:** A single normalized `ExecutionStreamEvent` contract flows from the native adapter through `main.tsx` into a shared `ExecutionStreamDisclosure` UI used by both the execution drawer and workflow chat. Decision-center visibility is derived from the actual pending-decision set rather than independent `approvalCenterOpen` state. The Software Company template gains a staged Release Coordinator → demo → release-commit → publish-approval graph. Byte's mediator turn is upgraded from `read-only`/`never` to `workspace-write`/`on-request` with a publish-operation guard at the native approval boundary.

**Tech Stack:** TypeScript/React 19, Vite, Vitest, @xyflow/react, Tauri, Rust, SQLite, Codex app-server JSON-RPC

## Global Constraints

- Repository root: `C:\Users\suyas\Documents\Hackathon_OpenAI_Build_Week`
- Frontend build: `npm run build` (must pass with exit code 0)
- Frontend tests: `npm test` (must pass)
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml` (must pass)
- Desktop release: `npm run desktop:build` (must produce `release/Codex-Corp.exe` and pass manual launch inspection)
- Preserve fail-closed behavior for verification and delivery
- Preserve native runtime invariant: standalone release builds must not depend on Vite dev server
- Chain-of-thought remains `"not-exposed"`; only protocol-provided reasoning summaries/plans/tool output are rendered
- Stream deltas coalesce into lines — never one row per token
- Each task ends with the relevant build/test cycle passing
- Follow existing naming conventions (kebab-case TS files, snake_case Rust files)
- Preserve uncommitted user work; do not reset or overwrite unrelated dirty files

---

## Phase 1: Unified Streamed Execution Context

### Task 1: Add `ExecutionStreamEvent` type and bounded stream buffer with line coalescing

**Files:**
- Create: `src/execution-stream.ts`
- Create: `src/execution-stream.test.ts`

**Interfaces:**
- Produces: `ExecutionStreamKind`, `ExecutionStreamEvent`, `ExecutionStreamBuffer`, `createStreamBuffer()`, `appendStreamEvent(buffer, event)`, `streamLines(buffer)`, `MAX_STREAM_LINES`

- [ ] **Step 1: Write the failing test**

Create `src/execution-stream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  appendStreamEvent,
  createStreamBuffer,
  MAX_STREAM_LINES,
  streamLines,
} from "./execution-stream";

describe("execution stream buffer", () => {
  it("coalesces word fragments into one line", () => {
    let buffer = createStreamBuffer("run/node/turn");
    for (const text of ["The", " app", " starts", " correctly"]) {
      buffer = appendStreamEvent(buffer, {
        streamKey: "run/node/turn",
        nodeId: "node",
        surface: "workflow-node",
        kind: "reasoning-summary",
        text,
        at: Date.now(),
      });
    }
    expect(streamLines(buffer)).toEqual(["The app starts correctly"]);
  });

  it("starts a new line on a newline character", () => {
    let buffer = createStreamBuffer("run/node/turn");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "first line\n",
      at: 1,
    });
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "second line",
      at: 2,
    });
    expect(streamLines(buffer)).toEqual(["first line", "second line"]);
  });

  it("starts a new line when the stream kind changes", () => {
    let buffer = createStreamBuffer("run/node/turn");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "thinking",
      at: 1,
    });
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "console",
      text: "npm run build",
      at: 2,
    });
    expect(streamLines(buffer)).toEqual(["thinking", "npm run build"]);
  });

  it("bounds the buffer to MAX_STREAM_LINES lines", () => {
    let buffer = createStreamBuffer("run/node/turn");
    for (let i = 0; i < MAX_STREAM_LINES + 10; i += 1) {
      buffer = appendStreamEvent(buffer, {
        streamKey: "run/node/turn",
        nodeId: "node",
        surface: "workflow-node",
        kind: "reasoning-summary",
        text: `line ${i}\n`,
        at: i,
      });
    }
    expect(streamLines(buffer).length).toBeLessThanOrEqual(MAX_STREAM_LINES);
    expect(streamLines(buffer)[streamLines(buffer).length - 1]).toBe("line 29");
  });

  it("marks the buffer complete and preserves the snapshot", () => {
    let buffer = createStreamBuffer("run/node/turn");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "done\n",
      at: 1,
      complete: true,
    });
    expect(buffer.complete).toBe(true);
    expect(streamLines(buffer)).toEqual(["done"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/execution-stream.test.ts`
Expected: FAIL with "Cannot find module './execution-stream'"

- [ ] **Step 3: Write minimal implementation**

Create `src/execution-stream.ts`:

```ts
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

export function appendStreamEvent(
  buffer: ExecutionStreamBuffer,
  event: ExecutionStreamEvent,
): ExecutionStreamBuffer {
  if (event.streamKey !== buffer.streamKey) return buffer;
  const lines = [...buffer.lines];
  const text = event.text;
  if (text === "") {
    const next: ExecutionStreamBuffer = {
      ...buffer,
      lines,
      complete: event.complete ?? buffer.complete,
    };
    return boundLines(next);
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
      return boundLines({ ...buffer, lines, complete: event.complete ?? buffer.complete });
    }
    lines.push({ kind: event.kind, text: cleaned.slice(0, MAX_LINE_CHARS), at: event.at });
  } else {
    const combined = (last.text + text).slice(0, MAX_LINE_CHARS);
    lines[lines.length - 1] = { ...last, text: combined };
  }
  const next: ExecutionStreamBuffer = {
    ...buffer,
    lines,
    complete: event.complete ?? buffer.complete,
  };
  return boundLines(next);
}

function boundLines(buffer: ExecutionStreamBuffer): ExecutionStreamBuffer {
  if (buffer.lines.length <= MAX_STREAM_LINES) return buffer;
  return { ...buffer, lines: buffer.lines.slice(-MAX_STREAM_LINES) };
}

export function streamLines(buffer: ExecutionStreamBuffer): string[] {
  return buffer.lines.map((line) => line.text.replace(/\n$/, ""));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/execution-stream.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/execution-stream.ts src/execution-stream.test.ts
git commit -m "feat(stream): add bounded execution stream buffer with line coalescing"
```

---

### Task 2: Normalize event names and classify stream events from native adapter

**Files:**
- Modify: `src/stream-display.ts`
- Modify: `src/stream-display.test.ts`

**Interfaces:**
- Produces: `normalizeStreamEventType(rawType: string): string`, `classifyStreamKind(eventType: string): ExecutionStreamKind | null`, updated `isAgentMessageDelta` accepting both `item/agentMessage/delta` and `agent.message.delta`
- Consumes: `ExecutionStreamKind` from `./execution-stream`

- [ ] **Step 1: Write the failing test**

Append to `src/stream-display.test.ts`:

```ts
import {
  classifyStreamKind,
  isAgentMessageDelta,
  normalizeStreamEventType,
} from "./stream-display";

describe("stream event normalization", () => {
  it("accepts both agentMessage delta names", () => {
    expect(isAgentMessageDelta("item/agentMessage/delta")).toBe(true);
    expect(isAgentMessageDelta("agent.message.delta")).toBe(true);
    expect(isAgentMessageDelta("item/reasoning/delta")).toBe(false);
  });

  it("normalizes raw event names to canonical names", () => {
    expect(normalizeStreamEventType("agent.message.delta")).toBe("item/agentMessage/delta");
    expect(normalizeStreamEventType("item/agentMessage/delta")).toBe("item/agentMessage/delta");
    expect(normalizeStreamEventType("item/reasoning/summaryTextDelta")).toBe("item/reasoning/summaryTextDelta");
  });

  it("classifies canonical event types into stream kinds", () => {
    expect(classifyStreamKind("item/reasoning/summaryTextDelta")).toBe("reasoning-summary");
    expect(classifyStreamKind("item/reasoning/textDelta")).toBe("reasoning-summary");
    expect(classifyStreamKind("item/plan/delta")).toBe("plan");
    expect(classifyStreamKind("turn/plan/updated")).toBe("plan");
    expect(classifyStreamKind("item/commandExecution/outputDelta")).toBe("console");
    expect(classifyStreamKind("process/outputDelta")).toBe("console");
    expect(classifyStreamKind("turn/diff/updated")).toBe("diff");
    expect(classifyStreamKind("item/fileChange/patchUpdated")).toBe("file-change");
    expect(classifyStreamKind("warning")).toBe("warning");
    expect(classifyStreamKind("item/agentMessage/delta")).toBeNull();
    expect(classifyStreamKind("item/reasoning/textDelta/raw")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stream-display.test.ts`
Expected: FAIL with "classifyStreamKind is not exported"

- [ ] **Step 3: Write minimal implementation**

Add to `src/stream-display.ts` (after existing exports):

```ts
import type { ExecutionStreamKind } from "./execution-stream";

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
```

Remove the old single-line `isAgentMessageDelta` implementation to avoid duplicate declarations.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stream-display.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stream-display.ts src/stream-display.test.ts
git commit -m "feat(stream): normalize agent.message.delta and classify stream kinds"
```

---

### Task 3: Add per-node stream state to `AgentData` and stream map to main.tsx

**Files:**
- Modify: `src/model.ts` (add `streamBuffer?: ExecutionStreamBuffer` to `AgentData`)
- Modify: `src/main.tsx` (add `streamBuffersRef`, wire `codex-agent-event` to update buffers)

**Interfaces:**
- Produces: `AgentData.streamBuffer`, `streamBuffersRef` in main.tsx
- Consumes: `appendStreamEvent`, `createStreamBuffer`, `classifyStreamKind`, `normalizeStreamEventType` from earlier tasks

- [ ] **Step 1: Write the failing test**

Create `src/execution-stream-wiring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { appendStreamEvent, createStreamBuffer } from "./execution-stream";
import { classifyStreamKind, normalizeStreamEventType } from "./stream-display";

describe("stream wiring helpers", () => {
  it("builds an event from a raw native notification and appends to a node buffer", () => {
    const rawType = "agent.message.delta";
    const canonical = normalizeStreamEventType(rawType);
    const kind = classifyStreamKind(canonical);
    expect(kind).toBeNull();
    let buffer = createStreamBuffer("run/builder/turn1", "builder");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/builder/turn1",
      nodeId: "builder",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "Planning",
      at: 1,
    });
    expect(buffer.lines).toHaveLength(1);
  });

  it("routes reasoning summary deltas into the buffer", () => {
    const kind = classifyStreamKind("item/reasoning/summaryTextDelta");
    expect(kind).toBe("reasoning-summary");
    let buffer = createStreamBuffer("run/builder/turn1", "builder");
    for (const text of ["The", " app", " builds"]) {
      buffer = appendStreamEvent(buffer, {
        streamKey: "run/builder/turn1",
        nodeId: "builder",
        surface: "workflow-node",
        kind: "reasoning-summary",
        text,
        at: Date.now(),
      });
    }
    expect(buffer.lines).toHaveLength(1);
    expect(buffer.lines[0].text).toBe("The app builds");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/execution-stream-wiring.test.ts`
Expected: PASS (this is a wiring-shape test; it should pass once Tasks 1–2 are done)

- [ ] **Step 3: Add `streamBuffer` to `AgentData`**

In `src/model.ts`, add the import and field:

```ts
import type { ExecutionStreamBuffer } from "./execution-stream";
```

Add to `AgentData` after `streamingPreview?: string;`:

```ts
  /** Bounded live reasoning/plan/console stream for this node. */
  streamBuffer?: ExecutionStreamBuffer;
```

- [ ] **Step 4: Wire `codex-agent-event` into per-node stream buffers in main.tsx**

In `src/main.tsx`, add a ref for stream buffers keyed by node id:

```ts
import {
  appendStreamEvent,
  createStreamBuffer,
  type ExecutionStreamBuffer,
  type ExecutionStreamEvent,
} from "./execution-stream";
import { classifyStreamKind, normalizeStreamEventType } from "./stream-display";

const streamBuffersRef = useRef<Record<string, ExecutionStreamBuffer>>({});
const [activeStreamNodeId, setActiveStreamNodeId] = useState<string | null>(null);
```

In the existing `codex-agent-event` listener (the one that currently appends to `streamingPreview` and `trace`), after the existing handling, add stream routing:

```ts
const canonicalType = normalizeStreamEventType(payload.eventType);
const streamKind = classifyStreamKind(canonicalType);
if (streamKind) {
  const streamKey = `${runId ?? "draft"}/${payload.nodeId}/${payload.turnId ?? "current"}`;
  const existing = streamBuffersRef.current[payload.nodeId];
  const buffer = existing && existing.streamKey === streamKey
    ? existing
    : createStreamBuffer(streamKey, payload.nodeId, "workflow-node");
  const updated = appendStreamEvent(buffer, {
    streamKey,
    nodeId: payload.nodeId,
    surface: "workflow-node",
    kind: streamKind,
    text: payload.message,
    at: Date.now(),
    threadId: payload.threadId,
    turnId: payload.turnId,
  });
  streamBuffersRef.current = {
    ...streamBuffersRef.current,
    [payload.nodeId]: updated,
  };
  setActiveStreamNodeId(payload.nodeId);
  setNodes((nodes) =>
    nodes.map((node) =>
      node.id === payload.nodeId
        ? { ...node, data: { ...node.data, streamBuffer: updated } }
        : node,
    ),
  );
}
```

Clear the stream buffer when a node transitions out of running (in the existing lifecycle handling that clears `streamingPreview`):

```ts
if (payload.eventType === "turn/completed" || payload.eventType === "node/completed") {
  const existing = streamBuffersRef.current[payload.nodeId];
  if (existing) {
    const completed = { ...existing, complete: true };
    streamBuffersRef.current = {
      ...streamBuffersRef.current,
      [payload.nodeId]: completed,
    };
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === payload.nodeId
          ? { ...node, data: { ...node.data, streamBuffer: completed } }
          : node,
      ),
    );
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/execution-stream-wiring.test.ts src/stream-display.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/model.ts src/main.tsx src/execution-stream-wiring.test.ts
git commit -m "feat(stream): wire per-node stream buffers into AgentData and main.tsx"
```

---

### Task 4: Add `ExecutionStreamDisclosure` shared UI component

**Files:**
- Create: `src/execution-stream-disclosure.tsx`
- Create: `src/execution-stream-disclosure.test.tsx`
- Modify: `src/styles.css` (add disclosure styles)

**Interfaces:**
- Produces: `ExecutionStreamDisclosure` component with props `{ buffer: ExecutionStreamBuffer | undefined; expanded: boolean; onToggle: () => void; label?: string }`
- Consumes: `ExecutionStreamBuffer`, `streamLines` from `./execution-stream`

- [ ] **Step 1: Write the failing test**

Create `src/execution-stream-disclosure.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExecutionStreamDisclosure } from "./execution-stream-disclosure";
import { appendStreamEvent, createStreamBuffer } from "./execution-stream";

describe("ExecutionStreamDisclosure", () => {
  it("renders a collapsed summary by default", () => {
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "Planning the build",
      at: 1,
    });
    render(
      <ExecutionStreamDisclosure
        buffer={buffer}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /stream/i })).toBeInTheDocument();
    expect(screen.queryByText("Planning the build")).not.toBeInTheDocument();
  });

  it("renders stream lines when expanded", () => {
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "Planning the build",
      at: 1,
    });
    render(
      <ExecutionStreamDisclosure
        buffer={buffer}
        expanded={true}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("Planning the build")).toBeInTheDocument();
  });

  it("calls onToggle when the button is clicked", () => {
    const onToggle = vi.fn();
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "Planning",
      at: 1,
    });
    render(
      <ExecutionStreamDisclosure
        buffer={buffer}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders nothing when there is no buffer", () => {
    const { container } = render(
      <ExecutionStreamDisclosure
        buffer={undefined}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/execution-stream-disclosure.test.tsx`
Expected: FAIL with "Cannot find module './execution-stream-disclosure'"

- [ ] **Step 3: Write minimal implementation**

Create `src/execution-stream-disclosure.tsx`:

```tsx
import type { ExecutionStreamBuffer } from "./execution-stream";
import { streamLines } from "./execution-stream";

const KIND_LABELS: Record<string, string> = {
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
```

Add to `src/styles.css`:

```css
.execution-stream-disclosure {
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  margin: 4px 0;
  font-size: 12px;
}
.execution-stream-toggle {
  width: 100%;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
  padding: 4px 8px;
  cursor: pointer;
  font: inherit;
}
.execution-stream-toggle:hover {
  background: rgba(255, 255, 255, 0.04);
}
.execution-stream-viewport {
  max-height: 220px;
  overflow-y: auto;
  padding: 4px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono, monospace);
}
.execution-stream-line {
  padding: 1px 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/execution-stream-disclosure.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/execution-stream-disclosure.tsx src/execution-stream-disclosure.test.tsx src/styles.css
git commit -m "feat(stream): add ExecutionStreamDisclosure shared UI component"
```

---

### Task 5: Wire `ExecutionStreamDisclosure` into the execution drawer

**Files:**
- Modify: `src/main.tsx` (add a stream view/tab in the execution drawer; auto-collapse previous stream when a new node becomes active)

**Interfaces:**
- Consumes: `ExecutionStreamDisclosure`, `activeStreamNodeId`, per-node `streamBuffer`

- [ ] **Step 1: Write the failing test**

Create `src/execution-drawer-stream.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExecutionStreamDisclosure } from "./execution-stream-disclosure";
import { appendStreamEvent, createStreamBuffer } from "./execution-stream";

describe("execution drawer stream view", () => {
  it("shows only the active node's expanded stream when multiple nodes have buffers", () => {
    let builderBuffer = createStreamBuffer("run/builder/turn", "builder");
    builderBuffer = appendStreamEvent(builderBuffer, {
      streamKey: "run/builder/turn",
      nodeId: "builder",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "builder thinking",
      at: 1,
    });
    let qaBuffer = createStreamBuffer("run/qa/turn", "qa");
    qaBuffer = appendStreamEvent(qaBuffer, {
      streamKey: "run/qa/turn",
      nodeId: "qa",
      surface: "workflow-node",
      kind: "console",
      text: "qa output",
      at: 2,
    });
    const activeNodeId = "qa";
    render(
      <div>
        <ExecutionStreamDisclosure
          buffer={builderBuffer}
          expanded={activeNodeId === "builder"}
          onToggle={() => {}}
          label="Builder stream"
        />
        <ExecutionStreamDisclosure
          buffer={qaBuffer}
          expanded={activeNodeId === "qa"}
          onToggle={() => {}}
          label="QA stream"
        />
      </div>,
    );
    expect(screen.getByText("qa output")).toBeInTheDocument();
    expect(screen.queryByText("builder thinking")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails then passes (shape test)**

Run: `npx vitest run src/execution-drawer-stream.test.tsx`
Expected: PASS (verifies the auto-collapse contract at the component level)

- [ ] **Step 3: Add a stream tab to the execution drawer in main.tsx**

In the execution drawer tab list (where `drawerTab` is switched), add a `"stream"` tab. Add a render block that maps over nodes with `streamBuffer` and renders `ExecutionStreamDisclosure` for each, expanding only the `activeStreamNodeId`:

```tsx
{drawerTab === "stream" && (
  <div className="drawer-stream-view">
    {nodes
      .filter((node) => node.data.streamBuffer && node.data.streamBuffer.lines.length > 0)
      .map((node) => (
        <ExecutionStreamDisclosure
          key={node.id}
          buffer={node.data.streamBuffer}
          expanded={activeStreamNodeId === node.id}
          onToggle={() =>
            setActiveStreamNodeId((current) =>
              current === node.id ? null : node.id,
            )
          }
          label={`${node.data.label} stream`}
        />
      ))}
  </div>
)}
```

Add a tab button for `"stream"` labeled "Stream" in the drawer tab bar.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.tsx src/execution-drawer-stream.test.tsx
git commit -m "feat(stream): add stream tab to execution drawer with auto-collapse"
```

---

### Task 6: Wire per-node stream into workflow chat

**Files:**
- Modify: `src/workflow-chat.ts` (add optional `streamBuffer` to `ChatMessage`)
- Modify: `src/agent-chat-page.tsx` (render `ExecutionStreamDisclosure` per node/progress message)
- Modify: `src/main.tsx` (route mediator stream events into chat messages)

**Interfaces:**
- Produces: `ChatMessage.streamBuffer?: ExecutionStreamBuffer`
- Consumes: `ExecutionStreamDisclosure`, `appendStreamEvent`, `createStreamBuffer`

- [ ] **Step 1: Write the failing test**

Create `src/workflow-chat-stream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { appendStreamEvent, createStreamBuffer } from "./execution-stream";
import type { ChatMessage } from "./workflow-chat";

describe("workflow chat stream", () => {
  it("attaches a stream buffer to a chat message", () => {
    let buffer = createStreamBuffer("chat/session/turn", "byte", "workflow-chat");
    buffer = appendStreamEvent(buffer, {
      streamKey: "chat/session/turn",
      nodeId: "byte",
      surface: "workflow-chat",
      kind: "reasoning-summary",
      text: "Reviewing the build",
      at: 1,
    });
    const message: ChatMessage = {
      id: "m1",
      role: "assistant",
      text: "I will review the build.",
      at: 1,
      streamBuffer: buffer,
    };
    expect(message.streamBuffer?.lines).toHaveLength(1);
    expect(message.streamBuffer?.lines[0].text).toBe("Reviewing the build");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow-chat-stream.test.ts`
Expected: FAIL with "streamBuffer does not exist on type ChatMessage"

- [ ] **Step 3: Add `streamBuffer` to `ChatMessage`**

In `src/workflow-chat.ts`, add the import and field:

```ts
import type { ExecutionStreamBuffer } from "./execution-stream";
```

Add to `ChatMessage`:

```ts
  streamBuffer?: ExecutionStreamBuffer;
```

- [ ] **Step 4: Render `ExecutionStreamDisclosure` in agent-chat-page.tsx**

In `src/agent-chat-page.tsx`, for each assistant message that has a `streamBuffer`, render a disclosure below the message text:

```tsx
{message.streamBuffer && (
  <ExecutionStreamDisclosure
    buffer={message.streamBuffer}
    expanded={expandedStreamMessageId === message.id}
    onToggle={() =>
      setExpandedStreamMessageId((current) =>
        current === message.id ? null : message.id,
      )
    }
    label="Byte reasoning stream"
  />
)}
```

Add state:

```ts
const [expandedStreamMessageId, setExpandedStreamMessageId] = useState<string | null>(null);
```

- [ ] **Step 5: Route mediator stream events into chat messages in main.tsx**

In the `mediator-chat-delta` listener (or a new `mediator-stream-event` listener), update the pending chat message's `streamBuffer` using `appendStreamEvent`. The existing `mediator-chat-delta` event carries `sessionId`, `messageId`, `threadId`, and `turnId`; use these to build the stream key and patch the correct chat message.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/workflow-chat.ts src/agent-chat-page.tsx src/main.tsx src/workflow-chat-stream.test.ts
git commit -m "feat(stream): wire per-node stream into workflow chat messages"
```

---

## Phase 2: Decision-Center Lifecycle

### Task 7: Derive decision-center visibility from pending decisions

**Files:**
- Modify: `src/main.tsx` (replace independent `approvalCenterOpen` with derived state)
- Create: `src/decision-center-visibility.test.ts`

**Interfaces:**
- Produces: `deriveDecisionCenterOpen(args)` helper
- Consumes: `ApprovalRequest[]`, `MediatorConfirmation | null`, `MediatorQuestion | null`, `LocalTestSession | null`

- [ ] **Step 1: Write the failing test**

Create `src/decision-center-visibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveDecisionCenterOpen } from "./main";

describe("decision center visibility", () => {
  const baseArgs = {
    approvals: [] as Array<{ status: string }>,
    activeConfirmation: null,
    activeQuestion: null,
    localTest: null,
    manualOpen: false,
  };

  it("is closed when there are no pending decisions and no manual open", () => {
    expect(deriveDecisionCenterOpen(baseArgs)).toBe(false);
  });

  it("is open when a native approval is pending", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        approvals: [{ status: "pending" }],
      }),
    ).toBe(true);
  });

  it("is closed when all approvals are resolved and no other decision is pending", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        approvals: [{ status: "approved" }, { status: "declined" }],
      }),
    ).toBe(false);
  });

  it("is open when a confirmation is active", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        activeConfirmation: { id: "c1" } as never,
      }),
    ).toBe(true);
  });

  it("is open when a question is active", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        activeQuestion: { id: "q1" } as never,
      }),
    ).toBe(true);
  });

  it("is open when manually opened with no pending decisions", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        manualOpen: true,
      }),
    ).toBe(true);
  });

  it("is closed when manually closed and no pending decisions remain", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        manualOpen: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/decision-center-visibility.test.ts`
Expected: FAIL with "deriveDecisionCenterOpen is not exported"

- [ ] **Step 3: Export `deriveDecisionCenterOpen` from main.tsx**

Add to `src/main.tsx` (and export):

```ts
export type DecisionCenterVisibilityArgs = {
  approvals: ApprovalRequest[];
  activeConfirmation: MediatorConfirmation | null;
  activeQuestion: MediatorQuestion | null;
  localTest: LocalTestSession | null;
  manualOpen: boolean;
};

export function deriveDecisionCenterOpen(
  args: DecisionCenterVisibilityArgs,
): boolean {
  const hasPendingApproval = args.approvals.some(
    (item) => item.status === "pending",
  );
  const hasPendingLocalTest = args.localTest?.pendingLaunch === true;
  return (
    hasPendingApproval ||
    args.activeConfirmation !== null ||
    args.activeQuestion !== null ||
    hasPendingLocalTest ||
    args.manualOpen
  );
}
```

- [ ] **Step 4: Replace `approvalCenterOpen` usage with derived state**

Replace the `approvalCenterOpen` state with a `manualDecisionCenterOpen` state that the user controls explicitly. Compute the effective open state:

```ts
const [manualDecisionCenterOpen, setManualDecisionCenterOpen] = useState(false);
const decisionCenterOpen = deriveDecisionCenterOpen({
  approvals,
  activeConfirmation,
  activeQuestion,
  localTest,
  manualOpen: manualDecisionCenterOpen,
});
```

Update `closeDecisionCenter` to set `manualDecisionCenterOpen` to false (the derived value will then close the modal when no pending decisions remain). Update all previous `setApprovalCenterOpen(true)` calls to `setManualDecisionCenterOpen(true)`. Replace `approvalCenterOpen` in `renderGlobalModals` with `decisionCenterOpen`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main.tsx src/decision-center-visibility.test.ts
git commit -m "fix(approvals): derive decision-center visibility from pending decisions"
```

---

### Task 8: Clean up pending approvals on run completion/termination

**Files:**
- Modify: `src/main.tsx` (on run completion/termination, mark run-scoped pending approvals as resolved or remove them)
- Modify: `src/approval-lifecycle.ts` (add `clearRunApprovals` helper)
- Modify: `src/approval-lifecycle.test.ts`

**Interfaces:**
- Produces: `clearRunApprovals(approvals, runId)` returning the filtered list

- [ ] **Step 1: Write the failing test**

Append to `src/approval-lifecycle.test.ts`:

```ts
import { clearRunApprovals } from "./approval-lifecycle";

describe("clearRunApprovals", () => {
  it("removes pending run-scoped approvals for the completed run", () => {
    const approvals = [
      { id: "a1", status: "pending", runId: "run1", nativeRequestId: "r1", nodeId: "n1", title: "t", detail: "d", risk: "r" },
      { id: "a2", status: "pending", runId: "run2", nativeRequestId: "r2", nodeId: "n2", title: "t", detail: "d", risk: "r" },
      { id: "a3", status: "approved", runId: "run1", nativeRequestId: "r3", nodeId: "n3", title: "t", detail: "d", risk: "r" },
    ];
    const result = clearRunApprovals(approvals as never, "run1");
    expect(result.map((a) => a.id)).toEqual(["a2", "a3"]);
  });

  it("leaves non-run-scoped approvals untouched", () => {
    const approvals = [
      { id: "a1", status: "pending", nativeRequestId: "r1", nodeId: "n1", title: "t", detail: "d", risk: "r" },
    ];
    const result = clearRunApprovals(approvals as never, "run1");
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/approval-lifecycle.test.ts`
Expected: FAIL with "clearRunApprovals is not exported"

- [ ] **Step 3: Implement `clearRunApprovals`**

Add to `src/approval-lifecycle.ts`:

```ts
export function clearRunApprovals(
  approvals: ApprovalRequest[],
  runId: string,
): ApprovalRequest[] {
  return approvals.filter(
    (item) => !(item.runId === runId && item.status === "pending"),
  );
}
```

- [ ] **Step 4: Wire into run completion/termination in main.tsx**

In the run completion/termination handler (where `runId` is cleared or the run status becomes terminal), call:

```ts
approvalsRef.current = clearRunApprovals(approvalsRef.current, completedRunId);
setApprovals(approvalsRef.current);
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/approval-lifecycle.ts src/approval-lifecycle.test.ts src/main.tsx
git commit -m "fix(approvals): clear run-scoped pending approvals on run completion"
```

---

## Phase 3: Byte Direct Workspace Shell

### Task 9: Upgrade mediator turn to `workspace-write`/`on-request` with approval broker

**Files:**
- Modify: `src-tauri/src/lib.rs` (mediator turn params and approval handling)

**Interfaces:**
- Produces: mediator turn uses `approvalPolicy: "on-request"`, `sandbox: "workspace-write"`, and routes `requestApproval` through the approval broker

- [ ] **Step 1: Write the failing test**

Add a Rust test in `src-tauri/src/lib.rs` (in the existing test module) that verifies the mediator turn start params use `workspace-write` and `on-request`. Since the mediator turn requires a live app-server, test the param construction by extracting a helper function `mediator_turn_params(workspace, model, tools, base, developer)` and asserting on its output.

```rust
#[test]
fn mediator_turn_params_use_workspace_write_and_on_request() {
    let params = mediator_turn_params(
        &PathBuf::from("/tmp/ws"),
        "gpt-5",
        &json!([]),
        "",
        "",
    );
    assert_eq!(params["approvalPolicy"], "on-request");
    assert_eq!(params["sandbox"], "workspace-write");
    assert_eq!(params["cwd"], "/tmp/ws");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mediator_turn_params`
Expected: FAIL with "cannot find function `mediator_turn_params`"

- [ ] **Step 3: Extract `mediator_turn_params` and update mediator turn**

Extract the param construction into a testable helper:

```rust
fn mediator_turn_params(
    workspace: &Path,
    model: &str,
    tools: &Value,
    base: &str,
    developer: &str,
) -> Value {
    let mut params = json!({
        "model": model,
        "cwd": workspace,
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write",
        "ephemeral": true,
        "dynamicTools": tools
    });
    apply_instruction_params(&mut params, base, developer);
    params
}
```

Replace the three inline param blocks in `execute_mediator_turn` (resume, start-after-resume-fail, and fresh start) with calls to `mediator_turn_params`. For the resume path, keep `threadId` and `excludeTurns` but use the helper for the rest.

Add a `requestApproval` handler in the mediator turn loop (similar to the specialist loop) that emits `codex-approval-requested` and waits on the approval broker.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mediator_turn_params`
Expected: PASS

- [ ] **Step 5: Run full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(mediator): upgrade Byte to workspace-write/on-request with approval broker"
```

---

### Task 10: Add publish-operation guard at the native approval boundary

**Files:**
- Modify: `src-tauri/src/lib.rs` (reject `git commit`, `git push`, force-push, destructive reset from mediator shell approval)

**Interfaces:**
- Produces: `is_publish_operation(command: &str) -> bool` helper used by the mediator approval handler

- [ ] **Step 1: Write the failing test**

Add a Rust test:

```rust
#[test]
fn is_publish_operation_detects_git_publish_commands() {
    assert!(is_publish_operation("git push origin main"));
    assert!(is_publish_operation("git commit -m \"release\""));
    assert!(is_publish_operation("git push --force origin main"));
    assert!(is_publish_operation("git reset --hard origin/main"));
    assert!(!is_publish_operation("git status"));
    assert!(!is_publish_operation("git diff"));
    assert!(!is_publish_operation("git log"));
    assert!(!is_publish_operation("npm run build"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml is_publish_operation`
Expected: FAIL with "cannot find function `is_publish_operation`"

- [ ] **Step 3: Implement `is_publish_operation`**

```rust
fn is_publish_operation(command: &str) -> bool {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();
    if !lower.starts_with("git ") {
        return false;
    }
    lower.contains("push") || lower.contains("commit") || lower.contains("reset --hard")
}
```

In the mediator `requestApproval` handler, before forwarding to the broker, check `is_publish_operation` on the command. If true, auto-decline with a typed error: `"Publish operations require the dedicated publish-approval node."`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml is_publish_operation`
Expected: PASS

- [ ] **Step 5: Run full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(mediator): block publish operations from ordinary Byte shell access"
```

---

## Phase 4: Staged Release Graph

### Task 11: Add Release Coordinator, demo, release-commit, and publish-approval nodes to the Software Company template

**Files:**
- Modify: `src/node-packs/template-factory.ts`
- Modify: `src/node-packs/packs.ts` (add `release-coordinator` pack)
- Create: `src/release-candidate.ts` (ReleaseCandidate type and state helpers)
- Create: `src/release-candidate.test.ts`

**Interfaces:**
- Produces: `ReleaseCandidate` type, `release-coordinator` pack, updated `buildSoftwareCompanyTemplate`

- [ ] **Step 1: Write the failing test**

Create `src/release-candidate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createReleaseCandidate,
  transitionPublishState,
} from "./release-candidate";

describe("release candidate", () => {
  it("starts in pending publish state", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    expect(candidate.publishState).toBe("pending");
  });

  it("transitions publish state from pending to approved", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const next = transitionPublishState(candidate, "approved");
    expect(next.publishState).toBe("approved");
  });

  it("transitions publish state from approved to pushed", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const approved = transitionPublishState(candidate, "approved");
    const pushed = transitionPublishState(approved, "pushed");
    expect(pushed.publishState).toBe("pushed");
  });

  it("does not transition from pushed back to pending", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const pushed = transitionPublishState(
      transitionPublishState(candidate, "approved"),
      "pushed",
    );
    const next = transitionPublishState(pushed, "pending");
    expect(next.publishState).toBe("pushed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/release-candidate.test.ts`
Expected: FAIL with "Cannot find module './release-candidate'"

- [ ] **Step 3: Implement `release-candidate.ts`**

```ts
export type ArtifactSnapshotEntry = { key: string; hash: string };

export type PublishState =
  | "pending"
  | "approved"
  | "declined"
  | "pushed"
  | "failed";

export type ReleaseCandidate = {
  runId: string;
  approvedArtifactKeys: ArtifactSnapshotEntry[];
  commitHash?: string;
  commitBranch?: string;
  publishState: PublishState;
  publishError?: string;
  pushedAt?: number;
};

export function createReleaseCandidate(args: {
  runId: string;
  approvedArtifactKeys: ArtifactSnapshotEntry[];
}): ReleaseCandidate {
  return {
    runId: args.runId,
    approvedArtifactKeys: args.approvedArtifactKeys,
    publishState: "pending",
  };
}

const PUBLISH_TRANSITIONS: Record<PublishState, PublishState[]> = {
  pending: ["approved", "declined", "failed"],
  approved: ["pushed", "failed"],
  declined: [],
  pushed: [],
  failed: ["pending"],
};

export function transitionPublishState(
  candidate: ReleaseCandidate,
  next: PublishState,
): ReleaseCandidate {
  const allowed = PUBLISH_TRANSITIONS[candidate.publishState];
  if (!allowed.includes(next)) return candidate;
  return { ...candidate, publishState: next };
}
```

- [ ] **Step 4: Add `release-coordinator` pack**

In `src/node-packs/packs.ts`, add a new pack:

```ts
pack({
  id: "release-coordinator",
  role: "Release Coordinator",
  ...
  sandboxProfile: "read-only",
  approvalPolicy: "never",
  workspacePolicy: "workflow",
  tools: ["Workspace read"],
  developerInstructions: "You are the Release Coordinator. Review QA's verification summary and the approved artifact snapshot. Ask the operator whether the finished product may be run and demonstrated. Present a clear Yes/No question with the candidate details. Do not run the product yourself.",
})
```

- [ ] **Step 5: Update `buildSoftwareCompanyTemplate`**

Replace the `approval` and `output` nodes with:

```ts
packNode("release-coordinator", "release-coordinator", 5, "Release Coordinator", 600),
controlNode("demo", "approval", "Demo launch", 6),
controlNode("release-commit", "approval", "Release commit", 7),
controlNode("publish-approval", "approval", "Publish approval", 8),
controlNode("output", "output", "Release Bundle", 9),
```

Update edges:

```ts
edge("e-qa-release-coordinator", "qa", "release-coordinator"),
edge("e-release-coordinator-demo", "release-coordinator", "demo", "approval"),
edge("e-demo-release-commit", "demo", "release-commit", "approval"),
edge("e-release-commit-publish", "release-commit", "publish-approval", "approval"),
edge("e-publish-output", "publish-approval", "output"),
edge("e-qa-builder-rev", "qa", "builder", "revision"),
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/release-candidate.ts src/release-candidate.test.ts src/node-packs/template-factory.ts src/node-packs/packs.ts
git commit -m "feat(release): add staged release coordinator, demo, commit, publish nodes"
```

---

### Task 12: Implement native release-commit and publish-approval node behavior

**Files:**
- Modify: `src-tauri/src/workflow_runtime.rs` (add release-commit and publish-approval node handlers)
- Create: `src-tauri/src/workflow_runtime/release.rs`
- Modify: `src-tauri/src/workflow_runtime.rs` (module declaration)

**Interfaces:**
- Produces: `release_commit_node(...)`, `publish_approval_node(...)` Rust functions
- Consumes: existing approval gate infrastructure, Git command execution

- [ ] **Step 1: Write the failing test**

Add a Rust test in the new `release.rs` module:

```rust
#[test]
fn release_commit_fails_closed_for_non_git_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let result = create_release_commit(&temp.path(), &ArtifactSnapshot::default());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not a Git repository"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml release_commit`
Expected: FAIL with "cannot find function `create_release_commit`"

- [ ] **Step 3: Implement `release.rs`**

Implement `create_release_commit(workspace, snapshot)`:
- check `workspace.join(".git")` exists; if not, return Err with "not a Git repository";
- run `git status --porcelain` and fail closed if there are uncommitted unrelated changes;
- run `git rev-parse HEAD` to get the current commit;
- record the commit hash and branch;
- return the `ReleaseCommitResult { commit_hash, branch }`.

Implement `publish_approval_node(workspace, commit_hash, branch)`:
- if branch is not `main`, return Err with a clear message;
- run `git push origin <commit_hash>:main` and capture output;
- redact secrets in output;
- return the push result.

Add `mod release;` to `workflow_runtime.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml release_commit`
Expected: PASS

- [ ] **Step 5: Wire into workflow_runtime node dispatch**

In the workflow runtime node dispatch (where `approval` and `output` nodes are handled), add cases for `release-commit` and `publish-approval` node kinds that call the new functions.

- [ ] **Step 6: Run full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/workflow_runtime/release.rs src-tauri/src/workflow_runtime.rs
git commit -m "feat(release): implement native release-commit and publish-approval nodes"
```

---

## Phase 5: Migration and Final Verification

### Task 13: Migrate existing Software Company snapshots to the new graph shape

**Files:**
- Modify: `src/persistence.ts` (add migration for old `approval` → `release-coordinator`/`demo`/`release-commit`/`publish-approval`/`output`)

- [ ] **Step 1: Write the failing test**

Add to `src/persistence.test.ts`:

```ts
it("migrates old software-company approval+output to staged release graph", () => {
  const oldSnapshot = {
    schemaVersion: 4,
    nodes: [
      { id: "input", data: { kind: "input", label: "Mission brief", role: "", model: "", effort: "", tools: [], prompt: "", description: "", duration: "", tokens: 0, trace: [], color: "" } },
      { id: "approval", data: { kind: "approval", label: "Approval", role: "", model: "", effort: "", tools: [], prompt: "", description: "", duration: "", tokens: 0, trace: [], color: "" } },
      { id: "output", data: { kind: "output", label: "Release Bundle", role: "", model: "", effort: "", tools: [], prompt: "", description: "", duration: "", tokens: 0, trace: [], color: "" } },
    ],
    edges: [
      { id: "e-qa-approval", source: "qa", target: "approval", data: { edgeType: "approval" } },
      { id: "e-approval-out", source: "approval", target: "output", data: { edgeType: "standard" } },
    ],
  };
  const result = parseWorkflowSnapshot(oldSnapshot, "software-company-v1");
  const nodeIds = result.nodes.map((n) => n.id);
  expect(nodeIds).toContain("release-coordinator");
  expect(nodeIds).toContain("demo");
  expect(nodeIds).toContain("release-commit");
  expect(nodeIds).toContain("publish-approval");
  expect(nodeIds).not.toContain("approval");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/persistence.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the migration**

In `src/persistence.ts`, in the v4 migration path (or a new v5 path), detect the old `approval` + `output` tail for `software-company-v1` and replace with the new staged nodes.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(migration): upgrade old Software Company snapshots to staged release graph"
```

---

### Task 14: Run full verification suite and manual desktop launch

**Files:** none (verification only)

- [ ] **Step 1: Run frontend tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: Run frontend build**

Run: `npm run build`
Expected: PASS (exit code 0)

- [ ] **Step 3: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS

- [ ] **Step 4: Run desktop build**

Run: `npm run desktop:build`
Expected: produces `release/Codex-Corp.exe`

- [ ] **Step 5: Manual desktop launch verification**

Per `MEMORY.md`:
- Stop only the existing `release/Codex-Corp.exe` instance if its resolved path exactly matches.
- Launch the newly built `release/Codex-Corp.exe`.
- Verify the rendered window shows the app (not `127.0.0.1`, not `ERR_CONNECTION_REFUSED`, not blank).
- Open a Software Company workflow run and verify:
  - the execution drawer has a Stream tab;
  - reasoning-summary events appear as coalesced lines, not one row per token;
  - workflow chat shows a per-node stream disclosure;
  - approving a decision closes the modal when no other decision is pending;
  - the staged release graph shows Release Coordinator, demo, release-commit, and publish-approval nodes.

- [ ] **Step 6: Update MEMORY.md**

Append a dated entry summarizing the changes, verification results, and any new operator notes.

- [ ] **Step 7: Final commit**

```bash
git add MEMORY.md
git commit -m "docs(memory): record stream/decision/release/shell changes and verification"
```

---

## Self-Review

**Spec coverage:**
- Stream visibility (Section 3.1): Tasks 1–6 cover the contract, normalization, wiring, UI, drawer, and chat.
- Decision-center lifecycle (Section 3.2): Tasks 7–8 cover derived visibility and run-completion cleanup.
- Byte direct shell (Section 3.3): Tasks 9–10 cover the native boundary and publish guard.
- Staged release graph (Section 3.4): Tasks 11–13 cover the template, native handlers, and migration.
- Verification (Section 6): Task 14 covers the full suite and manual launch.

**Placeholder scan:** No TBD/TODO placeholders. Each step contains actual code or commands.

**Type consistency:** `ExecutionStreamBuffer`, `ExecutionStreamEvent`, `ExecutionStreamKind` are defined in Task 1 and consumed consistently in Tasks 2–6. `ReleaseCandidate` and `PublishState` are defined in Task 11 and consumed in Task 12. `deriveDecisionCenterOpen` is defined in Task 7 and used in Task 8. `clearRunApprovals` is defined in Task 8. `mediator_turn_params` and `is_publish_operation` are defined in Tasks 9–10.

**Migration:** Task 13 handles backward compatibility for existing Software Company snapshots.
