import { describe, expect, it } from "vitest";
import {
  mergeChatStores,
  type ChatMessage,
  type ChatSession,
} from "./workflow-chat";

const message = (id: string, text: string): ChatMessage => ({
  id,
  role: "mediator",
  text,
  at: `2026-07-17T00:00:0${id}.000Z`,
});

const session = (messages: ChatMessage[]): ChatSession => ({
  id: "session",
  workflowId: "workflow",
  title: "Chat",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:02.000Z",
  messages,
});

describe("desktop chat persistence", () => {
  it("merges a pre-hydration write without discarding native history", () => {
    const merged = mergeChatStores(
      {
        sessions: [session([message("1", "native")])],
        activeSessionId: "session",
      },
      {
        sessions: [session([message("2", "pending")])],
        activeSessionId: "session",
      },
    );
    expect(merged.sessions[0].messages.map((item) => item.text)).toEqual([
      "native",
      "pending",
    ]);
  });
});
