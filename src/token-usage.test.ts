import { describe, expect, it } from "vitest";
import {
  applyTokenUsageToNode,
  extractTotalTokensFromPayload,
  isTokenUsageEventType,
  tokensFromRunRecord,
} from "./token-usage";
import type { FlowNode, RunRecord } from "./model";

const baseNode = (tokens = 0): FlowNode =>
  ({
    id: "builder",
    type: "corpNode",
    position: { x: 0, y: 0 },
    data: {
      label: "Builder",
      role: "Frontend Engineer",
      kind: "agent",
      status: "running",
      model: "test",
      effort: "low",
      tools: ["Shell"],
      prompt: "x".repeat(130),
      description: "",
      duration: "—",
      tokens,
      trace: [],
      color: "#fff",
    },
  }) as FlowNode;

describe("token usage capture", () => {
  it("extracts totalTokens from thread/tokenUsage notification shapes", () => {
    expect(
      extractTotalTokensFromPayload({
        params: {
          tokenUsage: {
            total: { totalTokens: 4200, inputTokens: 3000, outputTokens: 1200 },
          },
        },
      }),
    ).toBe(4200);
    expect(
      extractTotalTokensFromPayload({
        tokenUsage: { last: { totalTokens: 99 } },
      }),
    ).toBe(99);
    expect(
      extractTotalTokensFromPayload({
        tokenUsage: {
          total: { totalTokens: 4_200 },
          last: { inputTokens: 70, outputTokens: 29 },
        },
      }),
    ).toBe(99);
    expect(extractTotalTokensFromPayload({ tokens: 12 })).toBe(12);
    expect(isTokenUsageEventType("thread/tokenUsage/updated")).toBe(true);
    expect(isTokenUsageEventType("agent.token_usage")).toBe(true);
  });

  it("applies monotonic token totals onto live graph nodes", () => {
    const n1 = applyTokenUsageToNode(baseNode(0), 100);
    expect(n1.data.tokens).toBe(100);
    const n2 = applyTokenUsageToNode(n1, 50);
    expect(n2.data.tokens).toBe(100);
    const n3 = applyTokenUsageToNode(n1, 250);
    expect(n3.data.tokens).toBe(250);
  });

  it("sums tokens from hydrated run snapshots (list_runs shape)", () => {
    const record: RunRecord = {
      id: "run-1",
      workflowId: "wf-a",
      status: "completed",
      createdAt: new Date().toISOString(),
      nodesJson: JSON.stringify([
        { id: "a", data: { tokens: 1000 } },
        { id: "b", data: { tokens: 500 } },
      ]),
    };
    expect(tokensFromRunRecord(record)).toBe(1500);
  });

  it("falls back to run events when node tokens are zero", () => {
    const record: RunRecord = {
      id: "run-2",
      workflowId: "wf-b",
      status: "completed",
      createdAt: new Date().toISOString(),
      nodesJson: JSON.stringify([
        { id: "a", data: { tokens: 0 } },
        { id: "b", data: { tokens: 0 } },
      ]),
      eventsJson: JSON.stringify([
        {
          type: "thread/tokenUsage/updated",
          nodeId: "a",
          diagnostics: {
            tokenUsage: { total: { totalTokens: 800 } },
          },
        },
        {
          type: "node.attempt.completed",
          nodeId: "b",
          diagnostics: { tokens: 200 },
        },
      ]),
    };
    expect(tokensFromRunRecord(record)).toBe(1000);
  });
});
