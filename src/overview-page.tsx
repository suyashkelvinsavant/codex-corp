import { useMemo, useState, type CSSProperties } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  Home,
  MessageSquare,
  Moon,
  Network,
  Palette,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import type { CodexInfo, RunRecord } from "./model";
import {
  addWorkflowToTemplates,
  listWorkflows,
  listTemplates,
  removeWorkflowFromTemplates,
  templateStats,
  type WorkflowTemplate,
} from "./templates";
import {
  ACCENT_PRESETS,
  applyAppearance,
  loadAppearance,
  type AppearancePrefs,
  type BodyWeight,
  type ThemeMode,
} from "./theme";
import { DataLogSettings } from "./data-log-settings";
import { HomePet } from "./home-pet";

export type OverviewSection =
  "workflows" | "templates" | "executions" | "settings";

type WorkspaceSection = Exclude<OverviewSection, "settings">;

export type OverviewPageProps = {
  activeWorkflowId: string;
  running: boolean;
  runHistory: RunRecord[];
  codexInfo: CodexInfo;
  onOpenChat: (id: string) => void;
  onEditWorkflow: (id: string) => void;
  onOpenCodexHealth: () => void;
  onCreateWorkflow: () => void;
  onOpenArchitect: (initialPrompt?: string) => void;
};

export function OverviewPage({
  activeWorkflowId,
  running,
  runHistory,
  codexInfo,
  onOpenChat,
  onEditWorkflow,
  onOpenCodexHealth,
  onCreateWorkflow,
  onOpenArchitect,
}: OverviewPageProps) {
  const [catalogRevision, setCatalogRevision] = useState(0);
  const workflows = useMemo(() => listWorkflows(), [catalogRevision]);
  const templates = useMemo(() => listTemplates(), [catalogRevision]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateSelection, setTemplateSelection] = useState<string[]>([]);
  const [section, setSection] = useState<OverviewSection>("workflows");
  const [lastWorkspaceSection, setLastWorkspaceSection] =
    useState<WorkspaceSection>("workflows");
  const [query, setQuery] = useState("");
  const [appearance, setAppearance] = useState<AppearancePrefs>(() =>
    loadAppearance(),
  );
  const [appearanceOpen, setAppearanceOpen] = useState(true);

  const selectWorkspaceSection = (next: WorkspaceSection) => {
    setLastWorkspaceSection(next);
    setSection(next);
  };

  const patchAppearance = (patch: Partial<AppearancePrefs>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    applyAppearance(next);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = section === "templates" ? templates : workflows;
    if (!q) return source;
    return source.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q),
    );
  }, [templates, workflows, query, section]);

  const availableForTemplates = workflows.filter(
    (workflow) => !templates.some((template) => template.id === workflow.id),
  );
  const closeTemplatePicker = () => {
    setTemplateSelection([]);
    setTemplatePickerOpen(false);
  };
  const addSelectedTemplates = () => {
    templateSelection.forEach((id) => addWorkflowToTemplates(id));
    closeTemplatePicker();
    setCatalogRevision((value) => value + 1);
  };
  const removeUserTemplate = (id: string) => {
    removeWorkflowFromTemplates(id);
    setCatalogRevision((value) => value + 1);
  };

  const failedRuns = runHistory.filter(
    (r) => r.status === "failed" || r.status === "interrupted",
  ).length;
  const completedRuns = runHistory.filter(
    (r) => r.status === "completed",
  ).length;
  const failureRate =
    runHistory.length === 0
      ? "0%"
      : `${Math.round((failedRuns / runHistory.length) * 100)}%`;

  const lastRunLabel = (id: string) => {
    if (id === activeWorkflowId && running) return "Run in progress";
    const hit =
      id === activeWorkflowId
        ? runHistory[0]
        : runHistory.find((r) => r.workflowId === id);
    if (!hit) return "Never run in this workspace";
    return `Last run · ${hit.status} · ${new Date(hit.createdAt).toLocaleDateString()}`;
  };

  const titles: Record<OverviewSection, { h1: string; sub: string }> = {
    workflows: {
      h1: "Workflows",
      sub: "Open a company mediator chat, or edit the specialist graph",
    },
    templates: {
      h1: "Templates",
      sub: "Factory company graphs — start a chat or open the canvas",
    },
    executions: {
      h1: "Executions",
      sub: `Run history for the active company (${workflows.find((t) => t.id === activeWorkflowId)?.name ?? activeWorkflowId})`,
    },
    settings: {
      h1: "Settings",
      sub: "Manage appearance, runtime, and local data",
    },
  };

  return (
    <div className="overview-shell">
      <aside className="overview-nav" aria-label="Primary">
        <div className="overview-nav-brand">
          <div className="brand-mark compact">
            <span />
            <span />
            <span />
          </div>
          <div>
            <b>CODEX CORP</b>
            <small>agent OS</small>
          </div>
        </div>
        <nav className="overview-nav-list">
          <NavBtn
            active={section !== "settings"}
            onClick={() => selectWorkspaceSection(lastWorkspaceSection)}
            icon={Home}
            label="Workspace"
          />
        </nav>
        <nav
          className="overview-nav-list overview-nav-utility"
          aria-label="Application"
        >
          <NavBtn
            active={section === "settings"}
            onClick={() => setSection("settings")}
            icon={Settings2}
            label="Settings"
          />
        </nav>
      </aside>

      <div
        className={`overview-main overview-main-solo ${section === "settings" ? "overview-main-settings" : ""}`}
      >
        <header className="overview-header">
          <div>
            <h1>{titles[section].h1}</h1>
            <p>{titles[section].sub}</p>
          </div>
          {section === "workflows" && (
            <div className="overview-header-actions">
              <button
                type="button"
                className="overview-architect-launch"
                onClick={() => onOpenArchitect()}
              >
                <Sparkles size={15} />
                <span>
                  <b>Workflow Architect</b>
                  <small>Create with AI guidance</small>
                </span>
              </button>
            </div>
          )}
        </header>

        {(section === "workflows" ||
          section === "templates" ||
          section === "executions") && (
          <section className="overview-stats" aria-label="Workspace stats">
            <div>
              <small>Workflows</small>
              <b>{workflows.length}</b>
            </div>
            <div>
              <small>Runs (active WF)</small>
              <b>{runHistory.length}</b>
            </div>
            <div>
              <small>Completed</small>
              <b>{completedRuns}</b>
            </div>
            <div>
              <small>Failed / interrupted</small>
              <b>{failedRuns}</b>
            </div>
            <div>
              <small>Failure rate</small>
              <b>{failureRate}</b>
            </div>
          </section>
        )}

        {(section === "workflows" || section === "templates") && (
          <section className="overview-list-panel overview-list-wide">
            <div className="overview-tabs">
              <WorkspaceTabs
                section={section}
                onSelect={selectWorkspaceSection}
              />
            </div>
            <div className="overview-toolbar">
              <label className="overview-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search workflows"
                  aria-label="Search workflows"
                />
              </label>
              {section === "workflows" && (
                <button
                  type="button"
                  className="overview-create overview-toolbar-action"
                  onClick={onCreateWorkflow}
                  disabled={running}
                  title={
                    running ? "Wait for the active run to finish" : undefined
                  }
                >
                  <Plus size={15} />
                  New workflow
                </button>
              )}
              {section === "templates" && (
                <button
                  type="button"
                  className="overview-create overview-toolbar-action"
                  onClick={() => setTemplatePickerOpen(true)}
                >
                  <Plus size={15} />
                  Add template
                </button>
              )}
            </div>

            {section === "templates" ? (
              <div className="template-grid">
                {filtered.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    lastRun={lastRunLabel(template.id)}
                    onOpenChat={() => onOpenChat(template.id)}
                    onEdit={() => onEditWorkflow(template.id)}
                    onRemove={
                      template.templateOrigin === "user"
                        ? () => removeUserTemplate(template.id)
                        : undefined
                    }
                  />
                ))}
                {!filtered.length && (
                  <div className="workflow-empty">
                    {query.trim()
                      ? "No templates match your search."
                      : "No templates installed. Build your first workflow with Workflow Architect."}
                  </div>
                )}
              </div>
            ) : (
              <ul className="workflow-card-list">
                {filtered.map((template) => {
                  const stats = templateStats(template);
                  return (
                    <li key={template.id}>
                      <article
                        className="workflow-card workflow-card-clickable"
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenChat(template.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenChat(template.id);
                          }
                        }}
                      >
                        <div className="workflow-card-icon">
                          <Network size={18} />
                        </div>
                        <div className="workflow-card-body">
                          <h3>{template.name}</h3>
                          <p>
                            {lastRunLabel(template.id)}
                            <span> · </span>
                            {stats.nodeCount} nodes · {stats.edgeCount} edges ·{" "}
                            {template.version}
                          </p>
                          <small>{template.description}</small>
                        </div>
                        <div className="workflow-card-actions">
                          <button
                            type="button"
                            className="workflow-edit"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditWorkflow(template.id);
                            }}
                          >
                            <Pencil size={14} />
                            View / Edit workflow
                          </button>
                        </div>
                      </article>
                    </li>
                  );
                })}
                {!filtered.length && (
                  <li className="workflow-empty">
                    {query.trim()
                      ? "No companies match your search."
                      : "No workflows yet. Open Workflow Architect to design your first company."}
                  </li>
                )}
              </ul>
            )}
            <footer className="overview-list-foot">
              Total {filtered.length} ·{" "}
              {filtered.length
                ? "Click a company to open its mediator"
                : "Your catalog is ready for its first workflow"}
            </footer>
          </section>
        )}

        {section === "executions" && (
          <section className="overview-list-panel overview-list-wide">
            <div className="overview-tabs">
              <WorkspaceTabs
                section={section}
                onSelect={selectWorkspaceSection}
              />
            </div>
            <ul className="execution-list">
              {runHistory.length === 0 && (
                <li className="workflow-empty">
                  No runs yet for the active company. Open a workflow, press{" "}
                  <strong>Run company</strong>, and history will land here.
                </li>
              )}
              {runHistory.map((run) => (
                <li key={run.id} className="execution-row">
                  <div className={`execution-status ${run.status}`} />
                  <div>
                    <b>
                      {run.status} · {run.id.slice(0, 8)}
                    </b>
                    <p>
                      {new Date(run.createdAt).toLocaleString()} · workflow{" "}
                      {run.workflowId}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="workflow-edit"
                    onClick={() => onEditWorkflow(run.workflowId)}
                  >
                    Open graph
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {section === "settings" && (
          <section className="settings-panel">
            <nav className="settings-spine" aria-label="Settings sections">
              <div className="settings-spine-head">
                <span
                  className={codexInfo.compatible ? "online" : "attention"}
                />
                <div>
                  <small>CONTROL PLANE</small>
                  <b>
                    {codexInfo.compatible ? "Systems online" : "Check runtime"}
                  </b>
                </div>
              </div>
              <a href="#settings-appearance">
                <Palette size={15} />
                <span>
                  Appearance<small>Theme and reading weight</small>
                </span>
              </a>
              <a href="#settings-data">
                <Database size={15} />
                <span>
                  Data &amp; logs<small>Retention and storage</small>
                </span>
              </a>
            </nav>
            <div
              className="settings-scroll"
              tabIndex={0}
              aria-label="Settings controls"
            >
              <div
                id="settings-appearance"
                className={`appearance-card ${appearanceOpen ? "open" : ""}`}
              >
                <button
                  type="button"
                  className="appearance-card-trigger"
                  onClick={() => setAppearanceOpen((v) => !v)}
                  aria-expanded={appearanceOpen}
                >
                  <div className="appearance-card-lead">
                    <span className="appearance-card-icon" aria-hidden>
                      <Palette size={18} />
                    </span>
                    <div>
                      <h3>Appearance</h3>
                      <p>
                        Theme, accent, and text weight — changes apply instantly
                      </p>
                    </div>
                  </div>
                  <div className="appearance-card-summary">
                    <span
                      className="appearance-swatch"
                      style={{ background: appearance.accent }}
                    />
                    <em>
                      {appearance.mode === "dark" ? "Dark" : "Light"} · weight{" "}
                      {appearance.bodyWeight}
                    </em>
                    <ChevronDown
                      size={18}
                      className={`appearance-chevron ${appearanceOpen ? "up" : ""}`}
                    />
                  </div>
                </button>

                {appearanceOpen && (
                  <div className="appearance-card-body">
                    <div className="appearance-field">
                      <label className="appearance-label">Mode</label>
                      <div className="appearance-mode-toggle" role="group">
                        <button
                          type="button"
                          className={appearance.mode === "dark" ? "active" : ""}
                          onClick={() =>
                            patchAppearance({ mode: "dark" as ThemeMode })
                          }
                        >
                          <Moon size={15} />
                          Dark
                        </button>
                        <button
                          type="button"
                          className={
                            appearance.mode === "light" ? "active" : ""
                          }
                          onClick={() =>
                            patchAppearance({ mode: "light" as ThemeMode })
                          }
                        >
                          <Sun size={15} />
                          Light
                        </button>
                      </div>
                    </div>

                    <div className="appearance-field">
                      <label className="appearance-label">Accent color</label>
                      <div className="appearance-accents">
                        {ACCENT_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className={`appearance-accent ${
                              appearance.accent.toLowerCase() ===
                              preset.hex.toLowerCase()
                                ? "active"
                                : ""
                            }`}
                            style={
                              {
                                "--swatch": preset.hex,
                              } as CSSProperties
                            }
                            title={preset.label}
                            aria-label={preset.label}
                            onClick={() =>
                              patchAppearance({ accent: preset.hex })
                            }
                          >
                            <span />
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      <label className="appearance-custom-hex">
                        Custom accent
                        <input
                          type="color"
                          value={appearance.accent}
                          onChange={(e) =>
                            patchAppearance({ accent: e.target.value })
                          }
                          aria-label="Custom accent color"
                        />
                        <input
                          type="text"
                          value={appearance.accent}
                          maxLength={7}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
                              if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                                patchAppearance({ accent: v });
                              } else {
                                setAppearance((a) => ({ ...a, accent: v }));
                              }
                            }
                          }}
                          spellCheck={false}
                        />
                      </label>
                    </div>

                    <div className="appearance-field">
                      <label className="appearance-label">
                        Body text weight
                        <span>Heavier type reads better on dark panels</span>
                      </label>
                      <div className="appearance-weight" role="group">
                        {(
                          [
                            ["450", "Regular"],
                            ["500", "Medium"],
                            ["550", "Book"],
                            ["600", "Semibold"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={
                              appearance.bodyWeight === value ? "active" : ""
                            }
                            style={{ fontWeight: Number(value) }}
                            onClick={() =>
                              patchAppearance({
                                bodyWeight: value as BodyWeight,
                              })
                            }
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div
                      className="appearance-preview"
                      style={
                        {
                          borderColor: appearance.accent,
                          boxShadow: `0 0 0 1px ${appearance.accent}33`,
                        } as CSSProperties
                      }
                    >
                      <span style={{ color: appearance.accent }}>Preview</span>
                      <p>
                        Body copy at weight {appearance.bodyWeight} on{" "}
                        {appearance.mode} foundry panels. Headings stay bold;
                        secondary text uses a higher-contrast muted tone.
                      </p>
                      <button
                        type="button"
                        style={{
                          background: appearance.accent,
                          color: "#07110f",
                        }}
                      >
                        Sample action
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div id="settings-data">
                <DataLogSettings />
              </div>
            </div>
            <aside
              className="settings-runtime-rail"
              aria-label="Runtime and connection"
            >
              <div className="settings-runtime-rail-head">
                <small>LIVE SYSTEM</small>
                <b>Runtime status</b>
              </div>
              <div id="settings-runtime" className="settings-block">
                <div className="settings-rail-title">
                  <span>
                    <Cpu size={15} />
                  </span>
                  <h3>Runtime</h3>
                </div>
                <p>
                  Specialists run through the installed{" "}
                  <strong>Codex CLI app-server</strong>.
                </p>
                <p className="settings-ok">
                  <CheckCircle2 size={14} />
                  Active runtime: <strong>Codex</strong>
                </p>
              </div>
              <div id="settings-connection" className="settings-block">
                <div className="settings-rail-title">
                  <span>
                    <ShieldCheck size={15} />
                  </span>
                  <h3>Connection</h3>
                </div>
                <ul className="settings-kv">
                  <li>
                    <span>Status</span>
                    <b className={codexInfo.compatible ? "ok" : "bad"}>
                      {codexInfo.compatible ? "Compatible" : "Needs attention"}
                    </b>
                  </li>
                  <li>
                    <span>Version</span>
                    <b>{codexInfo.version ?? "Not found"}</b>
                  </li>
                  <li>
                    <span>Source</span>
                    <b>{codexInfo.selectedSource ?? "System CLI"}</b>
                  </li>
                  <li>
                    <span>Supported range</span>
                    <b>{codexInfo.supportedRange ?? "—"}</b>
                  </li>
                </ul>
                {codexInfo.incompatibilityReason && (
                  <p className="settings-warn">
                    {codexInfo.incompatibilityReason}
                  </p>
                )}
                <button
                  type="button"
                  className="workflow-edit"
                  onClick={onOpenCodexHealth}
                >
                  <ShieldCheck size={14} />
                  Open compatibility panel
                </button>
              </div>
            </aside>
          </section>
        )}
      </div>
      <HomePet
        running={running}
        runHistory={runHistory}
        onOpenArchitect={onOpenArchitect}
      />
      {templatePickerOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={closeTemplatePicker}
        >
          <section
            className="template-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-picker-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>USER TEMPLATES</small>
                <h2 id="template-picker-title">Add workflows as templates</h2>
                <p>
                  Select saved workflows to make them reusable from this tab.
                </p>
              </div>
              <button
                type="button"
                className="template-picker-close"
                aria-label="Close template picker"
                onClick={closeTemplatePicker}
              >
                ×
              </button>
            </header>
            <div className="template-picker-list">
              {availableForTemplates.map((workflow) => (
                <label key={workflow.id}>
                  <input
                    type="checkbox"
                    checked={templateSelection.includes(workflow.id)}
                    onChange={(event) =>
                      setTemplateSelection((current) =>
                        event.target.checked
                          ? [...current, workflow.id]
                          : current.filter((id) => id !== workflow.id),
                      )
                    }
                  />
                  <span>
                    <b>{workflow.name}</b>
                    <small>{workflow.description}</small>
                  </span>
                  <em>{templateStats(workflow).nodeCount} nodes</em>
                </label>
              ))}
              {!availableForTemplates.length && (
                <div className="workflow-empty">
                  Every saved workflow is already available as a template.
                </div>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="template-picker-cancel"
                onClick={closeTemplatePicker}
              >
                Cancel
              </button>
              <button
                type="button"
                className="template-picker-submit"
                disabled={!templateSelection.length}
                onClick={addSelectedTemplates}
              >
                {templateSelection.length
                  ? `Add ${templateSelection.length} ${templateSelection.length === 1 ? "template" : "templates"}`
                  : "Add templates"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function NavBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Home;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`overview-nav-item ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function WorkspaceTabs({
  section,
  onSelect,
}: {
  section: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}) {
  return (
    <div
      className="overview-tab-list"
      role="tablist"
      aria-label="Workspace views"
    >
      {(["workflows", "templates", "executions"] as const).map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={section === view}
          className={section === view ? "active" : ""}
          onClick={() => onSelect(view)}
        >
          {view[0].toUpperCase() + view.slice(1)}
        </button>
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  lastRun,
  onOpenChat,
  onEdit,
  onRemove,
}: {
  template: WorkflowTemplate;
  lastRun: string;
  onOpenChat: () => void;
  onEdit: () => void;
  onRemove?: () => void;
}) {
  const stats = templateStats(template);
  return (
    <article className="template-card">
      <header>
        <span>{template.version}</span>
        <h3>{template.name}</h3>
        <p>{template.description}</p>
      </header>
      <div className="template-card-meta">
        {stats.nodeCount} nodes · {stats.edgeCount} edges
        <em>{lastRun}</em>
      </div>
      <footer>
        <button type="button" className="overview-create" onClick={onOpenChat}>
          <MessageSquare size={14} />
          Open chat
        </button>
        <button type="button" className="workflow-edit" onClick={onEdit}>
          <Pencil size={14} />
          View / Edit
        </button>
        {onRemove && (
          <button
            type="button"
            className="template-remove"
            onClick={onRemove}
            title="Keep the workflow and remove only this template"
          >
            <Trash2 size={14} />
            Remove template
          </button>
        )}
      </footer>
    </article>
  );
}
