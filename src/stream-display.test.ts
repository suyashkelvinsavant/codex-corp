import { describe, expect, it } from "vitest";
import { appendStreamPreview, appendTypedTrace, isAgentMessageDelta } from "./stream-display";
import type { TraceRecord } from "./model";

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

  it("bounds typed trace storage by entry count and text size", () => {
    let trace: Array<string | TraceRecord> = [];
    for (let index = 0; index < 100; index += 1) {
      trace = appendTypedTrace(trace, {
        eventType: "item/plan/delta",
        text: "x".repeat(1000),
        at: index,
      }, 20, 5000);
    }
    expect(trace.length).toBeLessThanOrEqual(20);
    expect(trace.reduce((size, item) => size + (typeof item === "string" ? item.length : item.text.length), 0)).toBeLessThanOrEqual(5000);
    const last = trace[trace.length - 1];
    expect(typeof last === "string" ? undefined : last?.eventType).toBe("item/plan/delta");
  });
});
