import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserWorkspaceOnce } from "./fresh-app-reset";

describe("fresh app reset", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("removes workflow and chat data once while retaining preferences", () => {
    values.set("codex-corp-workflow:alpha", "graph");
    values.set("codex-corp-chat-sessions:alpha", "chat");
    values.set("codex-corp-chat-sessions:__workflow-architect__", "architect");
    values.set("codex-corp-appearance", "preference");

    expect(resetBrowserWorkspaceOnce()).toBe(true);
    expect(values.has("codex-corp-workflow:alpha")).toBe(false);
    expect(values.has("codex-corp-chat-sessions:alpha")).toBe(false);
    expect(values.has("codex-corp-chat-sessions:__workflow-architect__")).toBe(
      false,
    );
    expect(values.get("codex-corp-appearance")).toBe("preference");
    expect(resetBrowserWorkspaceOnce()).toBe(false);
  });
});
