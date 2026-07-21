import { lazy, Suspense, useEffect, useState } from "react";
import type React from "react";
import { isTauri as tauriIsTauri, invoke } from "@tauri-apps/api/core";
import {
  Braces,
  Check,
  Clock3,
  Code2,
  Copy,
  FileOutput,
  GitBranch,
  Hand,
  Image,
  Inbox,
  List,
  Merge,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  Brain,
  ListTodo,
  Monitor,
  Diff,
  FileWarning,
} from "lucide-react";
import {
  defaultNodeEffortForModel,
  defaultNodeModelFromList,
  effortsForModel,
  normalizeStoredModelId,
  type CodexModelOption,
} from "./codex-models";
import {
  permissionGrantLabel,
  STANDARD_TOOL_LABELS,
  toolsUiHelperText,
} from "./tool-boundary";
import {
  composeCreativeSystemPrompt,
  resolveActiveSkill,
} from "./creative-skills";
import {
  EMPTY_CODEX_CAPABILITIES,
  capabilityRelevanceScore,
  type CodexCapabilityInventory,
  type CodexSkillOption,
  type CodexToolOption,
} from "./codex-capabilities";
import { PromptEditor } from "./prompt-editor";
import { isStreamingTraceEvent, traceEventLabel } from "./stream-display";
import {
  COMMAND_TEMPLATE_IDS,
  ensureCompletionCriteria,
  evaluateCompletionCriteria,
  makeCustomCriterion,
  OPERATOR_VERIFIER_KINDS,
  verificationResultsFromOutput,
  type CompletionCriterion,
  type CriterionEvaluation,
  type CriterionKind,
  type OperatorVerifierKind,
} from "./completion-criteria";
import {
  composeAuthorizedMission,
  constraintsFromTextarea,
  constraintsToTextarea,
} from "./mission-context";
import { defaultOutputSchemaJson as defaultOutputSchema } from "./agent-output-schema";
import { defaultInputSchema } from "./editor-defaults";
import type {
  AgentData,
  Artifact,
  FlowEdge,
  FlowNode,
  Kind,
  RunEvent,
} from "./model";
import { Metric } from "./metric";
import { CONTROL_KINDS, controlKindLabel, statusText } from "./node-display";
import { composeSpecialistInputPreview } from "./specialist-input";

const ConnectorRuntimePanel = lazy(() =>
  import("./connector-runtime-panel").then((module) => ({
    default: module.ConnectorRuntimePanel,
  })),
);

const NOTE_BODY_MAX = 400;
const NOTE_TITLE_MAX = 80;

function isTauri(): boolean {
  if (tauriIsTauri()) return true;
  const global = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return !!(global.isTauri || global.__TAURI_INTERNALS__ || global.__TAURI__);
}

export function NodeInspector({
  node,
  tab,
  setTab,
  update,
  availableModels = [],
  modelsStatus = "unavailable",
  modelsError = "",
  capabilities = EMPTY_CODEX_CAPABILITIES,
  capabilitiesStatus = "unavailable",
  capabilitiesError = "",
  onRefreshModels,
  upstream,
  upstreamNodes,
  revisionNodes,
  inboundEdges,
  workflowInput,
  events,
  downstream,
  run,
  duplicate,
  save,
  interrupt,
}: {
  node: FlowNode;
  tab: string;
  setTab: (s: string) => void;
  update: (p: Partial<AgentData>) => void;
  availableModels?: CodexModelOption[];
  modelsStatus?: "idle" | "loading" | "live" | "unavailable";
  modelsError?: string;
  capabilities?: CodexCapabilityInventory;
  capabilitiesStatus?: "loading" | "live" | "unavailable";
  capabilitiesError?: string;
  onRefreshModels?: () => void;
  upstream: number;
  upstreamNodes: FlowNode[];
  revisionNodes: FlowNode[];
  inboundEdges: FlowEdge[];
  workflowInput: string;
  events: RunEvent[];
  downstream: number;
  run: () => void;
  duplicate: () => void;
  save: () => void;
  interrupt: () => void;
}) {
  const d = node.data;
  const nodeEvents = [
    ...events.filter((event) => event.nodeId === node.id),
    ...d.trace.flatMap((entry, index): RunEvent[] =>
      typeof entry === "string"
        ? []
        : [
            {
              id: `trace-${entry.at}-${index}`,
              at: new Date(entry.at).toISOString(),
              type: entry.eventType,
              message: entry.text,
              nodeId: node.id,
              threadId: entry.threadId,
              turnId: entry.turnId,
              level: "info",
            },
          ],
    ),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const modelId = normalizeStoredModelId(d.model);
  const effortOptions = effortsForModel(availableModels, modelId);
  const [threads, setThreads] = useState<
    Array<{
      id: string;
      name: string | null;
      preview: string | null;
      status: string | null;
      createdAt: number;
      updatedAt: number;
      cwd: string | null;
    }>
  >([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "threads" || threadsLoaded) return;
    invoke<
      Array<{
        id: string;
        name: string | null;
        preview: string | null;
        status: string | null;
        createdAt: number;
        updatedAt: number;
        cwd: string | null;
      }>
    >("list_codex_threads", { limit: 30 })
      .then((data) => {
        setThreads([
          ...data.filter((thread) => thread.id === d.threadId),
          ...data.filter((thread) => thread.id !== d.threadId),
        ]);
        setThreadsError(null);
        setThreadsLoaded(true);
      })
      .catch((failure) => {
        setThreadsError(
          failure instanceof Error ? failure.message : String(failure),
        );
        setThreadsLoaded(true);
      });
  }, [tab, threadsLoaded, d.threadId]);

  if (d.kind === "creative") {
    return (
      <CreativeNodeInspector
        node={node}
        tab={tab}
        setTab={setTab}
        update={update}
        availableModels={availableModels}
        modelsStatus={modelsStatus}
        modelsError={modelsError}
        capabilities={capabilities}
        capabilitiesStatus={capabilitiesStatus}
        capabilitiesError={capabilitiesError}
        onRefreshModels={onRefreshModels}
        upstream={upstream}
        upstreamNodes={upstreamNodes}
        revisionNodes={revisionNodes}
        inboundEdges={inboundEdges}
        workflowInput={workflowInput}
        events={events}
        downstream={downstream}
        run={run}
        duplicate={duplicate}
        save={save}
        interrupt={interrupt}
      />
    );
  }

  // Notes are canvas documentation only — never show agent runtime controls.
  if (d.kind === "note") {
    return (
      <>
        <div className="inspector-header note-inspector-header">
          <div>
            <span>CANVAS NOTE · NOT EXECUTED</span>
            <h2>{d.label}</h2>
            <p>Sticky annotation for the company graph</p>
          </div>
          <span className="big-status draft">Note</span>
        </div>
        <div className="inspector-content note-inspector-content">
          <div className="note-banner">
            <Braces size={16} />
            <div>
              <b>Documentation only</b>
              <small>
                Notes cannot be wired, scheduled, or run. Agents never receive
                this text as context.
              </small>
            </div>
          </div>
          <Section title="Note">
            <label>
              Title
              <input
                value={d.label}
                maxLength={NOTE_TITLE_MAX}
                onChange={(e) =>
                  update({ label: e.target.value.slice(0, NOTE_TITLE_MAX) })
                }
                placeholder="e.g. Demo beat · revision loop"
              />
              <small className="field-counter">
                {d.label.length}/{NOTE_TITLE_MAX}
              </small>
            </label>
            <PromptEditor
              label="Body"
              value={d.prompt}
              maxLength={NOTE_BODY_MAX}
              onChange={(next) =>
                update({ prompt: next.slice(0, NOTE_BODY_MAX) })
              }
              placeholder="Explain this part of the graph for your team…"
              helper={
                <small className="field-counter">
                  Card grows with this text · markdown supported
                </small>
              }
              rows={8}
            />
            <label>
              Caption
              <input
                value={d.description}
                maxLength={120}
                onChange={(e) =>
                  update({ description: e.target.value.slice(0, 120) })
                }
                placeholder="Optional short caption under the title"
              />
            </label>
          </Section>
          <Section title="About this note">
            <Metric label="Executable" value="No" />
            <Metric label="Connections" value="None (no ports)" />
            <Metric label="Included in runs" value="Never" />
            <Metric label="Visible to agents" value="No" />
          </Section>
        </div>
        <div className="inspector-actions">
          <button
            onClick={save}
            aria-label="Save note changes"
            title="Save changes"
          >
            <Save size={14} />
            Save
          </button>
          <button onClick={duplicate} aria-label="Duplicate selected note">
            <Copy size={14} />
            Duplicate
          </button>
        </div>
      </>
    );
  }

  if (CONTROL_KINDS.has(d.kind)) {
    return (
      <ControlNodeInspector
        node={node}
        update={update}
        upstream={upstream}
        upstreamNodes={upstreamNodes}
        downstream={downstream}
        run={run}
        duplicate={duplicate}
        save={save}
        interrupt={interrupt}
      />
    );
  }

  const tabs = [
    "overview",
    "instructions",
    "context",
    "io",
    "skills",
    "tools",
    "trace",
    "config",
    "threads",
  ];
  const resetConfiguration = () =>
    update({
      model: defaultNodeModelFromList(availableModels),
      effort: defaultNodeEffortForModel(
        availableModels,
        defaultNodeModelFromList(availableModels),
      ),
      timeoutSeconds: 120,
      maxRetries: 2,
      workspacePolicy: "isolated",
      sandboxProfile: "workspace-write",
      approvalPolicy: "on-request",
      requiresApproval: false,
      inputSchema: defaultInputSchema,
      outputSchema: defaultOutputSchema,
    });
  const exportOutput = () => {
    const payload = JSON.stringify(
      {
        nodeId: node.id,
        status: d.status,
        summary: d.output ?? null,
        data: d.structuredOutput ?? {},
        artifacts: d.artifacts ?? [],
        threadId: d.threadId ?? null,
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${node.id}-output.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="inspector-header">
        <div>
          <span>SELECTED NODE · AGENT</span>
          <h2>{d.label}</h2>
          <p>{d.role}</p>
        </div>
        <span className={`big-status ${d.status}`}>{statusText[d.status]}</span>
      </div>
      <nav className="inspector-tabs" aria-label="Agent inspector">
        {tabs.map((t) => {
          const label = t === "io" ? "I/O" : t;
          return (
            <button
              key={t}
              type="button"
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
              title={label}
            >
              {label}
            </button>
          );
        })}
      </nav>
      <div className="inspector-content">
        {tab === "overview" && (
          <>
            <Section title="Identity">
              <label>
                Name
                <input
                  value={d.label}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
              <label>
                Role
                <input
                  value={d.role}
                  onChange={(e) => update({ role: e.target.value })}
                />
              </label>
              <label>
                Description
                <textarea
                  value={d.description}
                  onChange={(e) => update({ description: e.target.value })}
                />
              </label>
            </Section>
            <Section title="Graph contract">
              <Metric label="Upstream inputs" value={String(upstream)} />
              <Metric label="Downstream consumers" value={String(downstream)} />
              <Metric label="Fresh thread" value="Required" />
              <Metric
                label="Thread ID"
                value={d.threadId?.slice(0, 16) ?? "Not started"}
              />
              <Metric
                label="Retry count"
                value={`${d.retries ?? 0} / ${d.maxRetries ?? 2}`}
              />
              <Metric label="Revision count" value={String(d.revisions || 0)} />
            </Section>
          </>
        )}
        {tab === "instructions" && (
          <>
            <Section title="Instruction surfaces">
              <PromptEditor
                label="Base instructions (harness)"
                value={d.baseInstructions ?? ""}
                onChange={(next) =>
                  update({
                    baseInstructions: next,
                  })
                }
                placeholder="Authored harness-like base. Leave empty to opt into native Codex base."
                helper={
                  d.packId
                    ? `Pack ${d.packId}@${d.packVersion ?? "?"} · empty base = native Codex base`
                    : "Empty base = opt-in native Codex base (brand may return)"
                }
                rows={8}
              />
              <PromptEditor
                label="Developer instructions (role contract)"
                value={d.developerInstructions ?? d.prompt ?? ""}
                onChange={(next) =>
                  update({
                    developerInstructions: next,
                    prompt: next,
                  })
                }
                placeholder="Role, objectives, MUST / MUST NOT, output contract…"
                helper="Markdown supported · Expand for a wide editor"
                rows={12}
              />
            </Section>
            <CompletionCriteriaEditor
              criteria={d.completionCriteria}
              evaluation={resolveCriteriaEvaluation(d)}
              onChange={(completionCriteria) => update({ completionCriteria })}
              hardCriteriaGate={d.hardCriteriaGate}
              onGateChange={(hardCriteriaGate) => update({ hardCriteriaGate })}
            />
          </>
        )}
        {tab === "context" && (
          <>
            <Section title="Context Aperture">
              <p className="helper">
                This manifest is the exact authorized context for the fresh
                thread.
              </p>
              <div className="context-row included">
                <Check size={13} />
                Workflow mission <em>included</em>
              </div>
              {upstreamNodes.map((source) => (
                <div className="context-row included" key={source.id}>
                  <Check size={13} />
                  <span>
                    <b>{source.data.label}</b>
                    <small>{source.data.output ?? "Output pending"}</small>
                  </span>
                  <em>included</em>
                </div>
              ))}
              {revisionNodes.map((source) => (
                <div className="context-row revision" key={source.id}>
                  <RotateCcw size={13} />
                  <span>
                    <b>{source.data.label} feedback</b>
                    <small>
                      {source.data.output ?? "No revision feedback yet"}
                    </small>
                  </span>
                  <em>authorized retry only</em>
                </div>
              ))}
              <div className="context-row excluded">
                <X size={13} />
                Unconnected node output <em>excluded</em>
              </div>
              <div className="context-row excluded">
                <X size={13} />
                Other agent conversations <em>excluded</em>
              </div>
            </Section>
            <Section title="Composed context">
              <pre>
                {JSON.stringify(
                  composeSpecialistInputPreview(
                    workflowInput,
                    node.id,
                    upstreamNodes,
                    inboundEdges,
                  ),
                  null,
                  2,
                )}
              </pre>
            </Section>
          </>
        )}
        {tab === "io" && (
          <>
            <Section title="Input contract">
              <label>
                JSON Schema
                <textarea
                  className="tall schema-editor"
                  value={d.inputSchema ?? defaultInputSchema}
                  onChange={(event) =>
                    update({ inputSchema: event.target.value })
                  }
                />
              </label>
            </Section>
            <Section title="Structured output">
              <div className="output-card">
                <span>
                  {d.status === "needs_revision"
                    ? "needs_revision"
                    : d.status === "failed"
                      ? "failure"
                      : "success"}
                </span>
                <p>{d.output || "No validated output for this run."}</p>
              </div>
              <pre>
                {JSON.stringify(
                  d.structuredOutput ?? {
                    status: "pending",
                    summary: null,
                    data: {},
                    artifacts: [],
                  },
                  null,
                  2,
                )}
              </pre>
            </Section>
            <Section title="Output contract">
              <label>
                JSON Schema
                <textarea
                  className="tall schema-editor"
                  value={d.outputSchema ?? defaultOutputSchema}
                  onChange={(event) =>
                    update({ outputSchema: event.target.value })
                  }
                />
              </label>
            </Section>
            <Section title="Artifacts">
              <ArtifactList artifacts={d.artifacts} />
            </Section>
          </>
        )}
        {tab === "skills" && (
          <ConnectorSkillPicker
            context={`${d.role} ${d.description} ${d.prompt}`}
            skills={capabilities.skills}
            selected={d.skills ?? []}
            primary={d.activeSkill}
            status={capabilitiesStatus}
            error={capabilitiesError}
            onChange={(skills, activeSkill) => update({ skills, activeSkill })}
          />
        )}
        {tab === "tools" && (
          <>
            <ConnectorToolPicker
              context={`${d.role} ${d.description} ${d.prompt}`}
              tools={capabilities.tools}
              selected={d.connectorTools ?? []}
              status={capabilitiesStatus}
              error={capabilitiesError}
              onChange={(connectorTools) => update({ connectorTools })}
            />
            <Section title="Permission boundary">
              {STANDARD_TOOL_LABELS.map((tool) => {
                const granted = d.tools.some(
                  (item) => item.toLowerCase() === tool.toLowerCase(),
                );
                const grantLabel = permissionGrantLabel(tool, granted);
                return (
                  <button
                    className="permission"
                    key={tool}
                    onClick={() =>
                      update({
                        tools: granted
                          ? d.tools.filter(
                              (item) =>
                                item.toLowerCase() !== tool.toLowerCase(),
                            )
                          : [...d.tools, tool],
                      })
                    }
                  >
                    <Wrench size={13} />
                    <span>{tool}</span>
                    <b
                      className={grantLabel === "denied" ? "denied" : "granted"}
                    >
                      {grantLabel}
                    </b>
                  </button>
                );
              })}
              <p className="helper" data-testid="tools-boundary-helper">
                {toolsUiHelperText()}
              </p>
            </Section>
            <Section title="Runtime scope">
              <Metric
                label="Allowed workspace"
                value={
                  d.workspacePolicy === "workflow"
                    ? "Workflow workspace"
                    : "Unique node workspace"
                }
              />
              <Metric
                label="Approval policy"
                value={d.approvalPolicy ?? "On request"}
              />
              <Metric
                label="Tool enforcement"
                value="Advisory prompt + app-server sandbox/approvals"
              />
            </Section>
            <Section title="Tool-call history">
              {nodeEvents.filter((item) =>
                /tool|shell|command|file/i.test(`${item.type} ${item.message}`),
              ).length ? (
                nodeEvents
                  .filter((item) =>
                    /tool|shell|command|file/i.test(
                      `${item.type} ${item.message}`,
                    ),
                  )
                  .map((item) => (
                    <div className="artifact-row" key={item.id}>
                      <Terminal size={13} />
                      {item.message}
                      <small>
                        {item.itemType ?? item.type} ·{" "}
                        {item.status ?? item.level ?? "recorded"}
                      </small>
                    </div>
                  ))
              ) : (
                <p className="helper">No tool calls recorded for this node.</p>
              )}
            </Section>
          </>
        )}
        {tab === "trace" && (
          <Section title="Execution trace">
            <div className="trace">
              {nodeEvents.map((event, i) => {
                const label = traceEventLabel(event.type);
                const isStreaming = isStreamingTraceEvent(event.type);
                const icon = isStreaming ? (
                  label === "Reasoning" ? (
                    <Brain size={12} />
                  ) : label === "Plan" ? (
                    <ListTodo size={12} />
                  ) : label === "Console" ? (
                    <Monitor size={12} />
                  ) : label === "Diff" ? (
                    <Diff size={12} />
                  ) : label === "File changes" ? (
                    <FileOutput size={12} />
                  ) : label === "Warning" ? (
                    <FileWarning size={12} />
                  ) : (
                    <Code2 size={12} />
                  )
                ) : null;
                return (
                  <div
                    key={event.id}
                    className={
                      isStreaming
                        ? `trace-streaming trace-${label.toLowerCase().replace(/\s+/g, "-")}`
                        : ""
                    }
                  >
                    <span
                      className={i === nodeEvents.length - 1 ? "active" : ""}
                    />
                    <div>
                      {isStreaming && (
                        <span className="trace-streaming-icon">{icon}</span>
                      )}
                      <b>{isStreaming ? label : event.message}</b>
                      {isStreaming && (
                        <span className="trace-streaming-detail">
                          {event.message.slice(0, 200)}
                          {event.message.length > 200 ? "…" : ""}
                        </span>
                      )}
                      <small>
                        {new Date(event.at).toLocaleTimeString()} ·{" "}
                        {event.elapsedMs !== undefined
                          ? `${event.elapsedMs}ms · `
                          : ""}
                        {event.status ??
                          event.level ??
                          event.type.replace(/^\[.*?\]\s*/, "")}
                      </small>
                    </div>
                  </div>
                );
              })}
              {!nodeEvents.length && (
                <p className="helper">
                  No runtime events recorded for this node.
                </p>
              )}
            </div>
          </Section>
        )}
        {tab === "config" && (
          <>
            <Section title="Model configuration">
              <p className="helper">
                {modelsStatus === "live"
                  ? `Live from Codex CLI · ${availableModels.length} model${availableModels.length === 1 ? "" : "s"} (model/list).`
                  : modelsStatus === "loading"
                    ? "Loading models from Codex CLI…"
                    : modelsError
                      ? `Unavailable — ${modelsError}`
                      : "Unavailable — connect Codex CLI to load models."}
                {onRefreshModels && isTauri() && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="linkish"
                      onClick={onRefreshModels}
                    >
                      Refresh models
                    </button>
                  </>
                )}
              </p>
              <label>
                Model
                <select
                  value={modelId}
                  onChange={(e) => {
                    const next = e.target.value;
                    const efforts = effortsForModel(availableModels, next);
                    const nextEffort = efforts.includes(d.effort)
                      ? d.effort
                      : ((efforts[0] as AgentData["effort"]) ?? "low");
                    update({ model: next, effort: nextEffort });
                  }}
                  disabled={
                    modelsStatus === "loading" || availableModels.length === 0
                  }
                >
                  {availableModels.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    <>
                      {!modelId ||
                      !availableModels.some(
                        (m) => m.id === modelId || m.model === modelId,
                      ) ? (
                        <option value={modelId || ""} disabled>
                          {modelId
                            ? `${modelId} (not in live list)`
                            : "Select a model…"}
                        </option>
                      ) : null}
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id} title={m.description}>
                          {m.displayName || m.model || m.id}
                          {m.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </label>
              <label>
                Reasoning effort
                <select
                  value={
                    effortOptions.includes(d.effort)
                      ? d.effort
                      : effortOptions[0]
                  }
                  onChange={(e) =>
                    update({ effort: e.target.value as AgentData["effort"] })
                  }
                >
                  {effortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            </Section>
            <Suspense
              fallback={
                <p className="helper">Loading Codex runtime settings…</p>
              }
            >
              <ConnectorRuntimePanel
                data={d}
                inventory={capabilities}
                status={capabilitiesStatus}
                error={capabilitiesError}
                update={update}
              />
            </Suspense>
            <Section title="Execution policy">
              <label>
                Sandbox profile
                <select
                  value={d.sandboxProfile ?? "workspace-write"}
                  disabled={Boolean(d.permissionProfile)}
                  onChange={(e) =>
                    update({
                      sandboxProfile: e.target
                        .value as AgentData["sandboxProfile"],
                    })
                  }
                >
                  <option value="workspace-write">Workspace write</option>
                  <option value="read-only">Read only</option>
                </select>
              </label>
              <label>
                Approval policy
                <select
                  value={d.approvalPolicy ?? "on-request"}
                  onChange={(e) =>
                    update({
                      approvalPolicy: e.target
                        .value as AgentData["approvalPolicy"],
                    })
                  }
                >
                  <option value="on-request">On request</option>
                  <option value="untrusted">Untrusted actions</option>
                  <option value="never">Never ask (use sandbox)</option>
                </select>
              </label>
              <label>
                Working directory (sandbox remains authoritative)
                <select
                  value={d.workspacePolicy ?? "isolated"}
                  onChange={(e) =>
                    update({
                      workspacePolicy: e.target
                        .value as AgentData["workspacePolicy"],
                    })
                  }
                >
                  <option value="isolated">
                    Isolated node attempt directory
                  </option>
                  <option value="workflow">
                    Run-selected workflow directory
                  </option>
                </select>
                {(d.workspacePolicy ?? "isolated") === "isolated" && (
                  <small>
                    Uses an app-managed node/attempt directory. The run-selected
                    workspace remains available only as an authorized runtime
                    root; it does not become this node's working directory.
                  </small>
                )}
              </label>
              <label>
                Timeout (seconds)
                <input
                  type="number"
                  min="10"
                  max="1800"
                  value={d.timeoutSeconds ?? 120}
                  onChange={(e) =>
                    update({ timeoutSeconds: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Maximum retries
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={d.maxRetries ?? 2}
                  onChange={(e) =>
                    update({ maxRetries: Number(e.target.value) })
                  }
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={!!d.requiresApproval}
                  onChange={(e) =>
                    update({ requiresApproval: e.target.checked })
                  }
                />
                Require durable operator approval after successful verification
              </label>
            </Section>
          </>
        )}
        {tab === "threads" && (
          <div className="thread-browser">
            {!threadsLoaded ? (
              <p className="helper">Loading Codex threads…</p>
            ) : threadsError ? (
              <p className="helper warning-text">
                Thread history unavailable — {threadsError}{" "}
                <button type="button" onClick={() => setThreadsLoaded(false)}>
                  Retry
                </button>
              </p>
            ) : threads.length === 0 ? (
              <p className="helper">No threads found.</p>
            ) : (
              threads.map((thread, index) => (
                <div key={thread.id} className="thread-entry">
                  {thread.id === d.threadId ? (
                    <small>SELECTED NODE THREAD</small>
                  ) : index ===
                    (d.threadId && threads[0]?.id === d.threadId ? 1 : 0) ? (
                    <small>GLOBAL RECENT CODEX THREADS</small>
                  ) : null}
                  <div className="thread-header">
                    <span className="thread-name">
                      {thread.name ?? thread.id.slice(0, 8)}
                    </span>
                    {thread.status && (
                      <span
                        className={`thread-status thread-status-${thread.status}`}
                      >
                        {thread.status}
                      </span>
                    )}
                  </div>
                  {thread.preview && (
                    <div className="thread-preview">{thread.preview}</div>
                  )}
                  <div className="thread-meta">
                    <>
                      Updated {new Date(thread.updatedAt).toLocaleDateString()}
                    </>
                    {thread.cwd && <> · {thread.cwd.split("/").pop()}</>}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="inspector-actions">
        <button
          onClick={save}
          aria-label="Save node changes"
          title="Save changes"
        >
          <Save size={14} />
          Save
        </button>
        <button onClick={duplicate} aria-label="Duplicate selected node">
          <Copy size={14} />
          Duplicate
        </button>
        <button
          onClick={resetConfiguration}
          aria-label="Reset node configuration"
        >
          <RotateCcw size={14} />
          Reset
        </button>
        {(d.status === "failed" || d.status === "interrupted") && (
          <button onClick={run} aria-label="Retry selected node">
            <Redo2 size={14} />
            Retry
          </button>
        )}
        {(d.status === "running" || d.status === "approval") && (
          <button onClick={interrupt} aria-label="Interrupt selected node">
            <Square size={13} />
            Interrupt
          </button>
        )}
        {(d.output || d.structuredOutput || d.artifacts?.length) && (
          <button
            onClick={exportOutput}
            aria-label="Export selected node output"
          >
            <FileOutput size={14} />
            Export
          </button>
        )}
        <button className="primary" onClick={run}>
          <Play size={14} />
          Run from node
        </button>
      </div>
    </>
  );
}

function CreativeNodeInspector({
  node,
  tab,
  setTab,
  update,
  availableModels = [],
  modelsStatus = "unavailable",
  modelsError = "",
  capabilities = EMPTY_CODEX_CAPABILITIES,
  capabilitiesStatus = "unavailable",
  capabilitiesError = "",
  onRefreshModels,
  upstream,
  upstreamNodes,
  revisionNodes,
  inboundEdges,
  workflowInput,
  events,
  downstream,
  run,
  duplicate,
  save,
  interrupt,
}: {
  node: FlowNode;
  tab: string;
  setTab: (s: string) => void;
  update: (p: Partial<AgentData>) => void;
  availableModels?: CodexModelOption[];
  modelsStatus?: "idle" | "loading" | "live" | "unavailable";
  modelsError?: string;
  capabilities?: CodexCapabilityInventory;
  capabilitiesStatus?: "loading" | "live" | "unavailable";
  capabilitiesError?: string;
  onRefreshModels?: () => void;
  upstream: number;
  upstreamNodes: FlowNode[];
  revisionNodes: FlowNode[];
  inboundEdges: FlowEdge[];
  workflowInput: string;
  events: RunEvent[];
  downstream: number;
  run: () => void;
  duplicate: () => void;
  save: () => void;
  interrupt: () => void;
}) {
  const d = node.data;
  const nodeEvents = events.filter((event) => event.nodeId === node.id);
  const modelId = normalizeStoredModelId(d.model);
  const effortOptions = effortsForModel(availableModels, modelId);
  const primary = resolveActiveSkill(d.skills, d.activeSkill);
  // Align with agent tabs; map legacy "tools" selection → skills.
  const creativeTabs = [
    "overview",
    "skills",
    "tools",
    "instructions",
    "context",
    "io",
    "trace",
    "config",
  ] as const;
  const activeTab = creativeTabs.includes(tab as (typeof creativeTabs)[number])
    ? tab
    : "overview";
  const resetConfiguration = () =>
    update({
      model: defaultNodeModelFromList(availableModels),
      effort: defaultNodeEffortForModel(
        availableModels,
        defaultNodeModelFromList(availableModels),
      ),
      timeoutSeconds: 120,
      maxRetries: 2,
      workspacePolicy: "isolated",
      sandboxProfile: "workspace-write",
      approvalPolicy: "on-request",
      requiresApproval: false,
      inputSchema: defaultInputSchema,
      outputSchema: defaultOutputSchema,
    });

  const exportOutput = () => {
    const payload = JSON.stringify(
      {
        nodeId: node.id,
        status: d.status,
        summary: d.output ?? null,
        data: d.structuredOutput ?? {},
        artifacts: d.artifacts ?? [],
        threadId: d.threadId ?? null,
        skills: d.skills ?? [],
        activeSkill: d.activeSkill ?? null,
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${node.id}-creative-output.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="inspector-header creative-inspector-header">
        <div>
          <span>SELECTED NODE · CREATIVE STUDIO</span>
          <h2>{d.label}</h2>
          <p>{d.role}</p>
        </div>
        <span className={`big-status ${d.status}`}>{statusText[d.status]}</span>
      </div>
      <nav className="inspector-tabs" aria-label="Creative studio inspector">
        {creativeTabs.map((t) => {
          const label = t === "io" ? "I/O" : t;
          return (
            <button
              key={t}
              type="button"
              className={activeTab === t ? "active" : ""}
              onClick={() => setTab(t)}
              title={label}
            >
              {label}
            </button>
          );
        })}
      </nav>
      <div className="inspector-content creative-inspector-content">
        {activeTab === "overview" && (
          <>
            <div className="control-banner kind-creative">
              <Image size={16} />
              <div>
                <b>Codex visual specialist</b>
                <small>
                  Creates visual assets for downstream builder steps.
                </small>
              </div>
            </div>
            <Section title="Identity">
              <label>
                Name
                <input
                  value={d.label}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
              <label>
                Role
                <input
                  value={d.role}
                  onChange={(e) => update({ role: e.target.value })}
                />
              </label>
              <label>
                Description
                <textarea
                  value={d.description}
                  onChange={(e) => update({ description: e.target.value })}
                />
              </label>
            </Section>
            <Section title="Graph contract">
              <Metric label="Upstream inputs" value={String(upstream)} />
              <Metric label="Downstream consumers" value={String(downstream)} />
              <Metric label="Primary skill" value={primary.label} />
              <Metric
                label="Enabled skills"
                value={String((d.skills ?? []).length || 1)}
              />
              <Metric
                label="Thread ID"
                value={d.threadId?.slice(0, 16) ?? "Not started"}
              />
            </Section>
          </>
        )}

        {activeTab === "skills" && (
          <>
            <ConnectorSkillPicker
              context={`${d.role} ${d.description} ${d.prompt}`}
              skills={capabilities.skills}
              selected={d.skills ?? []}
              primary={d.activeSkill}
              status={capabilitiesStatus}
              error={capabilitiesError}
              onChange={(skills, activeSkill) =>
                update({ skills, activeSkill })
              }
            />
          </>
        )}

        {activeTab === "tools" && (
          <>
            <ConnectorToolPicker
              context={`${d.role} ${d.description} ${d.prompt}`}
              tools={capabilities.tools}
              selected={d.connectorTools ?? []}
              status={capabilitiesStatus}
              error={capabilitiesError}
              onChange={(connectorTools) => update({ connectorTools })}
            />
            <Section title="Preferred capabilities">
              {STANDARD_TOOL_LABELS.map((tool) => {
                const granted = d.tools.some(
                  (item) => item.toLowerCase() === tool.toLowerCase(),
                );
                return (
                  <button
                    className="permission"
                    key={tool}
                    onClick={() =>
                      update({
                        tools: granted
                          ? d.tools.filter(
                              (item) =>
                                item.toLowerCase() !== tool.toLowerCase(),
                            )
                          : [...d.tools, tool],
                      })
                    }
                  >
                    <Wrench size={13} />
                    <span>{tool}</span>
                    <b>{permissionGrantLabel(tool, granted)}</b>
                  </button>
                );
              })}
              <p className="helper">{toolsUiHelperText()}</p>
            </Section>
          </>
        )}

        {activeTab === "instructions" && (
          <>
            <Section title="Instruction surfaces">
              <PromptEditor
                label="Base instructions (harness)"
                value={d.baseInstructions ?? ""}
                onChange={(next) => update({ baseInstructions: next })}
                placeholder="Authored harness-like base. Leave empty to opt into native Codex base."
                helper="Empty base = opt-in native Codex base"
                rows={6}
              />
              <PromptEditor
                label="Developer brief / role contract"
                value={d.developerInstructions ?? d.prompt ?? ""}
                onChange={(next) =>
                  update({
                    developerInstructions: next,
                    prompt: next,
                  })
                }
                placeholder="Brand tone, palette, constraints, references…"
                helper={
                  <>
                    Skill guidance is appended automatically:{" "}
                    <em>{primary.directionHint}</em>
                  </>
                }
                rows={12}
              />
            </Section>
            <CompletionCriteriaEditor
              criteria={d.completionCriteria}
              evaluation={resolveCriteriaEvaluation(d)}
              onChange={(completionCriteria) => update({ completionCriteria })}
              hardCriteriaGate={d.hardCriteriaGate}
              onGateChange={(hardCriteriaGate) => update({ hardCriteriaGate })}
            />
          </>
        )}

        {activeTab === "context" && (
          <>
            <Section title="Context Aperture">
              <p className="helper">
                Upstream design direction and mission the studio may read.
              </p>
              <Metric label="Upstream inputs" value={String(upstream)} />
              <Metric label="Downstream consumers" value={String(downstream)} />
              {upstreamNodes.map((source) => (
                <div className="context-row included" key={source.id}>
                  <Check size={13} />
                  <span>
                    <b>{source.data.label}</b>
                    <small>{source.data.output ?? "Pending"}</small>
                  </span>
                  <em>included</em>
                </div>
              ))}
              {revisionNodes.map((source) => (
                <div className="context-row revision" key={source.id}>
                  <RotateCcw size={13} />
                  <span>
                    <b>{source.data.label} feedback</b>
                    <small>
                      {source.data.output ?? "No revision feedback yet"}
                    </small>
                  </span>
                  <em>authorized retry only</em>
                </div>
              ))}
              {!upstreamNodes.length && (
                <p className="helper">
                  Connect upstream briefs or product agents so the studio can
                  read the mission.
                </p>
              )}
            </Section>
            <Section title="Composed skill prompt">
              <pre className="composed-prompt-preview">
                {composeCreativeSystemPrompt(d.prompt, d.skills, d.activeSkill)}
              </pre>
            </Section>
            <Section title="Composed context">
              <pre>
                {JSON.stringify(
                  composeSpecialistInputPreview(
                    workflowInput,
                    node.id,
                    upstreamNodes,
                    inboundEdges,
                  ),
                  null,
                  2,
                )}
              </pre>
            </Section>
          </>
        )}

        {activeTab === "io" && (
          <>
            <Section title="Input contract">
              <textarea
                className="tall schema-editor"
                value={d.inputSchema ?? defaultInputSchema}
                onChange={(event) =>
                  update({ inputSchema: event.target.value })
                }
              />
            </Section>
            <Section title="Output contract">
              <textarea
                className="tall schema-editor"
                value={d.outputSchema ?? defaultOutputSchema}
                onChange={(event) =>
                  update({ outputSchema: event.target.value })
                }
              />
            </Section>
            <Section title="Latest summary">
              <div className="output-card">
                <span>{d.status}</span>
                <p>{d.output || "No studio output yet."}</p>
              </div>
            </Section>
            <Section title="Artifacts">
              {d.artifacts?.length ? (
                d.artifacts.map((artifact) => (
                  <div className="artifact-row" key={artifact.id}>
                    {artifact.kind === "image" ? (
                      <Image size={14} />
                    ) : (
                      <FileOutput size={14} />
                    )}
                    {artifact.name}
                    <small>{artifact.kind}</small>
                  </div>
                ))
              ) : (
                <div className="artifact-row">
                  <Image size={14} />
                  No image assets yet<small>run studio</small>
                </div>
              )}
            </Section>
          </>
        )}

        {activeTab === "trace" && (
          <Section title="Execution trace">
            <div className="trace">
              {nodeEvents.map((event, i) => (
                <div key={event.id}>
                  <span
                    className={i === nodeEvents.length - 1 ? "active" : ""}
                  />
                  <div>
                    <b>{event.message}</b>
                    <small>
                      {new Date(event.at).toLocaleTimeString()} ·{" "}
                      {event.elapsedMs !== undefined
                        ? `${event.elapsedMs}ms · `
                        : ""}
                      {event.status ?? event.level ?? event.type}
                    </small>
                  </div>
                </div>
              ))}
              {!nodeEvents.length && (
                <p className="helper">
                  No runtime events recorded for this node.
                </p>
              )}
            </div>
          </Section>
        )}

        {activeTab === "config" && (
          <>
            <Section title="Model configuration">
              <p className="helper">
                {modelsStatus === "live"
                  ? `Live from Codex CLI · ${availableModels.length} model${availableModels.length === 1 ? "" : "s"}.`
                  : modelsStatus === "loading"
                    ? "Loading models from Codex CLI…"
                    : modelsError
                      ? `Unavailable — ${modelsError}`
                      : "Unavailable — connect Codex CLI to load models."}
                {onRefreshModels && isTauri() && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="linkish"
                      onClick={onRefreshModels}
                    >
                      Refresh models
                    </button>
                  </>
                )}
              </p>
              <label>
                Model
                <select
                  value={modelId}
                  onChange={(e) => {
                    const next = e.target.value;
                    const efforts = effortsForModel(availableModels, next);
                    const nextEffort = efforts.includes(d.effort)
                      ? d.effort
                      : ((efforts[0] as AgentData["effort"]) ?? "low");
                    update({ model: next, effort: nextEffort });
                  }}
                  disabled={
                    modelsStatus === "loading" || availableModels.length === 0
                  }
                >
                  {availableModels.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    <>
                      {!modelId ||
                      !availableModels.some(
                        (m) => m.id === modelId || m.model === modelId,
                      ) ? (
                        <option value={modelId || ""} disabled>
                          {modelId
                            ? `${modelId} (not in live list)`
                            : "Select a model…"}
                        </option>
                      ) : null}
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id} title={m.description}>
                          {m.displayName || m.model || m.id}
                          {m.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </label>
              <label>
                Reasoning effort
                <select
                  value={
                    effortOptions.includes(d.effort)
                      ? d.effort
                      : effortOptions[0]
                  }
                  onChange={(e) =>
                    update({ effort: e.target.value as AgentData["effort"] })
                  }
                >
                  {effortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            </Section>
            <Suspense
              fallback={
                <p className="helper">Loading Codex runtime settings…</p>
              }
            >
              <ConnectorRuntimePanel
                data={d}
                inventory={capabilities}
                status={capabilitiesStatus}
                error={capabilitiesError}
                update={update}
              />
            </Suspense>
            <Section title="Execution policy">
              <label>
                Sandbox profile
                <select
                  value={d.sandboxProfile ?? "workspace-write"}
                  disabled={Boolean(d.permissionProfile)}
                  onChange={(e) =>
                    update({
                      sandboxProfile: e.target
                        .value as AgentData["sandboxProfile"],
                    })
                  }
                >
                  <option value="workspace-write">Workspace write</option>
                  <option value="read-only">Read only</option>
                </select>
              </label>
              <label>
                Approval policy
                <select
                  value={d.approvalPolicy ?? "on-request"}
                  onChange={(e) =>
                    update({
                      approvalPolicy: e.target
                        .value as AgentData["approvalPolicy"],
                    })
                  }
                >
                  <option value="on-request">On request</option>
                  <option value="untrusted">Untrusted actions</option>
                  <option value="never">Never ask (use sandbox)</option>
                </select>
              </label>
              <label>
                Working directory (sandbox remains authoritative)
                <select
                  value={d.workspacePolicy ?? "isolated"}
                  onChange={(e) =>
                    update({
                      workspacePolicy: e.target
                        .value as AgentData["workspacePolicy"],
                    })
                  }
                >
                  <option value="isolated">
                    Isolated node attempt directory
                  </option>
                  <option value="workflow">
                    Run-selected workflow directory
                  </option>
                </select>
                {(d.workspacePolicy ?? "isolated") === "isolated" && (
                  <small>
                    Uses an app-managed node/attempt directory. The run-selected
                    workspace remains available only as an authorized runtime
                    root; it does not become this node's working directory.
                  </small>
                )}
              </label>
              <label>
                Timeout (seconds)
                <input
                  type="number"
                  min="10"
                  max="1800"
                  value={d.timeoutSeconds ?? 120}
                  onChange={(event) =>
                    update({ timeoutSeconds: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Maximum retries
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={d.maxRetries ?? 2}
                  onChange={(event) =>
                    update({ maxRetries: Number(event.target.value) })
                  }
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={!!d.requiresApproval}
                  onChange={(event) =>
                    update({ requiresApproval: event.target.checked })
                  }
                />
                Require durable operator approval after successful verification
              </label>
            </Section>
          </>
        )}
      </div>
      <div className="inspector-actions">
        <button onClick={save} aria-label="Save creative node">
          <Save size={14} />
          Save
        </button>
        <button onClick={duplicate} aria-label="Duplicate creative node">
          <Copy size={14} />
          Duplicate
        </button>
        <button
          onClick={resetConfiguration}
          aria-label="Reset creative runtime configuration"
        >
          <RotateCcw size={14} />
          Reset
        </button>
        {(d.status === "running" || d.status === "approval") && (
          <button onClick={interrupt} aria-label="Interrupt creative run">
            <Square size={13} />
            Interrupt
          </button>
        )}
        {(d.output || d.structuredOutput || d.artifacts?.length) && (
          <button onClick={exportOutput} aria-label="Export creative output">
            <FileOutput size={14} />
            Export
          </button>
        )}
        <button
          className="primary"
          onClick={run}
          aria-label="Run creative studio"
        >
          <Play size={14} />
          Run studio
        </button>
      </div>
    </>
  );
}

function ControlNodeInspector({
  node,
  update,
  upstream,
  upstreamNodes,
  downstream,
  run,
  duplicate,
  save,
  interrupt,
}: {
  node: FlowNode;
  update: (p: Partial<AgentData>) => void;
  upstream: number;
  upstreamNodes: FlowNode[];
  downstream: number;
  run: () => void;
  duplicate: () => void;
  save: () => void;
  interrupt: () => void;
}) {
  const d = node.data;
  const kind = d.kind;
  const headerByKind: Record<string, { eyebrow: string; blurb: string }> = {
    input: {
      eyebrow: "WORKFLOW INPUT · ENTRY",
      blurb: "Mission payload entering the company graph",
    },
    cron: {
      eyebrow: "CRON TRIGGER · SCHEDULE",
      blurb: "Starts the company on a five-field cron schedule",
    },
    output: {
      eyebrow: "WORKFLOW OUTPUT · DELIVERY",
      blurb: "Collects final artifacts after the run",
    },
    approval: {
      eyebrow: "HUMAN CHECKPOINT",
      blurb: "Run pauses until a person approves or declines",
    },
    condition: {
      eyebrow: "CONDITION · TYPED ROUTING",
      blurb: "Routes downstream paths by result value",
    },
    merge: {
      eyebrow: "MERGE · JOIN",
      blurb: "Waits for required upstream branches before continuing",
    },
  };
  const meta = headerByKind[kind] ?? {
    eyebrow: `CONTROL · ${kind.toUpperCase()}`,
    blurb: d.role,
  };

  const exportOutput = () => {
    const payload = JSON.stringify(
      {
        nodeId: node.id,
        kind,
        status: d.status,
        summary: d.output ?? null,
        data: d.structuredOutput ?? {},
        artifacts: d.artifacts ?? [],
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${node.id}-output.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const identityFields = (
    <Section title="Identity">
      <label>
        Name
        <input
          value={d.label}
          onChange={(e) => update({ label: e.target.value })}
        />
      </label>
      <label>
        Role
        <input
          value={d.role}
          onChange={(e) => update({ role: e.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          value={d.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </label>
    </Section>
  );

  return (
    <>
      <div className={`inspector-header control-inspector-header kind-${kind}`}>
        <div>
          <span>{meta.eyebrow}</span>
          <h2>{d.label}</h2>
          <p>{meta.blurb}</p>
        </div>
        <span className={`big-status ${d.status}`}>{statusText[d.status]}</span>
      </div>
      <div className="inspector-content control-inspector-content">
        <div className={`control-banner kind-${kind}`}>
          {kind === "input" && <Inbox size={16} />}
          {kind === "cron" && <Clock3 size={16} />}
          {kind === "output" && <FileOutput size={16} />}
          {kind === "approval" && <Hand size={16} />}
          {kind === "condition" && <GitBranch size={16} />}
          {kind === "merge" && <Merge size={16} />}
          <div>
            <b>{controlKindLabel(kind)} node</b>
            <small>
              {kind === "input" &&
                "Not an agent — provides the authorized mission for downstream specialists."}
              {kind === "cron" &&
                "Not an agent — starts a run while the desktop app is open and connects into a Mission brief."}
              {kind === "output" &&
                "Not an agent — packages upstream results into a delivery bundle."}
              {kind === "approval" &&
                "Not an agent — blocks the graph until a human decision is recorded."}
              {kind === "condition" &&
                "Not an agent — evaluates a branch value for typed routing."}
              {kind === "merge" &&
                "Not an agent — joins parallel dependencies before continuing."}
            </small>
          </div>
        </div>

        {kind === "input" && (
          <>
            {identityFields}
            <Section title="Mission">
              <PromptEditor
                label="Workflow mission"
                value={d.output ?? ""}
                onChange={(next) =>
                  update({
                    output: next,
                    missionSource: "manual",
                    missionUpdatedAt: new Date().toISOString(),
                  })
                }
                placeholder="High-level request the company should execute…"
                helper="Authorized mission text for specialists. Markdown supported."
                rows={10}
              />
              <label>
                Constraints (one per line)
                <textarea
                  data-testid="mission-constraints"
                  className="tall"
                  value={constraintsToTextarea(d.missionConstraints)}
                  onChange={(e) =>
                    update({
                      missionConstraints: constraintsFromTextarea(
                        e.target.value,
                      ),
                      missionSource: "manual",
                      missionUpdatedAt: new Date().toISOString(),
                    })
                  }
                  placeholder={
                    "Single page only\nNo authentication\nNo backend API"
                  }
                  rows={4}
                />
              </label>
              <p className="helper">
                Injected into every specialist as a Constraints section.
              </p>
              <PromptEditor
                label="Acceptance notes"
                value={d.acceptanceNotes ?? ""}
                onChange={(next) =>
                  update({
                    acceptanceNotes: next,
                    missionSource: "manual",
                    missionUpdatedAt: new Date().toISOString(),
                  })
                }
                placeholder="Definition of done for the company run…"
                helper="Injected as Acceptance notes in the authorized mission."
                rows={5}
              />
              <Section title="Composed mission (what specialists receive)">
                <pre
                  className="composed-prompt-preview"
                  data-testid="composed-mission-preview"
                >
                  {composeAuthorizedMission({
                    output: d.output,
                    missionConstraints: d.missionConstraints,
                    acceptanceNotes: d.acceptanceNotes,
                  })}
                </pre>
              </Section>
            </Section>
            <Section title="Graph position">
              <Metric label="Upstream inputs" value={String(upstream)} />
              <Metric label="Downstream consumers" value={String(downstream)} />
              <Metric label="Runs as agent" value="No" />
            </Section>
          </>
        )}

        {kind === "cron" && (
          <>
            {identityFields}
            <Section title="Schedule">
              <label>
                Cron expression
                <input
                  value={d.cronExpression ?? "0 9 * * 1-5"}
                  onChange={(event) =>
                    update({ cronExpression: event.target.value })
                  }
                  placeholder="0 9 * * 1-5"
                  spellCheck={false}
                />
                <small className="helper">
                  Minute · hour · day of month · month · day of week
                </small>
              </label>
              <label>
                Timezone
                <input
                  value={d.cronTimezone ?? "UTC"}
                  onChange={(event) =>
                    update({ cronTimezone: event.target.value })
                  }
                  placeholder="Asia/Calcutta"
                  spellCheck={false}
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={d.cronEnabled !== false}
                  onChange={(event) =>
                    update({ cronEnabled: event.target.checked })
                  }
                />
                <span>
                  <b>Schedule enabled</b>
                  <small>
                    Runs once per matching minute while the app is open.
                  </small>
                </span>
              </label>
            </Section>
            <Section title="Graph position">
              <Metric label="Upstream inputs" value="None — trigger node" />
              <Metric
                label="Downstream mission inputs"
                value={String(downstream)}
              />
              <Metric label="Runs as agent" value="No" />
            </Section>
          </>
        )}

        {kind === "output" && (
          <>
            {identityFields}
            <Section title="Release Bundle">
              <div className="output-card">
                <span>{d.status}</span>
                <p>{d.output || "No delivery summary yet."}</p>
              </div>
              <pre>
                {JSON.stringify(
                  d.structuredOutput ?? {
                    status: "pending",
                    summary: null,
                    artifacts: [],
                  },
                  null,
                  2,
                )}
              </pre>
            </Section>
            <Section title="Artifacts">
              <ArtifactList artifacts={d.artifacts} />
            </Section>
            <Section title="Graph position">
              <Metric label="Upstream inputs" value={String(upstream)} />
              <Metric
                label="Sources"
                value={
                  upstreamNodes.length
                    ? upstreamNodes.map((n) => n.data.label).join(", ")
                    : "None connected"
                }
              />
              <Metric label="Runs as agent" value="No" />
            </Section>
          </>
        )}

        {kind === "approval" && (
          <>
            {identityFields}
            <Section title="Checkpoint">
              <PromptEditor
                label="Approval prompt"
                value={d.prompt}
                onChange={(next) => update({ prompt: next })}
                placeholder="What should the human confirm before continuing?"
                helper="Shown when the run reaches this gate. Decline fails closed and skips downstream work."
                rows={8}
              />
            </Section>
            <Section title="Status">
              <Metric label="Upstream ready" value={String(upstream)} />
              <Metric
                label="Downstream after approve"
                value={String(downstream)}
              />
              <Metric label="Current state" value={statusText[d.status]} />
            </Section>
            {d.trace.length > 0 && (
              <Section title="Recent events">
                <div className="trace">
                  {d.trace.slice(-6).map((line, i) => (
                    <div
                      key={`${typeof line === "string" ? line : line.at}-${i}`}
                    >
                      <span
                        className={
                          i === d.trace.slice(-6).length - 1 ? "active" : ""
                        }
                      />
                      <div>
                        <b>{typeof line === "string" ? line : line.text}</b>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}

        {kind === "condition" && (
          <>
            {identityFields}
            <Section title="Branch rule">
              <label>
                Upstream source node ID
                <input
                  value={d.conditionRule?.sourceNodeId ?? ""}
                  onChange={(e) =>
                    update({
                      conditionRule: {
                        ...(d.conditionRule ?? {
                          path: "$.status",
                          operator: "==",
                          value: "success",
                          trueBranch: "success",
                          falseBranch: "otherwise",
                        }),
                        sourceNodeId: e.target.value || undefined,
                      },
                    })
                  }
                  placeholder="Optional when one input"
                />
              </label>
              <label>
                JSON path
                <input
                  value={d.conditionRule?.path ?? ""}
                  onChange={(e) =>
                    update({
                      conditionRule: {
                        ...(d.conditionRule ?? {
                          operator: "==",
                          value: "success",
                          trueBranch: "success",
                          falseBranch: "otherwise",
                        }),
                        path: e.target.value,
                      },
                    })
                  }
                  placeholder="$.data.score"
                />
              </label>
              <label>
                Operator
                <select
                  value={d.conditionRule?.operator ?? "=="}
                  onChange={(e) =>
                    update({
                      conditionRule: {
                        ...(d.conditionRule ?? {
                          path: "$.status",
                          value: "success",
                          trueBranch: "success",
                          falseBranch: "otherwise",
                        }),
                        operator: e.target.value as NonNullable<
                          typeof d.conditionRule
                        >["operator"],
                      },
                    })
                  }
                >
                  {["==", "!=", ">", ">=", "<", "<=", "contains", "exists"].map(
                    (operator) => (
                      <option key={operator}>{operator}</option>
                    ),
                  )}
                </select>
              </label>
              {d.conditionRule?.operator !== "exists" && (
                <label>
                  Comparison value
                  <input
                    value={String(d.conditionRule?.value ?? "")}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const value =
                        raw !== "" && Number.isFinite(Number(raw))
                          ? Number(raw)
                          : raw;
                      update({
                        conditionRule: {
                          ...(d.conditionRule ?? {
                            path: "$.status",
                            operator: "==",
                            trueBranch: "success",
                            falseBranch: "otherwise",
                          }),
                          value,
                        },
                      });
                    }}
                  />
                </label>
              )}
              <div className="two-col">
                <label>
                  True branch
                  <input
                    value={d.conditionRule?.trueBranch ?? "success"}
                    onChange={(e) =>
                      update({
                        conditionRule: {
                          ...(d.conditionRule ?? {
                            path: "$.status",
                            operator: "==",
                            value: "success",
                            falseBranch: "otherwise",
                          }),
                          trueBranch: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  False branch
                  <input
                    value={d.conditionRule?.falseBranch ?? "otherwise"}
                    onChange={(e) =>
                      update({
                        conditionRule: {
                          ...(d.conditionRule ?? {
                            path: "$.status",
                            operator: "==",
                            value: "success",
                            trueBranch: "success",
                          }),
                          falseBranch: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              </div>
              <p className="helper">
                Rules read structured upstream output only. Arbitrary code is
                never evaluated.
              </p>
            </Section>
            <Section title="Graph position">
              <Metric label="Upstream inputs" value={String(upstream)} />
              <Metric label="Downstream consumers" value={String(downstream)} />
              <Metric label="Runs as agent" value="No" />
            </Section>
          </>
        )}

        {kind === "merge" && (
          <>
            {identityFields}
            <Section title="Join policy">
              <p className="helper">
                This node becomes ready only after every non-revision upstream
                dependency has completed or been skipped.
              </p>
              <Metric label="Required upstreams" value={String(upstream)} />
              <Metric label="Downstream consumers" value={String(downstream)} />
              <Metric label="Runs as agent" value="No" />
            </Section>
            <Section title="Upstream branches">
              {upstreamNodes.length ? (
                upstreamNodes.map((source) => (
                  <div className="context-row included" key={source.id}>
                    <Check size={13} />
                    <span>
                      <b>{source.data.label}</b>
                      <small>{source.data.output ?? "Pending"}</small>
                    </span>
                    <em>{statusText[source.data.status]}</em>
                  </div>
                ))
              ) : (
                <p className="helper">
                  Connect upstream nodes into this merge.
                </p>
              )}
            </Section>
          </>
        )}
      </div>
      <div className="inspector-actions">
        <button
          onClick={save}
          aria-label="Save node changes"
          title="Save changes"
        >
          <Save size={14} />
          Save
        </button>
        <button onClick={duplicate} aria-label="Duplicate selected node">
          <Copy size={14} />
          Duplicate
        </button>
        {kind === "approval" &&
          (d.status === "running" || d.status === "approval") && (
            <button onClick={interrupt} aria-label="Interrupt selected node">
              <Square size={13} />
              Interrupt
            </button>
          )}
        {(kind === "output" || kind === "input") &&
          (d.output || d.structuredOutput || d.artifacts?.length) && (
            <button onClick={exportOutput} aria-label="Export node output">
              <FileOutput size={14} />
              Export
            </button>
          )}
        {kind === "input" && (
          <button className="primary" onClick={run} aria-label="Run company">
            <Play size={14} />
            Run company
          </button>
        )}
        {kind === "approval" && (
          <button
            className="primary"
            onClick={run}
            aria-label="Run from approval gate"
          >
            <Play size={14} />
            Run from gate
          </button>
        )}
      </div>
    </>
  );
}

export function EdgeInspector({
  edge,
  nodes,
  update,
}: {
  edge: FlowEdge;
  nodes: FlowNode[];
  update: (patch: Partial<NonNullable<FlowEdge["data"]>>) => void;
}) {
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);
  return (
    <>
      <div className="inspector-header">
        <div>
          <span>SELECTED EDGE</span>
          <h2>
            {source?.data.label} → {target?.data.label}
          </h2>
          <p>{edge.data?.edgeType} routing</p>
        </div>
      </div>
      <div className="inspector-content">
        <Section title="Routing">
          <Metric label="Source" value={source?.data.label || edge.source} />
          <Metric label="Target" value={target?.data.label || edge.target} />
          <label>
            Edge type
            <select
              value={edge.data?.edgeType ?? "standard"}
              onChange={(event) => {
                const edgeType = event.target.value as NonNullable<
                  FlowEdge["data"]
                >["edgeType"];
                // Apply type defaults so graph labels and runtime stay consistent.
                if (edgeType === "revision") {
                  update({
                    edgeType,
                    maxRevisions:
                      edge.data?.maxRevisions && edge.data.maxRevisions > 0
                        ? edge.data.maxRevisions
                        : 2,
                  });
                  return;
                }
                if (edgeType === "conditional") {
                  update({
                    edgeType,
                    condition: edge.data?.condition?.trim() || "success",
                  });
                  return;
                }
                update({ edgeType });
              }}
            >
              <option value="standard">Standard</option>
              <option value="conditional">Conditional</option>
              <option value="revision">Revision</option>
              <option value="approval">Approval</option>
              <option value="merge">Merge dependency</option>
            </select>
          </label>
          <Metric label="Payload" value="Structured output" />
        </Section>
        {edge.data?.edgeType === "conditional" && (
          <Section title="Condition">
            <label>
              Route when result equals
              <input
                value={edge.data.condition ?? "success"}
                onChange={(event) => update({ condition: event.target.value })}
              />
            </label>
          </Section>
        )}
        <Section title="Data mapping">
          <p className="helper">
            Optional field map: destination keys → <code>$.</code> paths on the
            upstream result. Leave empty to forward the full payload. Missing
            paths become <code>null</code>. Example:{" "}
            <code>{`{"summary":"$.summary","modules":"$.data.modules"}`}</code>
          </p>
          <label>
            Mapping JSON
            <textarea
              className="tall schema-editor"
              aria-label="Edge field mapping JSON"
              defaultValue={JSON.stringify(edge.data?.mapping ?? {}, null, 2)}
              key={`${edge.id}-mapping-${JSON.stringify(edge.data?.mapping ?? {})}`}
              onBlur={(event) => {
                const text = event.target.value.trim();
                if (!text || text === "{}" || text === "null") {
                  update({ mapping: undefined });
                  return;
                }
                try {
                  const parsed = JSON.parse(text) as Record<string, unknown>;
                  if (
                    !parsed ||
                    typeof parsed !== "object" ||
                    Array.isArray(parsed)
                  )
                    return;
                  const mapping: Record<string, string> = {};
                  for (const [field, path] of Object.entries(parsed)) {
                    if (typeof path === "string") mapping[field] = path;
                  }
                  update({
                    mapping: Object.keys(mapping).length ? mapping : undefined,
                  });
                } catch {
                  /* keep prior mapping until valid JSON is entered */
                }
              }}
            />
          </label>
        </Section>
        {edge.data?.edgeType === "revision" && (
          <Section title="Revision policy">
            <label>
              Maximum revisions
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                value={edge.data.maxRevisions ?? 2}
                onChange={(event) => {
                  const raw = Number(event.target.value);
                  const next = Number.isFinite(raw)
                    ? Math.min(10, Math.max(1, Math.round(raw)))
                    : 2;
                  update({ maxRevisions: next });
                }}
              />
            </label>
            <p className="helper">
              Graph label shows <code>used / max</code> for the revised node.
              Runtime stops after this many revision loops.
            </p>
            <Metric label="Limit behavior" value="Fail run" />
          </Section>
        )}
      </div>
    </>
  );
}
/** Prefer runtime verification SSOT chips; fall back to local re-eval / pending. */
function resolveCriteriaEvaluation(d: AgentData): CriterionEvaluation[] {
  const verificationResults = verificationResultsFromOutput(
    d.structuredOutput ?? null,
  );
  const statusFromData =
    typeof d.structuredOutput?.status === "string"
      ? String(d.structuredOutput.status)
      : undefined;
  const resultLike = {
    status:
      statusFromData ||
      (d.status === "completed" || d.status === "failed"
        ? d.status === "completed"
          ? "success"
          : "failure"
        : undefined),
    summary: d.output,
    data: d.structuredOutput,
    artifacts: d.artifacts,
  };
  // When runtime rows exist, evaluateCompletionCriteria defers to them (G10).
  if (verificationResults?.length) {
    return evaluateCompletionCriteria(
      d.completionCriteria,
      resultLike,
      verificationResults,
    );
  }
  if (d.criteriaEvaluation?.length) return d.criteriaEvaluation;
  const hasTerminalResult =
    d.status === "completed" ||
    d.status === "failed" ||
    Boolean(statusFromData);
  if (!hasTerminalResult) {
    return evaluateCompletionCriteria(d.completionCriteria, null, null);
  }
  return evaluateCompletionCriteria(d.completionCriteria, resultLike, null);
}

function patchCriterion(
  list: CompletionCriterion[],
  id: string,
  patch: Partial<CompletionCriterion>,
): CompletionCriterion[] {
  return list.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

function CompletionCriteriaEditor({
  criteria,
  evaluation,
  onChange,
  hardCriteriaGate,
  onGateChange,
}: {
  criteria: CompletionCriterion[] | undefined;
  evaluation: CriterionEvaluation[] | undefined;
  onChange: (next: CompletionCriterion[]) => void;
  hardCriteriaGate?: boolean;
  onGateChange?: (gate: boolean) => void;
}) {
  const list = ensureCompletionCriteria(criteria);
  const evalById = new Map((evaluation ?? []).map((e) => [e.id, e]));
  const [draft, setDraft] = useState("");

  const setEnabled = (id: string, enabled: boolean) => {
    onChange(patchCriterion(list, id, { enabled }));
  };

  const setEnforcement = (
    id: string,
    enforcement: CompletionCriterion["enforcement"],
  ) => {
    onChange(patchCriterion(list, id, { enforcement }));
  };

  const setKind = (id: string, kind: OperatorVerifierKind) => {
    onChange(
      list.map((c) => {
        if (c.id !== id) return c;
        const next: CompletionCriterion = {
          ...c,
          kind: kind as CriterionKind,
        };
        if (kind === "claim") {
          return {
            ...next,
            enforcement: "advisory",
            templateId: undefined,
            artifactName: undefined,
            artifactPath: undefined,
            policyId: undefined,
          };
        }
        if (kind === "command") {
          return {
            ...next,
            templateId: c.templateId || "npm_test",
            policyId: undefined,
            artifactName: undefined,
            artifactPath: undefined,
          };
        }
        if (kind === "artifact_exists") {
          return {
            ...next,
            templateId: undefined,
            policyId: undefined,
            artifactName: c.artifactName || "",
            artifactPath: c.artifactPath || "",
          };
        }
        // architecture_policy — pattern-scoped (native_runtime_ownership_v1)
        return {
          ...next,
          policyId: c.policyId || "native_runtime_ownership_v1",
          templateId: undefined,
          artifactName: undefined,
          artifactPath: undefined,
        };
      }),
    );
  };

  const removeCustom = (id: string) => {
    onChange(list.filter((c) => c.id !== id || c.platform));
  };

  const addCustom = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...list, makeCustomCriterion(text)]);
    setDraft("");
  };

  return (
    <Section title="Completion criteria">
      <p className="helper" data-testid="completion-criteria-helper">
        Platform guarantees and host verifiers (command, artifact, architecture)
        are evaluated by the runtime after each run. Claim criteria are advisory
        evidence only. Post-run chips prefer{" "}
        <code>data.verification.results</code> (runtime SSOT).
      </p>
      {onGateChange && (
        <label
          className="criteria-hard-gate-toggle"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            marginBottom: "0.75rem",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={hardCriteriaGate === true}
            onChange={(e) => onGateChange(e.target.checked)}
            data-testid="completion-criteria-hard-gate"
          />
          <span>Fail run on criteria mismatch (Hard Gate)</span>
        </label>
      )}
      <div className="criteria-list" data-testid="completion-criteria-list">
        {list.map((c) => {
          const ev = evalById.get(c.id);
          const status = ev?.status ?? "pending";
          const kindLabel = c.platform
            ? "platform"
            : c.kind === "claim" || c.kind === "custom"
              ? "claim"
              : c.kind;
          return (
            <div
              key={c.id}
              className={`criteria-row status-${status}`}
              data-testid={`criterion-${c.id}`}
              data-eval={status}
              data-kind={c.kind}
            >
              <div className="criteria-row-main">
                <label className="criteria-toggle">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    disabled={c.platform}
                    onChange={(e) => setEnabled(c.id, e.target.checked)}
                    aria-label={`Enable criterion: ${c.label}`}
                  />
                  <span>
                    <b>{c.label}</b>
                    <small
                      className={`criteria-badge${c.platform ? "" : " custom"}`}
                    >
                      {kindLabel}
                    </small>
                    {ev ? (
                      <small className={`criteria-eval eval-${status}`}>
                        {status}
                        {ev.detail ? ` · ${ev.detail}` : ""}
                      </small>
                    ) : (
                      <small className="criteria-eval eval-pending">
                        pending · run to evaluate
                      </small>
                    )}
                  </span>
                </label>
                {!c.platform && (
                  <div className="criteria-actions">
                    <select
                      value={
                        OPERATOR_VERIFIER_KINDS.includes(
                          c.kind as OperatorVerifierKind,
                        )
                          ? c.kind
                          : "claim"
                      }
                      onChange={(event) =>
                        setKind(
                          c.id,
                          event.target.value as OperatorVerifierKind,
                        )
                      }
                      aria-label={`Kind for criterion: ${c.label}`}
                      data-testid={`criterion-kind-${c.id}`}
                    >
                      <option value="claim">claim</option>
                      <option value="command">command</option>
                      <option value="artifact_exists">artifact_exists</option>
                      <option value="architecture_policy">
                        architecture_policy
                      </option>
                    </select>
                    <select
                      value={
                        c.kind === "claim" || c.kind === "custom"
                          ? "advisory"
                          : c.enforcement
                      }
                      disabled={c.kind === "claim" || c.kind === "custom"}
                      onChange={(event) =>
                        setEnforcement(
                          c.id,
                          event.target
                            .value as CompletionCriterion["enforcement"],
                        )
                      }
                      aria-label={`Enforcement for criterion: ${c.label}`}
                    >
                      <option value="required">Required</option>
                      <option value="advisory">Advisory</option>
                    </select>
                    <button
                      type="button"
                      className="criteria-remove"
                      onClick={() => removeCustom(c.id)}
                      aria-label={`Remove criterion: ${c.label}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>
              {!c.platform && c.kind === "command" && (
                <div className="criteria-config">
                  <label>
                    Command template
                    <select
                      value={c.templateId || "npm_test"}
                      onChange={(event) =>
                        onChange(
                          patchCriterion(list, c.id, {
                            templateId: event.target.value,
                          }),
                        )
                      }
                      aria-label={`Command template for: ${c.label}`}
                      data-testid={`criterion-template-${c.id}`}
                    >
                      {COMMAND_TEMPLATE_IDS.map((tid) => (
                        <option key={tid} value={tid}>
                          {tid}
                        </option>
                      ))}
                    </select>
                  </label>
                  {c.templateId === "node_script" && (
                    <label>
                      Script path (relative, path-confined)
                      <input
                        value={c.instruction ?? ""}
                        onChange={(event) =>
                          onChange(
                            patchCriterion(list, c.id, {
                              instruction: event.target.value,
                            }),
                          )
                        }
                        placeholder="scripts/verify.mjs"
                        aria-label={`node_script path for: ${c.label}`}
                      />
                    </label>
                  )}
                  {(c.templateId === "cargo_test" ||
                    c.templateId === "cargo_check") && (
                    <p className="helper criteria-policy-note">
                      cargo_* runs with the workflow workspace as cwd and
                      discovers <code>Cargo.toml</code> from there (no nested
                      monorepo path is hardcoded).
                    </p>
                  )}
                </div>
              )}
              {!c.platform && c.kind === "artifact_exists" && (
                <div className="criteria-config">
                  <label>
                    Artifact name
                    <input
                      value={c.artifactName ?? ""}
                      onChange={(event) =>
                        onChange(
                          patchCriterion(list, c.id, {
                            artifactName: event.target.value,
                          }),
                        )
                      }
                      placeholder="delivery-bundle.json"
                      aria-label={`Artifact name for: ${c.label}`}
                      data-testid={`criterion-artifact-name-${c.id}`}
                    />
                  </label>
                  <label>
                    Artifact path fragment
                    <input
                      value={c.artifactPath ?? ""}
                      onChange={(event) =>
                        onChange(
                          patchCriterion(list, c.id, {
                            artifactPath: event.target.value,
                          }),
                        )
                      }
                      placeholder="dist/ or src/app.ts"
                      aria-label={`Artifact path for: ${c.label}`}
                      data-testid={`criterion-artifact-path-${c.id}`}
                    />
                  </label>
                </div>
              )}
              {!c.platform && c.kind === "architecture_policy" && (
                <div className="criteria-config">
                  <label>
                    Policy id
                    <input
                      value={c.policyId ?? "native_runtime_ownership_v1"}
                      onChange={(event) =>
                        onChange(
                          patchCriterion(list, c.id, {
                            policyId: event.target.value,
                          }),
                        )
                      }
                      placeholder="native_runtime_ownership_v1"
                      aria-label={`Policy id for: ${c.label}`}
                      data-testid={`criterion-policy-${c.id}`}
                    />
                  </label>
                  <p className="helper criteria-policy-note">
                    <code>native_runtime_ownership_v1</code> is pattern-scoped:
                    it checks known native markers and suspect runtime path
                    shapes, not every possible scheduler name.
                  </p>
                </div>
              )}
              {!c.platform && (c.kind === "claim" || c.kind === "custom") && (
                <div className="criteria-config">
                  <label>
                    Evidence guidance (prompt-injected)
                    <input
                      value={c.instruction ?? c.label}
                      onChange={(event) =>
                        onChange(
                          patchCriterion(list, c.id, {
                            instruction: event.target.value,
                          }),
                        )
                      }
                      placeholder="Describe what evidence the specialist should cite"
                      aria-label={`Claim guidance for: ${c.label}`}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="criteria-add">
        <input
          data-testid="criterion-draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add criterion label…"
          aria-label="New custom completion criterion"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button type="button" onClick={addCustom} disabled={!draft.trim()}>
          Add
        </button>
      </div>
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="inspect-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function ConnectorSkillPicker({
  context,
  skills,
  selected,
  primary,
  status,
  error,
  onChange,
}: {
  context: string;
  skills: CodexSkillOption[];
  selected: string[];
  primary?: string;
  status: "loading" | "live" | "unavailable";
  error: string;
  onChange: (skills: string[], primary?: string) => void;
}) {
  const selectedSet = new Set(selected);
  const rankedSkills = [...skills].sort((a, b) => {
    const selectedDelta =
      Number(selectedSet.has(b.name)) - Number(selectedSet.has(a.name));
    if (selectedDelta) return selectedDelta;
    const scoreDelta =
      capabilityRelevanceScore(context, `${b.name} ${b.description}`) -
      capabilityRelevanceScore(context, `${a.name} ${a.description}`);
    return scoreDelta || a.name.localeCompare(b.name);
  });
  const toggle = (name: string) => {
    const next = new Set(selectedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    const values = [...next];
    onChange(values, primary && next.has(primary) ? primary : values[0]);
  };
  return (
    <Section title="Codex connector skills">
      <p className="helper">
        {status === "live"
          ? `Live from skills/list · ${skills.length} enabled skill${skills.length === 1 ? "" : "s"}. Select only skills relevant to this node.`
          : status === "loading"
            ? "Loading skills from the Codex connector…"
            : `Connector skills unavailable${error ? ` — ${error}` : "."}`}
      </p>
      <div className="skill-grid">
        {rankedSkills.map((skill) => {
          const on = selectedSet.has(skill.name);
          return (
            <div
              key={skill.name}
              className={`skill-card ${on ? "on" : ""} ${primary === skill.name ? "primary" : ""}`}
            >
              <button
                type="button"
                className="skill-toggle"
                onClick={() => toggle(skill.name)}
                aria-pressed={on}
                title={skill.description}
              >
                <Sparkles size={14} />
                <span>
                  <b>{skill.name}</b>
                  <small>{skill.description || `${skill.scope} skill`}</small>
                </span>
                <em>{on ? "on" : "off"}</em>
              </button>
              {on && (
                <label className="skill-primary">
                  <input
                    type="radio"
                    checked={primary === skill.name}
                    onChange={() => onChange(selected, skill.name)}
                  />
                  Primary for this node
                </label>
              )}
            </div>
          );
        })}
      </div>
      {status === "live" && skills.length === 0 && (
        <p className="helper">The connector returned no enabled skills.</p>
      )}
    </Section>
  );
}

function ConnectorToolPicker({
  context,
  tools,
  selected,
  status,
  error,
  onChange,
}: {
  context: string;
  tools: CodexToolOption[];
  selected: string[];
  status: "loading" | "live" | "unavailable";
  error: string;
  onChange: (tools: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const selectedDestructive = tools.filter(
    (tool) => selectedSet.has(tool.id) && tool.destructive,
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = [...tools]
    .sort((a, b) => {
      const selectedDelta =
        Number(selectedSet.has(b.id)) - Number(selectedSet.has(a.id));
      if (selectedDelta) return selectedDelta;
      const scoreDelta =
        capabilityRelevanceScore(
          context,
          `${b.server} ${b.name} ${b.title} ${b.description}`,
        ) -
        capabilityRelevanceScore(
          context,
          `${a.server} ${a.name} ${a.title} ${a.description}`,
        );
      return scoreDelta || a.name.localeCompare(b.name);
    })
    .filter(
      (tool) =>
        !normalizedQuery ||
        `${tool.server} ${tool.name} ${tool.title} ${tool.description}`
          .toLowerCase()
          .includes(normalizedQuery),
    )
    .slice(0, 80);
  return (
    <Section title="Codex connector tools">
      <p className="helper">
        {status === "live"
          ? `Live from mcpServerStatus/list · ${tools.length} tool${tools.length === 1 ? "" : "s"}. Selection guides the node; Codex sandbox and connector auth remain authoritative.`
          : status === "loading"
            ? "Loading MCP tools from the Codex connector…"
            : `Connector tools unavailable${error ? ` — ${error}` : "."}`}
      </p>
      {selectedDestructive.length > 0 && (
        <p className="helper warning-text">
          {selectedDestructive.length} selected tool
          {selectedDestructive.length === 1 ? " is" : "s are"} marked
          destructive by the connector. Sandbox, connector confirmation, and
          approval policy remain authoritative.
        </p>
      )}
      {status === "live" && tools.length > 0 && (
        <label>
          Find connector tool
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by app, server, or tool name"
          />
        </label>
      )}
      {visible.map((tool) => {
        const on = selectedSet.has(tool.id);
        return (
          <button
            type="button"
            className="permission"
            key={tool.id}
            onClick={() =>
              onChange(
                on
                  ? selected.filter((id) => id !== tool.id)
                  : [...selected, tool.id],
              )
            }
            title={tool.description}
          >
            <Wrench size={13} />
            <span>{tool.title || tool.name}</span>
            <b className={on ? "granted" : "denied"}>
              {on
                ? tool.destructive
                  ? "destructive"
                  : tool.readOnly
                    ? "read only"
                    : "selected"
                : tool.server}
            </b>
          </button>
        );
      })}
      {tools.length > 80 && !normalizedQuery && (
        <p className="helper">
          Showing the first 80 tools. Search to narrow the live inventory.
        </p>
      )}
    </Section>
  );
}

function ArtifactList({ artifacts }: { artifacts?: Artifact[] }) {
  if (!artifacts?.length) {
    return (
      <div className="artifact-row">
        <Code2 size={14} />
        No artifacts yet<small>pending run</small>
      </div>
    );
  }
  return (
    <>
      {artifacts.map((artifact) => (
        <div className="artifact-block" key={artifact.id}>
          <div className="artifact-row">
            <FileOutput size={14} />
            <span data-testid="artifact-name">{artifact.name}</span>
            <small>{artifact.kind}</small>
          </div>
          {artifact.content ? (
            <pre
              className="artifact-content"
              data-testid="artifact-content"
              data-artifact={artifact.name}
            >
              {artifact.content}
            </pre>
          ) : (
            <p className="helper">No content payload on this artifact.</p>
          )}
        </div>
      ))}
    </>
  );
}
