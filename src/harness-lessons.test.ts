import { describe, expect, it } from "vitest";
import {
  formatLessonDigest,
  listHarnessLessons,
  refineHarnessLessons,
  type HarnessLesson,
} from "./harness-lessons";

describe("formatLessonDigest", () => {
  it("reports no lessons when the list is empty", () => {
    expect(formatLessonDigest([])).toBe(
      "No active harness lessons for this pattern.",
    );
  });

  it("lists each lesson with id, title, source, version, and failure class", () => {
    const lessons: HarnessLesson[] = [
      {
        id: 7,
        role: "backend-engineer",
        model: "gpt-5.6",
        effort: "medium",
        title: "contract failure guidance",
        body: "Return strictly valid structured JSON.",
        evidence: { failureClass: "contract" },
        status: "active",
        source: "refine",
        currentVersion: 2,
        createdAt: "2026-01-10T00:00:00Z",
        updatedAt: "2026-01-11T00:00:00Z",
      },
      {
        id: 12,
        role: "backend-engineer",
        model: "gpt-5.6",
        effort: "medium",
        title: "plateau guard",
        body: "Vary the strategy if the first approach fails.",
        evidence: { failureClass: "plateau" },
        status: "active",
        source: "manual",
        currentVersion: 1,
        createdAt: "2026-01-12T00:00:00Z",
        updatedAt: "2026-01-12T00:00:00Z",
      },
    ];
    const digest = formatLessonDigest(lessons);
    expect(digest).toContain("Active harness lessons: 2.");
    expect(digest).toContain('#7 "contract failure guidance" [refine, v2, contract]');
    expect(digest).toContain("Return strictly valid structured JSON.");
    expect(digest).toContain('#12 "plateau guard" [manual, v1, plateau]');
    expect(digest).toContain("prepended to the specialist's developer instructions");
  });

  it("falls back to general when evidence has no failureClass", () => {
    const lessons: HarnessLesson[] = [
      {
        id: 1,
        role: "r",
        model: "m",
        effort: "e",
        title: "generic",
        body: "Be careful.",
        evidence: {},
        status: "active",
        source: "manual",
        currentVersion: 1,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const digest = formatLessonDigest(lessons);
    expect(digest).toContain("[manual, v1, general]");
  });
});

describe("bridge no-ops outside Tauri", () => {
  // Outside the Tauri desktop shell the bridge returns empty/no-op results so
  // unit tests and browser-only Vite do not crash on missing invoke handlers.
  it("listHarnessLessons returns empty array", async () => {
    const rows = await listHarnessLessons();
    expect(rows).toEqual([]);
  });

  it("refineHarnessLessons returns a zero summary", async () => {
    const result = await refineHarnessLessons();
    expect(result.summary).toEqual({ created: 0, updated: 0, skipped: 0 });
    expect(result.actions).toEqual([]);
  });
});
