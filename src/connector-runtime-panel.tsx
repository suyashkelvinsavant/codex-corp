import type { CodexCapabilityInventory } from "./codex-capabilities";
import type { AgentData } from "./model";

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
