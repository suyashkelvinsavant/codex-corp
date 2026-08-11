import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExecutionStreamDisclosure } from "./execution-stream-disclosure";
import { appendStreamEvent, createStreamBuffer } from "./execution-stream";

describe("ExecutionStreamDisclosure", () => {
  it("renders nothing when there is no buffer", () => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionStreamDisclosure, {
        buffer: undefined,
        expanded: false,
        onToggle: vi.fn(),
      }),
    );
    expect(markup).toBe("");
  });

  it("renders a collapsed summary by default", () => {
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "Planning the build",
      at: 1,
    });
    const markup = renderToStaticMarkup(
      createElement(ExecutionStreamDisclosure, {
        buffer,
        expanded: false,
        onToggle: vi.fn(),
      }),
    );
    expect(markup).toContain("execution-stream-toggle");
    expect(markup).toContain("Reasoning summary");
    expect(markup).not.toContain("Planning the build");
  });

  it("renders stream lines when expanded", () => {
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "reasoning-summary",
      text: "Planning the build",
      at: 1,
    });
    const markup = renderToStaticMarkup(
      createElement(ExecutionStreamDisclosure, {
        buffer,
        expanded: true,
        onToggle: vi.fn(),
      }),
    );
    expect(markup).toContain("Planning the build");
    expect(markup).toContain("execution-stream-viewport");
  });

  it("uses the custom label when provided", () => {
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "console",
      text: "npm run build",
      at: 1,
    });
    const markup = renderToStaticMarkup(
      createElement(ExecutionStreamDisclosure, {
        buffer,
        expanded: false,
        onToggle: vi.fn(),
        label: "Builder stream",
      }),
    );
    expect(markup).toContain("Builder stream");
  });

  it("renders multiple lines when expanded", () => {
    let buffer = createStreamBuffer("run/node/turn", "node");
    buffer = appendStreamEvent(buffer, {
      streamKey: "run/node/turn",
      nodeId: "node",
      surface: "workflow-node",
      kind: "console",
      text: "line one\nline two\nline three",
      at: 1,
    });
    const markup = renderToStaticMarkup(
      createElement(ExecutionStreamDisclosure, {
        buffer,
        expanded: true,
        onToggle: vi.fn(),
      }),
    );
    expect(markup).toContain("line one");
    expect(markup).toContain("line two");
    expect(markup).toContain("line three");
  });
});
