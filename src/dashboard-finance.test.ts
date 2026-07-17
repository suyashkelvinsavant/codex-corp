import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateDashboard,
  composeDashboardFeedback,
  createFinanceEntry,
  estimateTokenCostUsd,
  listFinanceEntries,
  publishDashboardFeedback,
  summarizePortfolioRuns,
  tokensFromRunRecord,
} from "./dashboard-finance";
import { saveCustomWorkflow } from "./templates";
import type { RunRecord } from "./model";

describe("dashboard finance", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    saveCustomWorkflow({
      id: "wf-a",
      name: "Alpha Co",
      description: "A",
      version: "v1.0",
      nodes: [],
      edges: [],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sums token burn from run node snapshots and estimates cost", () => {
    const run: RunRecord = {
      id: "run-1",
      workflowId: "wf-a",
      status: "completed",
      createdAt: new Date().toISOString(),
      nodesJson: JSON.stringify([
        { data: { tokens: 1200 } },
        { data: { tokens: 800 } },
      ]),
    };
    expect(tokensFromRunRecord(run)).toBe(2000);
    expect(estimateTokenCostUsd(2000, 0.01)).toBeCloseTo(0.02);

    createFinanceEntry({
      workflowId: "wf-a",
      kind: "revenue",
      source: "google_play",
      amount: 100,
    });
    createFinanceEntry({
      workflowId: "wf-a",
      kind: "expense",
      source: "manual",
      amount: 25,
    });

    const snap = aggregateDashboard([run], listFinanceEntries(), 0.01);
    expect(snap.totalTokenBurn).toBe(2000);
    expect(snap.totalEstimatedCostUsd).toBeCloseTo(0.02);
    expect(snap.totalRevenue).toBe(100);
    expect(snap.totalExpense).toBe(25);
    expect(snap.totalNet).toBe(75);
    const row = snap.byWorkflow.find((r) => r.workflowId === "wf-a");
    expect(row?.workflowName).toBe("Alpha Co");
    expect(row?.net).toBe(75);
  });

  it("aggregates portfolio burn across multiple workflows (not active-only)", () => {
    saveCustomWorkflow({
      id: "wf-b",
      name: "Beta Co",
      description: "B",
      version: "v1.0",
      nodes: [],
      edges: [],
    });
    const runs: RunRecord[] = [
      {
        id: "r1",
        workflowId: "wf-a",
        status: "completed",
        createdAt: new Date().toISOString(),
        nodesJson: JSON.stringify([{ data: { tokens: 1000 } }]),
      },
      {
        id: "r2",
        workflowId: "wf-b",
        status: "completed",
        createdAt: new Date().toISOString(),
        nodesJson: JSON.stringify([{ data: { tokens: 2500 } }]),
      },
    ];
    const snap = aggregateDashboard(runs, [], 0.01);
    expect(snap.totalTokenBurn).toBe(3500);
    expect(snap.byWorkflow.map((r) => r.workflowId).sort()).toEqual([
      "wf-a",
      "wf-b",
    ]);
    expect(
      snap.byWorkflow.find((r) => r.workflowId === "wf-b")?.tokenBurn,
    ).toBe(2500);
  });

  it("summarizes lifetime runs into compact per-workflow totals", () => {
    const runs: RunRecord[] = [
      {
        id: "r1",
        workflowId: "wf-a",
        status: "completed",
        createdAt: "2026-07-17T00:00:00Z",
        nodesJson: JSON.stringify([{ data: { tokens: 100 } }]),
      },
      {
        id: "r2",
        workflowId: "wf-a",
        status: "completed",
        createdAt: "2026-07-17T00:01:00Z",
        nodesJson: JSON.stringify([{ data: { tokens: 50 } }]),
      },
      {
        id: "r3",
        workflowId: "wf-b",
        status: "failed",
        createdAt: "2026-07-17T00:02:00Z",
        nodesJson: JSON.stringify([{ data: { tokens: 25 } }]),
      },
    ];
    expect(summarizePortfolioRuns(runs)).toEqual([
      { workflowId: "wf-a", runCount: 2, tokenBurn: 150 },
      { workflowId: "wf-b", runCount: 1, tokenBurn: 25 },
    ]);
  });

  it("composes operator briefing and architect digest feedback", () => {
    const snap = aggregateDashboard(
      [
        {
          id: "r1",
          workflowId: "wf-a",
          status: "completed",
          createdAt: new Date().toISOString(),
          nodesJson: JSON.stringify([{ data: { tokens: 5000 } }]),
        },
      ],
      [
        {
          id: "f1",
          workflowId: "wf-a",
          kind: "revenue",
          source: "ad_revenue",
          amount: 10,
          currency: "USD",
          at: new Date().toISOString(),
          note: "ads",
        },
      ],
    );
    const composed = composeDashboardFeedback(snap, "wf-a");
    expect(composed.operatorMessage).toMatch(/Dashboard briefing/i);
    expect(composed.operatorMessage).toMatch(/Alpha Co|token/i);
    expect(composed.architectDigest).toMatch(/DASHBOARD_FEEDBACK/);
    expect(composed.architectDigest).toMatch(/wf-a/);
    expect(composed.architectDigest).toMatch(/tokens=5000/);

    const published = publishDashboardFeedback(snap, "wf-a");
    expect(published.id).toBeTruthy();
    expect(published.operatorMessage).toContain("Dashboard briefing");
  });
});
