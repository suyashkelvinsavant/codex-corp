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
    expect(streamLines(buffer)[streamLines(buffer).length - 1]).toBe("line 25");
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

  it("ignores events for a different stream key", () => {
    let buffer = createStreamBuffer("run/node/turn");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/other/turn",
      nodeId: "other",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "other",
      at: 1,
    });
    expect(streamLines(buffer)).toEqual([]);
  });

  it("coalesces multi-line text into separate lines", () => {
    let buffer = createStreamBuffer("run/node/turn");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "console",
      text: "line one\nline two\nline three",
      at: 1,
    });
    expect(streamLines(buffer)).toEqual(["line one", "line two", "line three"]);
  });
});
