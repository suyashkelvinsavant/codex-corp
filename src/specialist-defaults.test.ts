import { describe, expect, it } from "vitest";
import {
  ARCHITECT_PROMPT_QUALITY_REQUIREMENTS,
  defaultSpecialistForRole,
  ensureSpecialistQuality,
  isWeakSpecialistPrompt,
  MIN_SPECIALIST_PROMPT_CHARS,
} from "./specialist-defaults";
import { WORKFLOW_ARCHITECT_SYSTEM_PROMPT } from "./workflow-architect-tools";

describe("specialist defaults", () => {
  it("provides role-specific detailed prompts, tools, and skills", () => {
    const builder = defaultSpecialistForRole("Frontend Engineer", "agent");
    expect(builder.prompt.length).toBeGreaterThan(MIN_SPECIALIST_PROMPT_CHARS);
    expect(builder.tools.length).toBeGreaterThan(0);
    expect(builder.skills.length).toBeGreaterThan(0);
    expect(builder.prompt.toLowerCase()).toMatch(/frontend|implementer|ui/);

    const creative = defaultSpecialistForRole("Creative", "creative");
    expect(creative.prompt.length).toBeGreaterThan(MIN_SPECIALIST_PROMPT_CHARS);
    expect(creative.tools).toEqual(
      expect.arrayContaining(["Image generation", "Image edit"]),
    );
  });

  it("flags empty and placeholder prompts as weak", () => {
    expect(isWeakSpecialistPrompt("")).toBe(true);
    expect(isWeakSpecialistPrompt("Define this node contract.")).toBe(true);
    expect(isWeakSpecialistPrompt("Do the work.")).toBe(true);
    const strong = defaultSpecialistForRole("Architect", "agent").prompt;
    expect(isWeakSpecialistPrompt(strong)).toBe(false);
  });

  it("fills weak specialist fields without overwriting strong prompts", () => {
    const weak = ensureSpecialistQuality({
      kind: "agent",
      role: "Researcher",
      label: "Research",
      prompt: "todo",
      tools: [],
      skills: [],
      description: "",
    });
    expect(weak.prompt.length).toBeGreaterThan(MIN_SPECIALIST_PROMPT_CHARS);
    expect(weak.tools.length).toBeGreaterThan(0);
    expect(weak.skills.length).toBeGreaterThan(0);

    const custom =
      "You are a custom researcher with a carefully authored multi-line brief.\n\nMission\n- Only answer X.\n\nProcess\n1. A\n2. B\n\nOutput contract\n- Return findings with sources and residual unknowns for the architect.";
    const strong = ensureSpecialistQuality({
      kind: "agent",
      role: "Researcher",
      prompt: custom,
      tools: ["Custom tool"],
      skills: ["custom-skill"],
      description: "Custom desc",
    });
    expect(strong.prompt).toBe(custom);
    expect(strong.tools).toEqual(["Custom tool"]);
    expect(strong.skills).toEqual(["custom-skill"]);
  });

  it("requires Architect system prompt to mandate detailed prompts, tools, and skills", () => {
    const lower = WORKFLOW_ARCHITECT_SYSTEM_PROMPT.toLowerCase();
    for (const req of ARCHITECT_PROMPT_QUALITY_REQUIREMENTS) {
      expect(lower).toContain(req.toLowerCase());
    }
  });
});
