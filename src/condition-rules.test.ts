import { describe, expect, it } from "vitest";
import {
  evaluateConditionRule,
  validateConditionRule,
} from "./condition-rules";

describe("condition rules", () => {
  it("evaluates allowlisted field comparisons", () => {
    const source = { data: { risk: "high", score: 82, tags: ["ship"] } };
    expect(
      evaluateConditionRule(
        {
          path: "$.data.score",
          operator: ">=",
          value: 80,
          trueBranch: "ship",
          falseBranch: "iterate",
        },
        source,
      ),
    ).toBe(true);
    expect(
      evaluateConditionRule(
        {
          path: "$.data.tags",
          operator: "contains",
          value: "ship",
          trueBranch: "ship",
          falseBranch: "iterate",
        },
        source,
      ),
    ).toBe(true);
  });

  it("rejects unsafe or incomplete rules", () => {
    expect(validateConditionRule(undefined)).not.toHaveLength(0);
    expect(
      validateConditionRule({
        path: "window.alert(1)",
        operator: "exists",
        trueBranch: "same",
        falseBranch: "same",
      }),
    ).toHaveLength(2);
  });
});
