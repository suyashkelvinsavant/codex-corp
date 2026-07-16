import { describe, expect, it } from "vitest";
import {
  appendCompletionCriteriaToPrompt,
  criteriaEvalSummary,
  defaultPlatformCriteria,
  ensureCompletionCriteria,
  evaluateCompletionCriteria,
  makeCustomCriterion,
} from "./completion-criteria";

describe("completion-criteria", () => {
  it("seeds platform criteria and merges custom", () => {
    const custom = makeCustomCriterion("Ship only SPA");
    const merged = ensureCompletionCriteria([
      { ...defaultPlatformCriteria()[0], enabled: false },
      custom,
    ]);
    expect(merged.find((c) => c.id === "structured_json")?.enabled).toBe(true);
    expect(merged.find((c) => c.id === "structured_json")?.enforcement).toBe(
      "required",
    );
    expect(merged.some((c) => c.id === custom.id)).toBe(true);
    expect(merged.filter((c) => c.platform)).toHaveLength(3);
  });

  it("defaults custom criteria to required and preserves advisory choice", () => {
    const required = makeCustomCriterion("Include screenshots");
    expect(required.enforcement).toBe("required");
    const merged = ensureCompletionCriteria([
      { ...required, enforcement: "advisory" },
    ]);
    expect(merged.find((item) => item.id === required.id)?.enforcement).toBe(
      "advisory",
    );
  });

  it("appends enabled criteria to system prompt", () => {
    const prompt = appendCompletionCriteriaToPrompt("You are Builder.", [
      ...defaultPlatformCriteria(),
      { ...makeCustomCriterion("Use teal accent"), enabled: true },
    ]);
    expect(prompt).toMatch(/You are Builder/);
    expect(prompt).toMatch(/Completion criteria/);
    expect(prompt).toMatch(/structured JSON/i);
    expect(prompt).toMatch(/Use teal accent/);
  });

  it("evaluates platform criteria against real result shapes", () => {
    const good = evaluateCompletionCriteria(undefined, {
      status: "success",
      summary: "Implemented the landing page hero and CTA.",
      data: { filesWritten: ["src/App.jsx"] },
    });
    expect(good.every((e) => e.status === "pass")).toBe(true);
    expect(criteriaEvalSummary(good).passed).toBe(3);

    const bad = evaluateCompletionCriteria(undefined, {
      status: "",
      summary: "",
    });
    expect(bad.find((e) => e.id === "structured_json")?.status).toBe("fail");
    expect(bad.find((e) => e.id === "concise_summary")?.status).toBe("fail");

    const leak = evaluateCompletionCriteria(undefined, {
      status: "success",
      summary: "chain-of-thought: step 1 then step 2 done.",
      data: {},
    });
    expect(leak.find((e) => e.id === "no_hidden_reasoning")?.status).toBe(
      "fail",
    );
  });

  it("marks pending when no result yet", () => {
    const pending = evaluateCompletionCriteria(defaultPlatformCriteria(), null);
    expect(pending.every((e) => e.status === "pending")).toBe(true);
  });

  it("requires explicit structured evidence for custom criteria", () => {
    const custom = makeCustomCriterion("Include screenshots");
    const missing = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Completed the requested visual verification.",
      data: { criteria: [] },
    });
    expect(missing.find((item) => item.id === custom.id)?.status).toBe("fail");
    const evidenced = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Completed the requested visual verification.",
      data: {
        criteria: [
          { id: custom.id, passed: true, evidence: "Two screenshots attached" },
        ],
      },
    });
    expect(evidenced.find((item) => item.id === custom.id)?.status).toBe(
      "pass",
    );
  });
});
