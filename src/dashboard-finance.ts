/**
 * Local-only finance + usage dashboards for Codex Corp.
 * No remote credentials: manual revenue/expense entries + token burn from runs.
 */

import type { RunRecord } from "./model";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listWorkflows } from "./templates";
import { tokensFromRunRecord } from "./token-usage";
import { notifyPersistenceError } from "./persistence-events";

export { tokensFromRunRecord } from "./token-usage";

export const FINANCE_STORAGE_KEY = "codex-corp-finance-entries";
export const DASHBOARD_FEEDBACK_KEY = "codex-corp-dashboard-feedback";
let desktopMigration: Promise<void> | null = null;

export type FinanceKind = "revenue" | "expense";

export type FinanceSource =
  "manual" | "google_play" | "ad_revenue" | "subscription" | "other";

export type FinanceEntry = {
  id: string;
  workflowId: string;
  kind: FinanceKind;
  source: FinanceSource;
  amount: number;
  currency: string;
  at: string;
  note: string;
};

export type DashboardFeedback = {
  id: string;
  createdAt: string;
  /** Markdown for the human operator. */
  operatorMessage: string;
  /** Digest text for Workflow Architect context. */
  architectDigest: string;
  workflowId?: string;
};

/** Default rough $/1K tokens for local estimates (operator-overridable later). */
export const DEFAULT_COST_PER_1K_TOKENS_USD = 0.01;

function readJsonArray<T>(key: string): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? (raw as T[]) : [];
  } catch {
    return [];
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function listFinanceEntries(): FinanceEntry[] {
  return readJsonArray<FinanceEntry>(FINANCE_STORAGE_KEY).filter(
    (e) =>
      e &&
      typeof e.id === "string" &&
      typeof e.workflowId === "string" &&
      (e.kind === "revenue" || e.kind === "expense") &&
      typeof e.amount === "number" &&
      Number.isFinite(e.amount),
  );
}

export function saveFinanceEntry(entry: FinanceEntry): void {
  const items = listFinanceEntries().filter((e) => e.id !== entry.id);
  items.push(entry);
  writeJson(FINANCE_STORAGE_KEY, items);
}

export function deleteFinanceEntry(id: string): void {
  writeJson(
    FINANCE_STORAGE_KEY,
    listFinanceEntries().filter((e) => e.id !== id),
  );
}

export function createFinanceEntry(input: {
  workflowId: string;
  kind: FinanceKind;
  source?: FinanceSource;
  amount: number;
  currency?: string;
  note?: string;
  at?: string;
}): FinanceEntry {
  const entry = buildFinanceEntry(input);
  saveFinanceEntry(entry);
  return entry;
}

function buildFinanceEntry(input: {
  workflowId: string;
  kind: FinanceKind;
  source?: FinanceSource;
  amount: number;
  currency?: string;
  note?: string;
  at?: string;
}): FinanceEntry {
  return {
    id: `fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    workflowId: input.workflowId,
    kind: input.kind,
    source: input.source ?? "manual",
    amount: Number(input.amount) || 0,
    currency: input.currency?.trim() || "USD",
    at: input.at ?? new Date().toISOString(),
    note: input.note?.trim() || "",
  };
}

export async function listFinanceEntriesPersisted(): Promise<FinanceEntry[]> {
  if (!isTauri()) return listFinanceEntries();
  await migrateBrowserDashboardData();
  return invoke<FinanceEntry[]>("list_finance_entries");
}

export async function createFinanceEntryPersisted(
  input: Parameters<typeof buildFinanceEntry>[0],
): Promise<FinanceEntry> {
  const entry = buildFinanceEntry(input);
  if (isTauri()) await invoke("save_finance_entry", { entry });
  else saveFinanceEntry(entry);
  return entry;
}

export async function deleteFinanceEntryPersisted(id: string): Promise<void> {
  if (isTauri()) await invoke("delete_finance_entry", { id });
  else deleteFinanceEntry(id);
}

export function listDashboardFeedback(): DashboardFeedback[] {
  return readJsonArray<DashboardFeedback>(DASHBOARD_FEEDBACK_KEY);
}

export function saveDashboardFeedback(item: DashboardFeedback): void {
  const items = listDashboardFeedback().filter((f) => f.id !== item.id);
  items.unshift(item);
  writeJson(DASHBOARD_FEEDBACK_KEY, items.slice(0, 50));
}

export function estimateTokenCostUsd(
  tokens: number,
  costPer1k = DEFAULT_COST_PER_1K_TOKENS_USD,
): number {
  return (Math.max(0, tokens) / 1000) * costPer1k;
}

export type WorkflowDashboardRow = {
  workflowId: string;
  workflowName: string;
  tokenBurn: number;
  estimatedCostUsd: number;
  revenue: number;
  expense: number;
  net: number;
  runCount: number;
};

export type PortfolioRunSummary = {
  workflowId: string;
  runCount: number;
  tokenBurn: number;
};

export function summarizePortfolioRuns(
  runs: RunRecord[],
): PortfolioRunSummary[] {
  const summaries = new Map<string, PortfolioRunSummary>();
  for (const run of runs) {
    const summary = summaries.get(run.workflowId) ?? {
      workflowId: run.workflowId,
      runCount: 0,
      tokenBurn: 0,
    };
    summary.runCount += 1;
    summary.tokenBurn += tokensFromRunRecord(run);
    summaries.set(run.workflowId, summary);
  }
  return [...summaries.values()].sort(
    (left, right) =>
      right.tokenBurn - left.tokenBurn ||
      left.workflowId.localeCompare(right.workflowId),
  );
}

export type DashboardSnapshot = {
  totalTokenBurn: number;
  totalEstimatedCostUsd: number;
  totalRevenue: number;
  totalExpense: number;
  totalNet: number;
  byWorkflow: WorkflowDashboardRow[];
};

export function aggregateDashboard(
  runs: RunRecord[],
  finance: FinanceEntry[] = listFinanceEntries(),
  costPer1k = DEFAULT_COST_PER_1K_TOKENS_USD,
  portfolioSummaries?: PortfolioRunSummary[],
): DashboardSnapshot {
  const workflowIds = new Set<string>();
  for (const run of runs) workflowIds.add(run.workflowId);
  for (const summary of portfolioSummaries ?? [])
    workflowIds.add(summary.workflowId);
  for (const entry of finance) workflowIds.add(entry.workflowId);
  for (const w of listWorkflows({ includeDrafts: true })) workflowIds.add(w.id);

  const byWorkflow: WorkflowDashboardRow[] = [...workflowIds].map(
    (workflowId) => {
      const workflowRuns = runs.filter((r) => r.workflowId === workflowId);
      const portfolio = portfolioSummaries?.find(
        (summary) => summary.workflowId === workflowId,
      );
      const tokenBurn =
        portfolio?.tokenBurn ??
        workflowRuns.reduce(
          (sum, run) => sum + tokensFromRunRecord(run),
          0,
        );
      const entries = finance.filter((e) => e.workflowId === workflowId);
      const revenue = entries
        .filter((e) => e.kind === "revenue")
        .reduce((s, e) => s + e.amount, 0);
      const expense = entries
        .filter((e) => e.kind === "expense")
        .reduce((s, e) => s + e.amount, 0);
      const catalogItem = listWorkflows({ includeDrafts: true }).find(
        (workflow) => workflow.id === workflowId,
      );
      const name = catalogItem?.name || `Deleted workflow (${workflowId})`;
      return {
        workflowId,
        workflowName: name,
        tokenBurn,
        estimatedCostUsd: estimateTokenCostUsd(tokenBurn, costPer1k),
        revenue,
        expense,
        net: revenue - expense,
        runCount: portfolio?.runCount ?? workflowRuns.length,
      };
    },
  );

  byWorkflow.sort((a, b) => b.tokenBurn - a.tokenBurn || b.revenue - a.revenue);

  return {
    totalTokenBurn: byWorkflow.reduce((s, r) => s + r.tokenBurn, 0),
    totalEstimatedCostUsd: byWorkflow.reduce(
      (s, r) => s + r.estimatedCostUsd,
      0,
    ),
    totalRevenue: byWorkflow.reduce((s, r) => s + r.revenue, 0),
    totalExpense: byWorkflow.reduce((s, r) => s + r.expense, 0),
    totalNet: byWorkflow.reduce((s, r) => s + r.net, 0),
    byWorkflow,
  };
}

/**
 * Build a deterministic operator + Architect briefing from a dashboard snapshot.
 */
export function composeDashboardFeedback(
  snapshot: DashboardSnapshot,
  workflowId?: string,
): Omit<DashboardFeedback, "id" | "createdAt"> {
  const rows = workflowId
    ? snapshot.byWorkflow.filter((r) => r.workflowId === workflowId)
    : snapshot.byWorkflow;
  const focus =
    rows[0] ??
    ({
      workflowId: workflowId ?? "all",
      workflowName: "All workflows",
      tokenBurn: snapshot.totalTokenBurn,
      estimatedCostUsd: snapshot.totalEstimatedCostUsd,
      revenue: snapshot.totalRevenue,
      expense: snapshot.totalExpense,
      net: snapshot.totalNet,
      runCount: 0,
    } satisfies WorkflowDashboardRow);

  const burny = [...snapshot.byWorkflow]
    .filter((r) => r.tokenBurn > 0)
    .slice(0, 3)
    .map(
      (r) =>
        `- **${r.workflowName}**: ${r.tokenBurn.toLocaleString()} tok (~$${r.estimatedCostUsd.toFixed(2)})`,
    )
    .join("\n");

  const money = [...snapshot.byWorkflow]
    .filter((r) => r.revenue > 0 || r.expense > 0)
    .slice(0, 5)
    .map(
      (r) =>
        `- **${r.workflowName}**: rev $${r.revenue.toFixed(2)} · exp $${r.expense.toFixed(2)} · net $${r.net.toFixed(2)}`,
    )
    .join("\n");

  const operatorMessage = [
    `## Dashboard briefing`,
    ``,
    `Portfolio: **${snapshot.totalTokenBurn.toLocaleString()}** tokens burned · est. cost **$${snapshot.totalEstimatedCostUsd.toFixed(2)}** · net **$${snapshot.totalNet.toFixed(2)}** (rev $${snapshot.totalRevenue.toFixed(2)} − exp $${snapshot.totalExpense.toFixed(2)}).`,
    ``,
    focus.workflowId !== "all"
      ? `Focus **${focus.workflowName}**: ${focus.tokenBurn.toLocaleString()} tok, net $${focus.net.toFixed(2)} across ${focus.runCount} run(s).`
      : `Highest activity workflow: **${focus.workflowName}**.`,
    ``,
    burny
      ? `### Token burn leaders\n${burny}`
      : `### Token burn\nNo run token data yet — execute companies in the desktop app to accumulate burn.`,
    ``,
    money
      ? `### Revenue & expense\n${money}`
      : `### Revenue & expense\nNo finance entries yet. Add manual revenue/expense (Play Console, ads, etc.) on the Dashboards page.`,
    ``,
    `### Recommendations`,
    snapshot.totalExpense > snapshot.totalRevenue && snapshot.totalExpense > 0
      ? `- Expenses exceed revenue — tighten high-burn specialists or raise monetization tracking.`
      : `- Keep mapping revenue sources to workflows so Byte can prioritize profitable graphs.`,
    snapshot.totalTokenBurn > 0
      ? `- Review high-token specialists for shorter prompts, lower effort, or fewer revision loops.`
      : `- After the first Live Codex runs, re-run this briefing for cost signals.`,
  ].join("\n");

  const architectDigest = [
    `DASHBOARD_FEEDBACK`,
    `totalTokens=${snapshot.totalTokenBurn}`,
    `estCostUsd=${snapshot.totalEstimatedCostUsd.toFixed(4)}`,
    `revenueUsd=${snapshot.totalRevenue.toFixed(2)}`,
    `expenseUsd=${snapshot.totalExpense.toFixed(2)}`,
    `netUsd=${snapshot.totalNet.toFixed(2)}`,
    ...snapshot.byWorkflow
      .slice(0, 12)
      .map(
        (r) =>
          `workflow id=${r.workflowId} name=${JSON.stringify(r.workflowName)} tokens=${r.tokenBurn} cost=${r.estimatedCostUsd.toFixed(4)} rev=${r.revenue} exp=${r.expense} net=${r.net} runs=${r.runCount}`,
      ),
    `guidance=Prefer lower token specialists on high-burn low-net workflows; strengthen monetization instrumentation on profitable graphs; keep least-privilege tools.`,
  ].join("\n");

  return {
    operatorMessage,
    architectDigest,
    workflowId: workflowId,
  };
}

export function publishDashboardFeedback(
  snapshot: DashboardSnapshot,
  workflowId?: string,
): DashboardFeedback {
  const composed = composeDashboardFeedback(snapshot, workflowId);
  const item: DashboardFeedback = {
    id: `fb-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    ...composed,
  };
  saveDashboardFeedback(item);
  return item;
}

export async function listDashboardFeedbackPersisted(): Promise<
  DashboardFeedback[]
> {
  if (!isTauri()) return listDashboardFeedback();
  await migrateBrowserDashboardData();
  return invoke<DashboardFeedback[]>("list_dashboard_feedback");
}

async function migrateBrowserDashboardData(): Promise<void> {
  if (!isTauri()) return;
  if (desktopMigration) return desktopMigration;
  desktopMigration = (async () => {
    const [nativeFinance, nativeFeedback] = await Promise.all([
      invoke<FinanceEntry[]>("list_finance_entries"),
      invoke<DashboardFeedback[]>("list_dashboard_feedback"),
    ]);
    const financeIds = new Set(nativeFinance.map((entry) => entry.id));
    const feedbackIds = new Set(nativeFeedback.map((item) => item.id));
    const financeImports = listFinanceEntries().filter(
      (entry) => !financeIds.has(entry.id),
    );
    const feedbackImports = listDashboardFeedback().filter(
      (item) =>
        !feedbackIds.has(item.id) &&
        item.id?.trim() &&
        item.createdAt?.trim() &&
        item.operatorMessage?.trim() &&
        item.architectDigest?.trim(),
    );
    await Promise.all([
      ...financeImports.map((entry) => invoke("save_finance_entry", { entry })),
      ...feedbackImports.map((item) =>
        invoke("save_dashboard_feedback", { item }),
      ),
    ]);
    localStorage.removeItem(FINANCE_STORAGE_KEY);
    localStorage.removeItem(DASHBOARD_FEEDBACK_KEY);
  })().catch((error) => {
    desktopMigration = null;
    notifyPersistenceError("dashboard data migration", error);
    throw error;
  });
  return desktopMigration;
}

export async function publishDashboardFeedbackPersisted(
  snapshot: DashboardSnapshot,
  workflowId?: string,
): Promise<DashboardFeedback> {
  const composed = composeDashboardFeedback(snapshot, workflowId);
  const item: DashboardFeedback = {
    id: `fb-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    ...composed,
  };
  if (isTauri()) await invoke("save_dashboard_feedback", { item });
  else saveDashboardFeedback(item);
  return item;
}

/** Latest architect digest for injection into Workflow Architect context. */
export function latestArchitectDashboardDigest(): string | null {
  const items = listDashboardFeedback();
  return items[0]?.architectDigest ?? null;
}

export async function latestArchitectDashboardDigestPersisted(): Promise<
  string | null
> {
  const items = await listDashboardFeedbackPersisted();
  return items[0]?.architectDigest ?? null;
}
