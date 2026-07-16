import { describe, expect, it } from "vitest";
import {
  classifyAttachment,
  toCodexUserInputs,
  type ChatAttachment,
} from "./workflow-chat";

describe("mediator attachments → Codex UserInput", () => {
  it("classifies images and text docs", () => {
    expect(classifyAttachment("image/png", "logo.png")).toBe("image");
    expect(classifyAttachment("text/plain", "notes.txt")).toBe("text");
    expect(classifyAttachment("application/pdf", "brief.pdf")).toBe("document");
  });

  it("maps images to image/localImage and text to text blocks", () => {
    const files: ChatAttachment[] = [
      {
        id: "1",
        name: "shot.png",
        mime: "image/png",
        size: 12,
        kind: "image",
        dataUrl: "data:image/png;base64,xx",
      },
      {
        id: "2",
        name: "spec.md",
        mime: "text/markdown",
        size: 20,
        kind: "text",
        textExcerpt: "# Spec\nHello",
      },
    ];
    const inputs = toCodexUserInputs("Please review", files);
    expect(inputs[0]).toMatchObject({ type: "text", text: "Please review" });
    expect(inputs.some((i) => i.type === "image")).toBe(true);
    expect(
      inputs.some(
        (i) => i.type === "text" && String(i.text).includes("Attached file: spec.md"),
      ),
    ).toBe(true);
  });
});
