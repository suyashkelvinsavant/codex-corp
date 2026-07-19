import { describe, expect, it } from "vitest";
import {
  buildUserInputResponse,
  parseUserInputQuestions,
  parseElicitationForm,
} from "./codex-interactions";

describe("Codex server interactions", () => {
  it("preserves multiple questions, labels, Other, and secret fields", () => {
    const questions = parseUserInputQuestions({
      questions: [
        { id: "env", header: "Target", question: "Where?", isOther: true, isSecret: false, options: [{ label: "Prod", description: "Live" }] },
        { id: "token", header: "Token", question: "Secret?", isOther: false, isSecret: true, options: null },
      ],
      autoResolutionMs: 60000,
    });
    expect(questions).toHaveLength(2);
    expect(questions[0].options?.[0].id).toBe("Prod");
    expect(questions[0].allowFreeText).toBe(true);
    expect(questions[1].secret).toBe(true);
  });

  it("builds the generated answers map and never auto-selects", () => {
    expect(buildUserInputResponse([
      { questionId: "env", optionIds: ["Prod"], freeText: "", at: "now" },
      { questionId: "note", optionIds: [], freeText: "custom", at: "now" },
    ])).toEqual({ answers: { env: { answers: ["Prod"] }, note: { answers: ["custom"] } } });
    expect(buildUserInputResponse([])).toEqual({ answers: {} });
  });

  it("rejects malformed elicitation schemas instead of inventing fields", () => {
    expect(() => parseElicitationForm({ mode: "form", requestedSchema: { type: "array" } })).toThrow(/object schema/);
  });
});
