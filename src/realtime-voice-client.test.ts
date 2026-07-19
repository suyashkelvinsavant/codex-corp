import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri event module so tests don't need a real Tauri runtime.
const fakeUnlisten = vi.fn();
const fakeListen = vi.fn().mockResolvedValue(fakeUnlisten);

vi.mock("@tauri-apps/api/event", () => ({
  listen: fakeListen,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const {
  onRealtimeStarted,
  onRealtimeTranscriptDelta,
  onRealtimeTranscriptDone,
  onRealtimeOutputAudio,
  onRealtimeError,
  onRealtimeClosed,
} = await import("./realtime-voice-client");

// These tests pin the listener-registration contract: each helper must return
// a Promise<UnlistenFn> so callers can `await` readiness before triggering the
// action that produces events. The earlier synchronous-return shape raced:
// `listen()` is async, so events fired before registration completed were
// silently lost, and rapid register/unregister leaked the listener (the
// returned closure's `unlisten` was still null until the promise resolved).

describe("realtime-voice-client listener contract", () => {
  beforeEach(() => {
    fakeListen.mockClear();
    fakeUnlisten.mockClear();
    fakeListen.mockResolvedValue(fakeUnlisten);
  });

  it("onRealtimeStarted returns a Promise<UnlistenFn>", async () => {
    const result = onRealtimeStarted("wanted", () => {});
    expect(result).toBeInstanceOf(Promise);
    const unlisten = await result;
    expect(typeof unlisten).toBe("function");
    expect(fakeListen).toHaveBeenCalledWith(
      "codex-realtime-started",
      expect.any(Function),
    );
  });

  it("onRealtimeTranscriptDelta registers on the right channel", async () => {
    await onRealtimeTranscriptDelta("wanted", () => {});
    expect(fakeListen).toHaveBeenCalledWith(
      "codex-realtime-transcript-delta",
      expect.any(Function),
    );
  });

  it("onRealtimeTranscriptDone registers on the right channel", async () => {
    await onRealtimeTranscriptDone("wanted", () => {});
    expect(fakeListen).toHaveBeenCalledWith(
      "codex-realtime-transcript-done",
      expect.any(Function),
    );
  });

  it("onRealtimeOutputAudio registers on the right channel", async () => {
    await onRealtimeOutputAudio("wanted", () => {});
    expect(fakeListen).toHaveBeenCalledWith(
      "codex-realtime-output-audio",
      expect.any(Function),
    );
  });

  it("onRealtimeError registers on the right channel", async () => {
    await onRealtimeError("wanted", () => {});
    expect(fakeListen).toHaveBeenCalledWith(
      "codex-realtime-error",
      expect.any(Function),
    );
  });

  it("onRealtimeClosed registers on the right channel", async () => {
    await onRealtimeClosed("wanted", () => {});
    expect(fakeListen).toHaveBeenCalledWith(
      "codex-realtime-closed",
      expect.any(Function),
    );
  });

  it("drops events belonging to another realtime session", async () => {
    const handler = vi.fn();
    await onRealtimeStarted("wanted", handler);
    const listener = fakeListen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    listener({ payload: { sessionKey: "other", threadId: "t-other" } });
    expect(handler).not.toHaveBeenCalled();
    listener({ payload: { sessionKey: "wanted", threadId: "t-wanted" } });
    expect(handler).toHaveBeenCalledOnce();
  });
});
