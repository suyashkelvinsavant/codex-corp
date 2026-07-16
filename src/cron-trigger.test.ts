import { describe, expect, it } from "vitest";
import { matchCron } from "./cron-trigger";

describe("cron trigger", () => {
  it("matches standard five-field schedules in the selected timezone", () => {
    const now = new Date("2026-07-16T12:30:00Z");
    expect(matchCron("0 18 * * 4", "Asia/Calcutta", now).matches).toBe(true);
    expect(matchCron("30 18 * * 4", "Asia/Calcutta", now).matches).toBe(false);
  });

  it("supports step expressions", () => {
    expect(
      matchCron("*/15 * * * *", "UTC", new Date("2026-07-16T12:30:00Z"))
        .matches,
    ).toBe(true);
  });
});
