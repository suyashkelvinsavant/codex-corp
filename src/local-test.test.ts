import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode } from "./model";
import {
  appendOperatorTestFeedback,
  applyLocalTestDecision,
  chooseLocalTestRerunNode,
  formatLocalTestPrompt,
  isSafeLocalLaunchPlan,
  prepareLocalTestRerun,
  type LocalTestSession,
} from "./local-test";

const baseSession = (
  partial: Partial<LocalTestSession> = {},
): LocalTestSession => ({
  id: "test-1",
  workflowId: "workflow-1",
  runId: "run-1",
  workspacePath: "C:/projects/shipit",
  status: "launch_pending",
  plan: {
    kind: "package-script",
    program: "npm.cmd",
    args: ["run", "dev"],
    cwd: "C:/projects/shipit",
    entrypoint: "package.json#scripts.dev",
    displayCommand: "npm.cmd run dev",
  },
  feedback: [],
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  ...partial,
});

const node = (
  id: string,
  kind: FlowNode["data"]["kind"],
  label: string,
  status: FlowNode["data"]["status"] = "completed",
): FlowNode => ({
  id,
  type: "corpNode",
  position: { x: 0, y: 0 },
  data: {
    label,
    role: label,
    kind,
    status,
    model: "gpt-5.6",
    effort: "low",
    tools: [],
    prompt: "Do the work",
    description: "",
    duration: "—",
    tokens: 0,
    trace: [],
    color: "#fff",
  },
});

describe("local test lifecycle security and feedback", () => {
  it("rejects shell interpreters and control characters in a launch plan", () => {
    expect(
      isSafeLocalLaunchPlan({
        kind: "manifest",
        program: "cmd.exe",
        args: ["/c", "npm run dev"],
        cwd: "C:/projects/shipit",
        entrypoint: "codex-corp.launch.json",
        displayCommand: "cmd.exe /c npm run dev",
      }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/shell/i) });
    expect(
      isSafeLocalLaunchPlan({
        kind: "manifest",
        program: "C:/projects/shipit/game.exe",
        args: ["--name\u0000evil"],
        cwd: "C:/projects/shipit",
        entrypoint: "codex-corp.launch.json",
        displayCommand: "game.exe",
      }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/control/i) });
  });

  it("rejects a launch plan whose executable escapes the selected workspace", () => {
    expect(
      isSafeLocalLaunchPlan({
        kind: "manifest",
        program: "C:/Windows/System32/calc.exe",
        args: [],
        cwd: "C:/projects/shipit",
        entrypoint: "codex-corp.launch.json",
        displayCommand: "calc.exe",
      }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/workspace/i) });
  });

  it("fails closed for an incomplete launch plan instead of rendering a fake test action", () => {
    expect(
      isSafeLocalLaunchPlan({
        kind: "package-script",
        program: "npm.cmd",
        args: [],
        cwd: "",
        entrypoint: "package.json#scripts.dev",
        displayCommand: "npm.cmd",
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/working directory/i),
    });
  });

  it("rejects malformed native payload types without throwing", () => {
    expect(
      isSafeLocalLaunchPlan({
        kind: "package-script",
        program: "npm.cmd",
        args: null,
        cwd: "C:/projects/shipit",
        entrypoint: "package.json#scripts.dev",
        displayCommand: "npm.cmd run dev",
      } as unknown as LocalTestSession["plan"]),
    ).toEqual({ ok: false, reason: expect.stringMatching(/arguments/i) });
  });

  it("allows feedback only after the local test is running and requires useful change notes", () => {
    expect(applyLocalTestDecision(baseSession(), "approve", "")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/running/i),
    });
    expect(
      applyLocalTestDecision(
        baseSession({ status: "running" }),
        "request_changes",
        "   ",
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/feedback/i),
    });
    expect(
      applyLocalTestDecision(
        baseSession({ status: "running" }),
        "request_changes",
        "The save button does nothing.",
      ),
    ).toMatchObject({
      ok: true,
      session: {
        status: "changes_requested",
        feedback: ["The save button does nothing."],
      },
    });
  });

  it("routes changes to a reachable specialist and never to a control or unrelated branch", () => {
    const nodes = [
      node("input", "input", "Mission"),
      node("builder", "agent", "Builder"),
      node("qa", "agent", "QA"),
      node("approval", "approval", "Release approval"),
      node("output", "output", "Release Bundle"),
      node("unrelated", "agent", "Unrelated", "idle"),
    ];
    const edges: FlowEdge[] = [
      {
        id: "input-builder",
        source: "input",
        target: "builder",
        data: { edgeType: "standard" },
      },
      {
        id: "builder-qa",
        source: "builder",
        target: "qa",
        data: { edgeType: "standard" },
      },
      {
        id: "qa-approval",
        source: "qa",
        target: "approval",
        data: { edgeType: "standard" },
      },
      {
        id: "approval-output",
        source: "approval",
        target: "output",
        data: { edgeType: "standard" },
      },
    ];
    expect(chooseLocalTestRerunNode(nodes, edges)).toMatchObject({
      id: "builder",
    });
    expect(
      chooseLocalTestRerunNode(
        nodes.map((item) =>
          item.id === "builder"
            ? { ...item, data: { ...item.data, status: "failed" } }
            : item,
        ),
        edges,
      ),
    ).toMatchObject({ id: "builder" });
  });

  it("builds the rerun snapshot with bounded feedback attached to the mission input", () => {
    const nodes = [
      node("input", "input", "Mission"),
      node("builder", "agent", "Builder"),
    ];
    const edges: FlowEdge[] = [
      {
        id: "input-builder",
        source: "input",
        target: "builder",
        data: { edgeType: "standard" },
      },
    ];

    const rerun = prepareLocalTestRerun(
      nodes,
      edges,
      "  The save button is clipped.  ",
    );

    expect(rerun).toMatchObject({
      ok: true,
      feedback: "The save button is clipped.",
    });
    if (!rerun.ok) return;
    expect(rerun.rerunNode.id).toBe("builder");
    expect(
      rerun.nodes.find((item) => item.id === "input")?.data.userTestFeedback,
    ).toEqual(["The save button is clipped."]);
  });

  it("bounds stored feedback and produces a prompt that tells the user what to test", () => {
    const feedback = appendOperatorTestFeedback(
      Array.from({ length: 12 }, (_, index) => `old ${index}`),
      "  The form is clipped on mobile.  ",
    );
    expect(feedback).toHaveLength(8);
    expect(feedback[feedback.length - 1]).toBe(
      "The form is clipped on mobile.",
    );
    expect(formatLocalTestPrompt(baseSession({ status: "running" }))).toMatch(
      /test the local build/i,
    );
    expect(formatLocalTestPrompt(baseSession())).toMatch(
      /approve local launch/i,
    );
  });

  it("shows the package script body before the operator approves execution", () => {
    const prompt = formatLocalTestPrompt(
      baseSession({
        plan: {
          ...baseSession().plan,
          script: "vite --host 127.0.0.1",
        },
      }),
    );
    expect(prompt).toContain("Script: vite --host 127.0.0.1");
  });
});
