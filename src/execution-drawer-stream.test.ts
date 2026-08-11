import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExecutionStreamDisclosure } from "./execution-stream-disclosure";
import { appendStreamEvent, createStreamBuffer } from "./execution-stream";

describe("execution drawer stream view", () => {
  it("shows only the active node's expanded stream when multiple nodes have buffers", () => {
    let builderBuffer = createStreamBuffer("run/builder/turn", "builder");
    builderBuffer = appendStreamEvent(builderBuffer, {
      streamKey: "run/builder/turn",
      nodeId: "builder",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "builder thinking",
      at: 1,
    });
    let qaBuffer = createStreamBuffer("run/qa/turn", "qa");
    qaBuffer = appendStreamEvent(qaBuffer, {
      streamKey: "run/qa/turn",
      nodeId: "qa",
      surface: "workflow-node",
      kind: "console",
      text: "qa output",
      at: 2,
    });
    const activeNodeId: string = "qa";
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(ExecutionStreamDisclosure, {
          buffer: builderBuffer,
          expanded: activeNodeId === "builder",
          onToggle: vi.fn(),
          label: "Builder stream",
        }),
        createElement(ExecutionStreamDisclosure, {
          buffer: qaBuffer,
          expanded: activeNodeId === "qa",
          onToggle: vi.fn(),
          label: "QA stream",
        }),
      ),
    );
    expect(markup).toContain("qa output");
    expect(markup).not.toContain("builder thinking");
  });

  it("collapses the previous stream when a new node becomes active", () => {
    let builderBuffer = createStreamBuffer("run/builder/turn", "builder");
    builderBuffer = appendStreamEvent(builderBuffer, {
      streamKey: "run/builder/turn",
      nodeId: "builder",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "builder thinking",
      at: 1,
    });
    let qaBuffer = createStreamBuffer("run/qa/turn", "qa");
    qaBuffer = appendStreamEvent(qaBuffer, {
      streamKey: "run/qa/turn",
      nodeId: "qa",
      surface: "workflow-node",
      kind: "console",
      text: "qa output",
      at: 2,
    });
    // First, builder is active
    const activeFirst: string = "builder";
    const markupFirst = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(ExecutionStreamDisclosure, {
          buffer: builderBuffer,
          expanded: activeFirst === "builder",
          onToggle: vi.fn(),
          label: "Builder stream",
        }),
        createElement(ExecutionStreamDisclosure, {
          buffer: qaBuffer,
          expanded: activeFirst === "qa",
          onToggle: vi.fn(),
          label: "QA stream",
        }),
      ),
    );
    expect(markupFirst).toContain("builder thinking");
    expect(markupFirst).not.toContain("qa output");

    // Then qa becomes active, builder collapses
    const activeSecond: string = "qa";
    const markupSecond = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(ExecutionStreamDisclosure, {
          buffer: builderBuffer,
          expanded: activeSecond === "builder",
          onToggle: vi.fn(),
          label: "Builder stream",
        }),
        createElement(ExecutionStreamDisclosure, {
          buffer: qaBuffer,
          expanded: activeSecond === "qa",
          onToggle: vi.fn(),
          label: "QA stream",
        }),
      ),
    );
    expect(markupSecond).toContain("qa output");
    expect(markupSecond).not.toContain("builder thinking");
  });
});
