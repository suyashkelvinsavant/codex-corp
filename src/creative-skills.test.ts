import { describe, expect, it } from "vitest";
import {
  composeCreativeSystemPrompt,
  resolveActiveSkill,
} from "./creative-skills";

describe("creative studio skills", () => {
  it("resolves primary skill from enabled set", () => {
    expect(resolveActiveSkill(["hero", "logo"], "logo").id).toBe("logo");
    expect(resolveActiveSkill(["hero"], "missing").id).toBe("hero");
    expect(resolveActiveSkill(undefined, undefined).id).toBe("");
  });

  it("composes skill-aware system prompts for Live Codex creative nodes", () => {
    const text = composeCreativeSystemPrompt(
      "Brand-safe assets only.",
      ["logo", "ui-asset"],
      "logo",
    );
    expect(text).toContain("Primary: logo");
    expect(text).toContain("Brand-safe assets only.");
    expect(text).toContain("ui-asset");
    expect(text).toMatch(/connector-provided instructions/i);
  });
});
