/**
 * Live Codex revision routing helpers.
 * Revision + re-review always re-invoke execute_agent in the Tauri shell.
 */

/** True when revision/re-review can use live execute_agent (desktop shell). */
export function shouldUseLiveRevision(tauriShell: boolean): boolean {
  return tauriShell;
}

/**
 * Reject known synthetic / non-Codex thread id prefixes (legacy or invalid).
 * Live Codex thread ids never use these prefixes.
 */
export function isNonLiveThreadId(threadId: string | undefined | null): boolean {
  if (!threadId) return true;
  const t = threadId.trim();
  return !t || /^(demo|stub|fake|mock)-/i.test(t);
}

/** True when a specialist thread id looks like a real Live Codex thread. */
export function isLiveThreadId(threadId: string | undefined | null): boolean {
  return Boolean(threadId?.trim()) && !isNonLiveThreadId(threadId);
}

/** Append revision feedback to mission / system prompt for live re-execution. */
export function buildRevisionFeedbackNote(
  fromLabel: string,
  summary: string,
): string {
  return `\n\nREVISION FEEDBACK FROM ${fromLabel}:\n${summary}`;
}

export function buildRereviewNote(): string {
  return `\n\nRe-review the revised build. Prefer status success if the revision addressed feedback.`;
}

/** Event type emitted when a live revision execute_agent thread starts. */
export const REVISION_LIVE_STARTED = "revision.live.started";

/** Event type emitted when live re-review starts. */
export const REVISION_LIVE_REVIEW = "revision.review";
