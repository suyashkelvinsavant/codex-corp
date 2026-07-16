import { describe, expect, it } from "vitest";
import { appendStreamPreview, isAgentMessageDelta } from "./stream-display";

describe("agent streaming display", () => {
  it("coalesces exact deltas into a sentence instead of trace rows", () => {
    let text = "";
    for (const delta of ["Build", " a", " resilient", " app", "."]) {
      text = appendStreamPreview(text, delta);
    }
    expect(text).toBe("Build a resilient app.");
  });

  it("retains only the bounded tail", () => {
    expect(appendStreamPreview("12345", "67890", 6)).toBe("567890");
  });

  it("only treats assistant text notifications as preview deltas", () => {
    expect(isAgentMessageDelta("item/agentMessage/delta")).toBe(true);
    expect(isAgentMessageDelta("item/reasoning/delta")).toBe(false);
    expect(isAgentMessageDelta("turn/completed")).toBe(false);
  });
});
