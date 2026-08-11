import { describe, expect, it } from "vitest";
import {
  appendStreamPreview,
  appendTypedTrace,
  classifyStreamKind,
  isAgentMessageDelta,
  normalizeStreamEventType,
} from "./stream-display";
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
    expect(isAgentMessageDelta("agent.message.delta")).toBe(true);
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

describe("stream event normalization", () => {
  it("normalizes raw event names to canonical names", () => {
    expect(normalizeStreamEventType("agent.message.delta")).toBe("item/agentMessage/delta");
    expect(normalizeStreamEventType("item/agentMessage/delta")).toBe("item/agentMessage/delta");
    expect(normalizeStreamEventType("item/reasoning/summaryTextDelta")).toBe("item/reasoning/summaryTextDelta");
  });

  it("classifies canonical event types into stream kinds", () => {
    expect(classifyStreamKind("item/reasoning/summaryTextDelta")).toBe("reasoning-summary");
    expect(classifyStreamKind("item/reasoning/textDelta")).toBe("reasoning-summary");
    expect(classifyStreamKind("item/plan/delta")).toBe("plan");
    expect(classifyStreamKind("turn/plan/updated")).toBe("plan");
    expect(classifyStreamKind("item/commandExecution/outputDelta")).toBe("console");
    expect(classifyStreamKind("process/outputDelta")).toBe("console");
    expect(classifyStreamKind("turn/diff/updated")).toBe("diff");
    expect(classifyStreamKind("item/fileChange/patchUpdated")).toBe("file-change");
    expect(classifyStreamKind("warning")).toBe("warning");
    expect(classifyStreamKind("item/agentMessage/delta")).toBeNull();
    expect(classifyStreamKind("item/reasoning/textDelta/raw")).toBeNull();
  });
});
