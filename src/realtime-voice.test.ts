import { describe, it, expect } from "vitest";
import {
  initialVoiceStore,
  applyStarted,
  applyTranscriptDelta,
  applyTranscriptDone,
  applyError,
  applyClosed,
  resetStore,
} from "./realtime-voice";

describe("realtime-voice reducer", () => {
  it("applyStarted transitions to live", () => {
    const store = initialVoiceStore("test");
    const next = applyStarted(store, {
      threadId: "t1",
      realtimeSessionId: "rs1",
      version: "v2",
    });
    expect(next.state).toBe("live");
    expect(next.threadId).toBe("t1");
    expect(next.realtimeSessionId).toBe("rs1");
    expect(next.error).toBeNull();
  });

  it("applyTranscriptDelta appends to current turn", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    store = applyTranscriptDelta(store, { role: "user", delta: "Hello" });
    expect(store.transcript).toHaveLength(1);
    expect(store.transcript[0]).toEqual({
      role: "user",
      text: "Hello",
      final: false,
      at: expect.any(Number),
    });

    store = applyTranscriptDelta(store, { role: "user", delta: " world" });
    expect(store.transcript).toHaveLength(1);
    expect(store.transcript[0].text).toBe("Hello world");
  });

  it("applyTranscriptDelta opens new turn on role change", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    store = applyTranscriptDelta(store, { role: "user", delta: "Hi" });
    store = applyTranscriptDelta(store, {
      role: "assistant",
      delta: "Hello!",
    });
    expect(store.transcript).toHaveLength(2);
    expect(store.transcript[1].role).toBe("assistant");
    expect(store.transcript[1].text).toBe("Hello!");
  });

  it("applyTranscriptDone marks last turn final", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    store = applyTranscriptDelta(store, { role: "user", delta: "Hi" });
    store = applyTranscriptDone(store);
    expect(store.transcript[0].final).toBe(true);
  });

  it("applyError transitions to error state", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    store = applyError(store, { message: "Connection lost" });
    expect(store.state).toBe("error");
    expect(store.error).toBe("Connection lost");
  });

  it("applyClosed resets to idle", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    store = applyClosed(store, { reason: "normal" });
    expect(store.state).toBe("idle");
    expect(store.threadId).toBeNull();
    expect(store.realtimeSessionId).toBeNull();
  });

  it("resetStore returns initial state", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    store = applyTranscriptDelta(store, { role: "user", delta: "Hi" });
    const reset = resetStore("test");
    expect(reset.state).toBe("idle");
    expect(reset.transcript).toHaveLength(0);
    expect(reset.threadId).toBeNull();
  });

  it("malformed delta does not crash", () => {
    let store = initialVoiceStore("test");
    store = applyStarted(store, { threadId: "t1" });
    // Empty delta
    store = applyTranscriptDelta(store, { role: "", delta: "" });
    expect(store.transcript).toHaveLength(1);
    expect(store.transcript[0].text).toBe("");
  });
});
