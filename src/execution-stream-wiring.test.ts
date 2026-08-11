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

  it("normalizes specialist agent.message.delta so it is recognized as streaming", () => {
    expect(normalizeStreamEventType("agent.message.delta")).toBe(
      "item/agentMessage/delta",
    );
  });
});
