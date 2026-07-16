import { describe, expect, it } from "vitest";
import {
  chatMessagesFingerprint,
  isPinnedToBottom,
  parseChatFingerprint,
  shouldAutoScrollChat,
} from "./chat-scroll";

describe("chat-scroll", () => {
  it("scrolls after send even if not pinned", () => {
    expect(
      shouldAutoScrollChat({
        pinnedToBottom: false,
        justSent: true,
        lastMessageIdChanged: true,
      }),
    ).toBe(true);
  });

  it("does not scroll when reading history (not pinned, not just sent)", () => {
    expect(
      shouldAutoScrollChat({
        pinnedToBottom: false,
        justSent: false,
        lastMessageIdChanged: true,
        contentGrew: true,
      }),
    ).toBe(false);
  });

  it("scrolls when pinned and a new message arrives", () => {
    expect(
      shouldAutoScrollChat({
        pinnedToBottom: true,
        justSent: false,
        lastMessageIdChanged: true,
      }),
    ).toBe(true);
  });

  it("scrolls when pinned and stream content grows", () => {
    expect(
      shouldAutoScrollChat({
        pinnedToBottom: true,
        justSent: false,
        lastMessageIdChanged: false,
        contentGrew: true,
      }),
    ).toBe(true);
  });

  it("detects pin-to-bottom threshold", () => {
    expect(isPinnedToBottom(0, 100, 100)).toBe(true);
    expect(isPinnedToBottom(0, 100, 500, 80)).toBe(false);
    expect(isPinnedToBottom(320, 100, 500, 80)).toBe(true);
  });

  it("fingerprints message lists for poll dedupe and stream growth", () => {
    expect(chatMessagesFingerprint([])).toBe("0::0");
    expect(
      chatMessagesFingerprint([
        { id: "a", text: "hi" },
        { id: "b", text: "hello" },
      ]),
    ).toBe("2:b:5");
    const parsed = parseChatFingerprint("2:b:5");
    expect(parsed).toEqual({ count: "2", id: "b", len: 5 });
  });
});
