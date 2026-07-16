/** Pure helpers for company-chat auto-scroll policy. */

export type AutoScrollInput = {
  /** User is within threshold of the bottom of the list. */
  pinnedToBottom: boolean;
  /** User just sent a message this tick. */
  justSent: boolean;
  /** Last message id or list length changed since previous render. */
  lastMessageIdChanged: boolean;
  /** Same last message id but text grew (streaming). */
  contentGrew?: boolean;
};

/** Whether the chat list should scroll to the latest message. */
export function shouldAutoScrollChat(input: AutoScrollInput): boolean {
  if (input.justSent) return true;
  if (
    input.pinnedToBottom &&
    (input.lastMessageIdChanged || Boolean(input.contentGrew))
  ) {
    return true;
  }
  return false;
}

/** True when distance from bottom is within `thresholdPx`. */
export function isPinnedToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = 80,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= thresholdPx;
}

/**
 * Fingerprint for poll dedupe + scroll decisions.
 * Includes last message text length so streaming updates are visible.
 */
export function chatMessagesFingerprint(
  messages: Array<{ id: string; text?: string }> | undefined,
): string {
  if (!messages?.length) return "0::0";
  const last = messages[messages.length - 1];
  const len = (last?.text ?? "").length;
  return `${messages.length}:${last?.id ?? ""}:${len}`;
}

export type ChatFingerprintParts = {
  count: string;
  id: string;
  len: number;
};

export function parseChatFingerprint(fp: string): ChatFingerprintParts {
  const [count = "0", id = "", len = "0"] = fp.split(":");
  return { count, id, len: Number(len) || 0 };
}

/**
 * Scroll the chat list container itself — never scrollIntoView, which can
 * yank parent/page layout when the user is reading history.
 */
export function scrollChatListToBottom(
  el: HTMLElement | null | undefined,
  behavior: ScrollBehavior = "auto",
): void {
  if (!el) return;
  if (behavior === "smooth") {
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}
