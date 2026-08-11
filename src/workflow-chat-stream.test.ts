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
      role: "mediator",
      text: "I will review the build.",
      at: "2026-08-12T00:00:00Z",
      streamBuffer: buffer,
    };
    expect(message.streamBuffer?.lines).toHaveLength(1);
    expect(message.streamBuffer?.lines[0].text).toBe("Reviewing the build");
  });

  it("coalesces stream fragments in chat messages", () => {
    let buffer = createStreamBuffer("chat/session/turn", "byte", "workflow-chat");
    for (const text of ["Reviewing", " the", " build", " output"]) {
      buffer = appendStreamEvent(buffer, {
        streamKey: "chat/session/turn",
        nodeId: "byte",
        surface: "workflow-chat",
        kind: "reasoning-summary",
        text,
        at: Date.now(),
      });
    }
    expect(buffer.lines).toHaveLength(1);
    expect(buffer.lines[0].text).toBe("Reviewing the build output");
  });
});
