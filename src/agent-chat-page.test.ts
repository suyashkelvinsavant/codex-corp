import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentChatPage, type AgentChatPageProps } from "./agent-chat-page";
import type { LocalTestSession } from "./local-test";

const session = (status: LocalTestSession["status"]): LocalTestSession => ({
  id: "local-test-chat-1",
  workflowId: "software-company-v1",
  runId: "run-chat-1",
  workspacePath: "C:/fixture/release",
  status,
  plan: {
    kind: "package-script",
    program: "npm.cmd",
    args: ["run", "dev"],
    cwd: "C:/fixture/release",
    entrypoint: "package.json#scripts.dev",
    displayCommand: "npm.cmd run dev",
    script: "vite --host 127.0.0.1",
  },
  feedback: [],
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  detectedUrl: "http://127.0.0.1:4173",
});

function markupFor(localTest: LocalTestSession): string {
  const props: AgentChatPageProps = {
    workflowId: "software-company-v1",
    activeWorkflowId: "software-company-v1",
    running: false,
    runId: null,
    events: [],
    approvals: [],
    runHistory: [],
    completedCount: 0,
    totalExecutable: 1,
    pendingDecisionCount: localTest.status === "launch_pending" ? 1 : 0,
    localTest,
    onOpenApprovals: vi.fn(),
    onSubmitLocalTestFeedback: vi.fn(async () => undefined),
    onStopLocalTest: vi.fn(async () => undefined),
    onBack: vi.fn(),
    onEditWorkflow: vi.fn(),
    voiceContext: {
      developerInstructions: "",
      contextDigest: "",
      dynamicTools: [],
    },
    onVoiceToolCall: vi.fn(async () => ({ success: true, text: "ok" })),
    voiceAvailable: false,
    onVoiceUnavailable: vi.fn(),
  };
  return renderToStaticMarkup(createElement(AgentChatPage, props));
}

describe("AgentChatPage local test loop", () => {
  it("explains that a pending launch needs approval before the app starts", () => {
    expect(markupFor(session("launch_pending"))).toContain(
      "Approval required before the local app starts.",
    );
  });

  it("exposes the preview location and disables an empty change request", () => {
    const markup = markupFor(session("running"));
    expect(markup).toContain("Open: http://127.0.0.1:4173");
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Request changes<\/button>/,
    );
  });
});
