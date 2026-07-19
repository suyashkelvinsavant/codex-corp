import { describe, expect, it } from "vitest";
import { ByteVoiceSessionController } from "./use-byte-voice-session";

describe("ByteVoiceSessionController", () => {
  it("invalidates rapid open-close-open tokens", () => {
    const controller = new ByteVoiceSessionController();
    const first = controller.begin("first");
    expect(controller.claimStop()).toBe("first");
    const second = controller.begin("second");
    expect(controller.isCurrent(first)).toBe(false);
    expect(controller.isCurrent(second)).toBe(true);
  });

  it("allows a session key to be stopped exactly once", () => {
    const controller = new ByteVoiceSessionController();
    controller.begin("voice");
    expect(controller.claimStop()).toBe("voice");
    expect(controller.claimStop()).toBeNull();
  });

  it("makes an in-flight startup stale when teardown wins", () => {
    const controller = new ByteVoiceSessionController();
    const startup = controller.begin("voice");
    controller.claimStop();
    expect(controller.isCurrent(startup)).toBe(false);
  });
});
