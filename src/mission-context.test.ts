import { describe, expect, it } from "vitest";
import {
  composeAuthorizedMission,
  constraintsFromTextarea,
  constraintsToTextarea,
  normalizeMissionConstraints,
} from "./mission-context";

describe("mission-context", () => {
  it("normalizes and de-dupes constraints", () => {
    expect(
      normalizeMissionConstraints([
        "  Single page only ",
        "Single page only",
        "",
        "No auth",
      ]),
    ).toEqual(["Single page only", "No auth"]);
  });

  it("composes mission + constraints + acceptance notes", () => {
    const text = composeAuthorizedMission({
      output: "Build a landing page",
      missionConstraints: ["Single page only", "No backend"],
      acceptanceNotes: "Hero, value props, CTA",
    });
    expect(text).toContain("Build a landing page");
    expect(text).toMatch(/## Constraints/);
    expect(text).toContain("- Single page only");
    expect(text).toContain("- No backend");
    expect(text).toMatch(/## Acceptance notes/);
    expect(text).toContain("Hero, value props, CTA");
  });

  it("uses fallback when mission empty", () => {
    expect(composeAuthorizedMission({})).toMatch(/No workflow mission/);
  });

  it("round-trips textarea constraints", () => {
    const lines = constraintsFromTextarea("A\n\nB\nA");
    expect(lines).toEqual(["A", "B"]);
    expect(constraintsToTextarea(lines)).toBe("A\nB");
  });
});
