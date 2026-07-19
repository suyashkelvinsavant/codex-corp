import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CodexCapabilityInventory } from "./codex-capabilities";
import type { AgentData } from "./model";

type HookRun = {
  id: string;
  threadId: string;
  nodeId: string;
  eventName: string;
  handlerType: string;
  status: string;
  source: string | null;
  statusMessage: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
};

type McpServer = {
  name: string;
  toolsCount: number;
  resourcesCount: number;
  authStatus: string;
  serverVersion: string | null;
  serverTitle: string | null;
};

type CodexConfig = {
  model: string | null;
  approvalPolicy: string | null;
  sandboxMode: string | null;
  webSearch: string | null;
  instructions: string | null;
  developerInstructions: string | null;
  modelReasoningEffort: string | null;
  modelProvider: string | null;
};

export function ConnectorRuntimePanel({
  data,
  inventory,
  status,
  error,
  update,
}: {
  data: AgentData;
  inventory: CodexCapabilityInventory;
  status: "loading" | "live" | "unavailable";
  error: string;
  update: (patch: Partial<AgentData>) => void;
}) {
  const [hookRuns, setHookRuns] = useState<HookRun[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [config, setConfig] = useState<CodexConfig | null>(null);
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [showHooks, setShowHooks] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (status !== "live") return;
    setRuntimeLoading(true);
    setRuntimeErrors({});
    const load = async <T,>(key: string, request: Promise<T>, apply: (value: T) => void) => {
      try {
        apply(await request);
      } catch (failure) {
        setRuntimeErrors((current) => ({
          ...current,
          [key]: failure instanceof Error ? failure.message : String(failure),
        }));
      }
    };
    void Promise.all([
      load("hooks", invoke<HookRun[]>("list_hook_runs", { limit: 20 }), setHookRuns),
      load("mcp", invoke<McpServer[]>("list_mcp_server_status"), setMcpServers),
      load("config", invoke<CodexConfig>("read_codex_config"), setConfig),
    ]).finally(() => setRuntimeLoading(false));
  }, [status, reloadToken]);

  const providerLabels = [
    inventory.provider.imageGeneration ? "image generation" : null,
    inventory.provider.webSearch ? "web search" : null,
    inventory.provider.namespaceTools ? "namespaced tools" : null,
  ].filter(Boolean);
  return (
    <section className="inspect-section">
      <h3>Codex runtime capabilities</h3>
      <p className="helper">
        {status === "live"
          ? "Live connector settings. Named permissions replace the manual sandbox profile for this node."
          : status === "loading"
            ? "Loading runtime capabilities from Codex…"
            : `Runtime inventory unavailable${error ? ` — ${error}` : "."}`}
      </p>

      {/* Account & Auth */}
      {inventory.account && (
        <div className="runtime-section">
          <h4>Account</h4>
          <RuntimeMetric label="Account type" value={inventory.account.type} />
          {inventory.account.email && (
            <details>
              <summary>Show account identifier</summary>
              <RuntimeMetric label="Email" value={inventory.account.email} />
            </details>
          )}
          {inventory.account.planType && (
            <RuntimeMetric label="Plan" value={inventory.account.planType} />
          )}
          <RuntimeMetric label="Auth mode" value={inventory.authMode ?? "unknown"} />
        </div>
      )}

      {/* Permission boundary */}
      <label>
        Permission boundary
        <select
          value={data.permissionProfile ?? ""}
          onChange={(event) =>
            update({ permissionProfile: event.target.value || undefined })
          }
          disabled={status !== "live"}
        >
          <option value="">Manual sandbox profile</option>
          {inventory.permissionProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.id}
              {profile.description ? ` — ${profile.description}` : ""}
            </option>
          ))}
        </select>
      </label>
      {data.permissionProfile?.includes("danger-full-access") && (
        <p className="helper warning-text">
          Full access removes workspace isolation. Use only for a node that
          genuinely requires host-wide access.
        </p>
      )}

      {/* Collaboration mode */}
      <label>
        Collaboration mode
        <select
          value={data.collaborationMode ?? "default"}
          onChange={(event) =>
            update({
              collaborationMode: event.target
                .value as AgentData["collaborationMode"],
            })
          }
          disabled={status !== "live"}
        >
          {(inventory.collaborationModes.length
            ? inventory.collaborationModes
            : [{ name: "Default", mode: "default" as const }]
          ).map((mode) => (
            <option key={mode.mode} value={mode.mode}>
              {mode.name}
              {mode.reasoningEffort ? ` · ${mode.reasoningEffort}` : ""}
            </option>
          ))}
        </select>
      </label>
      {data.collaborationMode === "plan" && (
        <p className="helper">
          Plan mode is best for research, architecture, and decomposition nodes;
          it may intentionally avoid implementation.
        </p>
      )}

      {/* Personality */}
      <label>
        Personality
        <select
          value={data.personality ?? "none"}
          onChange={(event) =>
            update({
              personality: event.target.value as AgentData["personality"],
            })
          }
        >
          <option value="none">None</option>
          <option value="pragmatic">Pragmatic</option>
          <option value="friendly">Friendly</option>
        </select>
      </label>

      <RuntimeMetric
        label="Provider features"
        value={
          providerLabels.length ? providerLabels.join(", ") : "Not advertised"
        }
      />
      {runtimeLoading && <p className="helper">Loading hooks, MCP servers, and config…</p>}
      {Object.entries(runtimeErrors).map(([area, message]) => (
        <div className="runtime-load-error" key={area}>
          <p className="helper warning-text">
            {area} unavailable — {message}
          </p>
          <button type="button" onClick={() => setReloadToken((value) => value + 1)}>
            Retry runtime data
          </button>
        </div>
      ))}
      {!runtimeLoading && !runtimeErrors.hooks && hookRuns.length === 0 && (
        <p className="helper">No hook runs recorded.</p>
      )}
      {!runtimeLoading && !runtimeErrors.mcp && mcpServers.length === 0 && (
        <p className="helper">No MCP servers reported.</p>
      )}
      <RuntimeMetric
        label="Accessible apps"
        value={String(inventory.apps.length)}
      />
      <RuntimeMetric
        label="Active hooks"
        value={String(inventory.hooks.length)}
      />
      <RuntimeMetric
        label="Enabled supported features"
        value={String(inventory.enabledRuntimeFeatures.length)}
      />

      {/* MCP Servers */}
      {mcpServers.length > 0 && (
        <div className="runtime-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowMcp(!showMcp)}
          >
            MCP Servers ({mcpServers.length}) {showMcp ? "▾" : "▸"}
          </button>
          {showMcp && (
            <div className="section-content">
              {mcpServers.map((server) => (
                <div key={server.name} className="mcp-server-entry">
                  <div className="mcp-server-header">
                    <span className="mcp-server-name">
                      {server.serverTitle ?? server.name}
                    </span>
                    <span className={`mcp-auth-badge mcp-auth-${server.authStatus}`}>
                      {server.authStatus}
                    </span>
                  </div>
                  <div className="mcp-server-meta">
                    {server.toolsCount} tool{server.toolsCount !== 1 ? "s" : ""}
                    {server.resourcesCount > 0 && <> · {server.resourcesCount} resource{server.resourcesCount !== 1 ? "s" : ""}</>}
                    {server.serverVersion && <> · v{server.serverVersion}</>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hook Run History */}
      {hookRuns.length > 0 && (
        <div className="runtime-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowHooks(!showHooks)}
          >
            Recent hook runs ({hookRuns.length}) {showHooks ? "▾" : "▸"}
          </button>
          {showHooks && (
            <div className="section-content">
              {hookRuns.map((run) => (
                <div key={run.id} className={`hook-run-entry hook-run-${run.status}`}>
                  <div className="hook-run-header">
                    <span className="hook-event-name">{run.eventName}</span>
                    <span className={`hook-status-badge hook-status-${run.status}`}>
                      {run.status}
                    </span>
                  </div>
                  <div className="hook-run-meta">
                    {run.handlerType}
                    {run.source && <> · {run.source.split("/").pop()}</>}
                    {run.durationMs != null && <> · {run.durationMs}ms</>}
                  </div>
                  {run.statusMessage && (
                    <div className="hook-run-message">{run.statusMessage}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Codex Config */}
      {config && (
        <div className="runtime-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowConfig(!showConfig)}
          >
            Codex Configuration {showConfig ? "▾" : "▸"}
          </button>
          {showConfig && (
            <div className="section-content">
              <RuntimeMetric label="Model" value={config.model ?? "default"} />
              <RuntimeMetric label="Approval policy" value={config.approvalPolicy ?? "default"} />
              <RuntimeMetric label="Sandbox mode" value={config.sandboxMode ?? "default"} />
              <RuntimeMetric label="Web search" value={config.webSearch ?? "off"} />
              <RuntimeMetric label="Reasoning effort" value={config.modelReasoningEffort ?? "default"} />
              <RuntimeMetric label="Provider" value={config.modelProvider ?? "default"} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
