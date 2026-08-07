import { describe, expect, it } from "vitest";
import { formatExperienceDigest } from "./node-experience";

describe("formatExperienceDigest", () => {
  it("reports no experience when the record list is empty", () => {
    expect(formatExperienceDigest([])).toBe(
      "No prior run experience for this node pattern.",
    );
  });

  it("summarizes counts, recurring failure class, and latest run", () => {
    const records = [
      {
        failureClass: "verification",
        stopReason: "max_retries",
        outcome: "failure",
        attemptCount: 3,
        totalTokens: 1200,
        latencyMs: 4500,
        observedAt: "2026-01-10T00:00:00Z",
      },
      {
        failureClass: "verification",
        stopReason: "plateau",
        outcome: "failure",
        attemptCount: 2,
        totalTokens: 900,
        latencyMs: 3000,
        observedAt: "2026-01-09T00:00:00Z",
      },
      {
        failureClass: null,
        stopReason: null,
        outcome: "success",
        attemptCount: 1,
        totalTokens: 500,
        latencyMs: 1500,
        observedAt: "2026-01-08T00:00:00Z",
      },
    ];
    const digest = formatExperienceDigest(records);
    expect(digest).toContain("Prior runs: 3 (1 success, 2 non-success).");
    expect(digest).toContain(
      "Most recurring failure class: verification (2 occurrences).",
    );
    expect(digest).toContain(
      "Latest: failure at 2026-01-10T00:00:00Z (1200 tokens, 4500ms).",
    );
  });

  it("omits the failure class section when no failures are classified", () => {
    const records = [
      {
        failureClass: null,
        stopReason: null,
        outcome: "success",
        attemptCount: 1,
        totalTokens: 500,
        latencyMs: 1500,
        observedAt: "2026-01-08T00:00:00Z",
      },
    ];
    const digest = formatExperienceDigest(records);
    expect(digest).not.toContain("Most recurring failure class");
    expect(digest).toContain("Prior runs: 1 (1 success, 0 non-success).");
  });
});
