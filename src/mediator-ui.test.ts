import { describe, expect, it } from "vitest";
import {
  formatQuestionAnswerForChat,
  isLifecycleRunEvent,
  isCodexAgentLifecycleEvent,
  mediatorControlHelpText,
  notificationFromRunEvent,
  parseMediatorControlIntent,
  progressLineFromRunEvent,
} from "./mediator-ui";
import type { RunEvent } from "./model";

const ev = (partial: Partial<RunEvent>): RunEvent => ({
  id: "e1",
  at: new Date().toISOString(),
  type: "node.started",
  message: "Builder · fresh thread started",
  nodeId: "builder",
  level: "info",
  ...partial,
});

describe("mediator-ui", () => {
  it("treats only lifecycle events as progress fan-out", () => {
    expect(isLifecycleRunEvent("node.started")).toBe(true);
    expect(isLifecycleRunEvent("node.completed")).toBe(true);
    expect(isLifecycleRunEvent("item/agentMessage/delta")).toBe(false);
    expect(isLifecycleRunEvent("turn/started")).toBe(false);
  });

  it("keeps streaming deltas and token accounting out of timeline rows", () => {
    expect(isCodexAgentLifecycleEvent("item/agentMessage/delta")).toBe(false);
    expect(isCodexAgentLifecycleEvent("thread/tokenUsage/updated")).toBe(false);
    expect(isCodexAgentLifecycleEvent("item/completed")).toBe(true);
    expect(isCodexAgentLifecycleEvent("turn/failed")).toBe(true);
  });

  it("formats progress lines for chat", () => {
    expect(progressLineFromRunEvent(ev({ type: "node.started" }))).toMatch(
      /In progress/,
    );
    expect(
      progressLineFromRunEvent(
        ev({ type: "node.completed", message: "Build Agent · completed" }),
      ),
    ).toMatch(/Completed/);
  });

  it("builds toast notifications from lifecycle events", () => {
    const n = notificationFromRunEvent(ev({ type: "node.failed", level: "error" }));
    expect(n?.level).toBe("error");
    expect(n?.nodeId).toBe("builder");
  });

  it("parses mediator control intents", () => {
    expect(parseMediatorControlIntent("status").kind).toBe("status");
    expect(parseMediatorControlIntent("stop now").kind).toBe("stop");
    expect(parseMediatorControlIntent("approve").kind).toBe("approve");
    const mission = parseMediatorControlIntent(
      "mission: Build a calm landing page",
    );
    expect(mission).toEqual({
      kind: "set_mission",
      mission: "Build a calm landing page",
    });
    const run = parseMediatorControlIntent("run with: One page only");
    expect(run.kind).toBe("run");
    if (run.kind === "run") expect(run.mission).toBe("One page only");
  });

  it("formats question answers for the chat transcript", () => {
    const text = formatQuestionAnswerForChat(
      {
        id: "q1",
        title: "Theme",
        body: "Pick a theme",
        options: [
          { id: "dark", label: "Dark only" },
          { id: "both", label: "Light + dark" },
        ],
        source: "mediator",
      },
      {
        questionId: "q1",
        optionIds: ["dark"],
        freeText: "High contrast",
        at: new Date().toISOString(),
      },
    );
    expect(text).toMatch(/Dark only/);
    expect(text).toMatch(/High contrast/);
  });

  it("exposes control help text", () => {
    expect(mediatorControlHelpText()).toMatch(/mission:/i);
  });
});
