import { describe, expect, it } from "vitest";
import {
  buildRereviewNote,
  buildRevisionFeedbackNote,
  isLiveThreadId,
  isNonLiveThreadId,
  shouldUseLiveRevision,
} from "./live-revision";

describe("live-revision", () => {
  it("enables live revision only in the Tauri shell", () => {
    expect(shouldUseLiveRevision(true)).toBe(true);
    expect(shouldUseLiveRevision(false)).toBe(false);
  });

  it("rejects synthetic thread prefixes", () => {
    expect(isNonLiveThreadId("demo-builder-revision-thread")).toBe(true);
    expect(isNonLiveThreadId("stub-x")).toBe(true);
    expect(isNonLiveThreadId("mock-1")).toBe(true);
    expect(isNonLiveThreadId("")).toBe(true);
    expect(isNonLiveThreadId(null)).toBe(true);
    expect(isLiveThreadId("019f6297-42e1-7232-b2cc-8eaf5880fff3")).toBe(true);
  });

  it("builds revision and re-review notes", () => {
    expect(buildRevisionFeedbackNote("Quality Gate", "fix a11y")).toMatch(
      /REVISION FEEDBACK FROM Quality Gate/,
    );
    expect(buildRereviewNote()).toMatch(/Re-review/i);
  });
});
