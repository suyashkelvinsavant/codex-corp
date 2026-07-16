const RESET_MARKER = "codex-corp:fresh-empty-catalog:2026-07-16";

const WORKSPACE_KEYS = new Set([
  "codex-corp-workflow",
  "codex-corp-active-workflow",
  "codex-corp-runs",
  "codex-corp-custom-workflows",
  "codex-corp-deleted-workflows",
]);

/** One-time destructive migration for the empty-catalog release. */
export function resetBrowserWorkspaceOnce(): boolean {
  try {
    if (localStorage.getItem(RESET_MARKER) === "done") return false;
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((key): key is string => Boolean(key));
    for (const key of keys) {
      if (
        WORKSPACE_KEYS.has(key) ||
        key.startsWith("codex-corp-workflow:") ||
        key.startsWith("codex-corp-chat:") ||
        key.startsWith("codex-corp-chat-sessions:")
      ) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem(RESET_MARKER, "done");
    return true;
  } catch {
    return false;
  }
}
