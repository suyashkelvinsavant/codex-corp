import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  DollarSign,
  Flame,
  Plus,
  Sparkles,
  Trash2,
  Wallet,
} from "lucide-react";
import type { RunRecord } from "./model";
import { listWorkflows } from "./templates";
import {
  aggregateDashboard,
  composeDashboardFeedback,
  createFinanceEntryPersisted,
  deleteFinanceEntryPersisted,
  listDashboardFeedbackPersisted,
  listFinanceEntriesPersisted,
  publishDashboardFeedbackPersisted,
  type DashboardFeedback,
  type FinanceEntry,
  type FinanceKind,
  type FinanceSource,
  type PortfolioRunSummary,
} from "./dashboard-finance";

export type DashboardsPageProps = {
  runHistory: RunRecord[];
  portfolioRunSummaries?: PortfolioRunSummary[];
  onOpenArchitect?: (initialPrompt?: string) => void;
};

export function DashboardsPage({
  runHistory,
  portfolioRunSummaries,
  onOpenArchitect,
}: DashboardsPageProps) {
  const [revision, setRevision] = useState(0);
  const [finance, setFinance] = useState<FinanceEntry[]>([]);
  const [feedback, setFeedback] = useState<DashboardFeedback[]>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listFinanceEntriesPersisted(),
      listDashboardFeedbackPersisted(),
    ]).then(([nextFinance, nextFeedback]) => {
      if (!cancelled) {
        setFinance(nextFinance);
        setFeedback(nextFeedback);
        setBriefing(
          (current) => current || nextFeedback[0]?.operatorMessage || "",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  const snapshot = useMemo(
    () =>
      aggregateDashboard(runHistory, finance, undefined, portfolioRunSummaries),
    [runHistory, finance, portfolioRunSummaries],
  );
  const workflows = useMemo(
    () => listWorkflows({ includeDrafts: true }),
    [revision],
  );

  const [workflowId, setWorkflowId] = useState(
    () => workflows[0]?.id ?? runHistory[0]?.workflowId ?? "",
  );
  const [kind, setKind] = useState<FinanceKind>("revenue");
  const [source, setSource] = useState<FinanceSource>("manual");
  const [amount, setAmount] = useState("0");
  const [note, setNote] = useState("");
  const [briefing, setBriefing] = useState(
    () => feedback[0]?.operatorMessage ?? "",
  );

  const refresh = () => setRevision((n) => n + 1);

  const addEntry = async () => {
    const id = workflowId || workflows[0]?.id;
    if (!id) return;
    await createFinanceEntryPersisted({
      workflowId: id,
      kind,
      source,
      amount: Number(amount) || 0,
      note,
    });
    setAmount("0");
    setNote("");
    refresh();
  };

  const generateBriefing = async () => {
    const item = await publishDashboardFeedbackPersisted(
      snapshot,
      workflowId || undefined,
    );
    setBriefing(item.operatorMessage);
    refresh();
  };

  const sendToArchitect = async () => {
    const composed = composeDashboardFeedback(
      snapshot,
      workflowId || undefined,
    );
    await publishDashboardFeedbackPersisted(snapshot, workflowId || undefined);
    refresh();
    onOpenArchitect?.(
      `Use this DASHBOARD_FEEDBACK to improve company graphs (lower burn, protect profitable workflows):\n\n${composed.architectDigest}`,
    );
  };

  return (
    <section className="dashboards-panel" aria-label="Dashboards">
      <div className="overview-stats" aria-label="Portfolio metrics">
        <div>
          <small>Token burn</small>
          <b>{snapshot.totalTokenBurn.toLocaleString()}</b>
        </div>
        <div>
          <small>Est. token cost</small>
          <b>${snapshot.totalEstimatedCostUsd.toFixed(2)}</b>
        </div>
        <div>
          <small>Revenue</small>
          <b>${snapshot.totalRevenue.toFixed(2)}</b>
        </div>
        <div>
          <small>Expenses</small>
          <b>${snapshot.totalExpense.toFixed(2)}</b>
        </div>
        <div>
          <small>Net</small>
          <b className={snapshot.totalNet >= 0 ? "ok" : "bad"}>
            ${snapshot.totalNet.toFixed(2)}
          </b>
        </div>
      </div>

      <div className="dashboards-grid">
        <article className="dashboards-card">
          <header>
            <Flame size={16} />
            <div>
              <h3>Per-workflow burn & P&amp;L</h3>
              <p>
                Tokens from all persisted runs · cost is a rough $0.01/1K-token
                estimate and is not included in entered expenses
              </p>
            </div>
          </header>
          <div className="dashboards-table-wrap">
            <table className="dashboards-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Runs</th>
                  <th>Tokens</th>
                  <th>Est. cost</th>
                  <th>Rev</th>
                  <th>Exp</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.byWorkflow.length === 0 && (
                  <tr>
                    <td colSpan={7} className="workflow-empty">
                      No workflow activity yet. Create a company and run it in
                      the desktop app to accumulate token burn.
                    </td>
                  </tr>
                )}
                {snapshot.byWorkflow.map((row) => (
                  <tr key={row.workflowId}>
                    <td>
                      <b>{row.workflowName}</b>
                      <small>{row.workflowId}</small>
                    </td>
                    <td>{row.runCount}</td>
                    <td>{row.tokenBurn.toLocaleString()}</td>
                    <td>${row.estimatedCostUsd.toFixed(2)}</td>
                    <td>${row.revenue.toFixed(2)}</td>
                    <td>${row.expense.toFixed(2)}</td>
                    <td>${row.net.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="dashboards-card">
          <header>
            <Wallet size={16} />
            <div>
              <h3>Revenue &amp; expenses</h3>
              <p>
                Manual / local import only — Play Console, ads, subscriptions
                (no OAuth credentials stored)
              </p>
            </div>
          </header>
          <div className="dashboards-form">
            <label>
              Workflow
              <select
                value={workflowId}
                onChange={(e) => setWorkflowId(e.target.value)}
                aria-label="Finance workflow"
              >
                {!workflows.length && <option value="">No workflows</option>}
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kind
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as FinanceKind)}
                aria-label="Finance kind"
              >
                <option value="revenue">Revenue</option>
                <option value="expense">Expense</option>
              </select>
            </label>
            <label>
              Source
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as FinanceSource)}
                aria-label="Finance source"
              >
                <option value="manual">Manual</option>
                <option value="google_play">Google Play Console</option>
                <option value="ad_revenue">Ad revenue</option>
                <option value="subscription">Subscription</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Amount (USD)
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="Finance amount"
              />
            </label>
            <label className="dashboards-note">
              Note
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. March Play revenue"
                aria-label="Finance note"
              />
            </label>
            <button
              type="button"
              className="overview-create"
              onClick={() => void addEntry()}
              disabled={!workflowId && !workflows.length}
            >
              <Plus size={14} />
              Add entry
            </button>
          </div>
          <ul className="dashboards-finance-list">
            {finance.length === 0 && (
              <li className="workflow-empty">No finance entries yet.</li>
            )}
            {finance
              .slice()
              .reverse()
              .slice(0, 12)
              .map((entry) => (
                <li key={entry.id}>
                  <span className={`fin-kind ${entry.kind}`}>
                    {entry.kind === "revenue" ? (
                      <DollarSign size={12} />
                    ) : (
                      <BarChart3 size={12} />
                    )}
                    {entry.kind}
                  </span>
                  <div>
                    <b>
                      ${entry.amount.toFixed(2)} · {entry.source}
                    </b>
                    <small>
                      {entry.workflowId} · {new Date(entry.at).toLocaleString()}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="template-remove"
                    aria-label="Delete finance entry"
                    onClick={() => {
                      void deleteFinanceEntryPersisted(entry.id).then(refresh);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
          </ul>
        </article>

        <article className="dashboards-card dashboards-feedback">
          <header>
            <Sparkles size={16} />
            <div>
              <h3>Finance &amp; efficiency agent</h3>
              <p>
                Local briefing for you — and a digest for Byte to
                close the feedback loop
              </p>
            </div>
          </header>
          <div className="dashboards-feedback-actions">
            <button
              type="button"
              className="overview-create"
              onClick={() => void generateBriefing()}
            >
              <Sparkles size={14} />
              Generate briefing
            </button>
            <button
              type="button"
              className="workflow-edit"
              onClick={() => void sendToArchitect()}
              disabled={!onOpenArchitect}
            >
              Send insights to Byte
            </button>
          </div>
          <pre className="dashboards-briefing" aria-label="Dashboard briefing">
            {briefing ||
              "Generate a briefing to see token burn leaders, P&L, and recommendations."}
          </pre>
        </article>
      </div>
    </section>
  );
}
