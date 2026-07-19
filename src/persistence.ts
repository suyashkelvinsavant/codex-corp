import type {
  Artifact,
  FlowEdge,
  FlowNode,
  RunEvent,
  RunRecord,
  Status,
  WorkflowSnapshot,
} from "./model";

export const WORKFLOW_ID = "software-company";
/** Legacy browser key for the original software-company workflow (back-compat). */
export const WORKFLOW_STORAGE_KEY = "codex-corp-workflow";
export const ACTIVE_WORKFLOW_KEY = "codex-corp-active-workflow";
export const RUNS_STORAGE_KEY = "codex-corp-runs";
export const WORKFLOW_SCHEMA_VERSION = 2 as const;

/** Serialize every current workflow write with an explicit schema version. */
export function serializeWorkflowSnapshot(
  nodes: FlowNode[],
  edges: FlowEdge[],
): string {
  return JSON.stringify({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    nodes,
    edges,
  });
}

type LegacyAgentData = Omit<FlowNode["data"], "workspacePolicy"> & {
  memoryMode?: unknown;
  environmentVariables?: unknown;
  maxRevisions?: unknown;
  workspacePolicy?: "isolated" | "workflow" | "custom";
};

export function normalizeWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
): WorkflowSnapshot {
  const isLegacySnapshot = snapshot.schemaVersion !== WORKFLOW_SCHEMA_VERSION;
  const resetLegacyApproval =
    isLegacySnapshot &&
    snapshot.nodes.some(
      (node) =>
        (node.data.kind === "agent" || node.data.kind === "creative") &&
        node.data.requiresApproval === true,
    );
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    nodes: snapshot.nodes.map((node) => {
      const legacy = node.data as LegacyAgentData;
      const {
        memoryMode: _memoryMode,
        environmentVariables: _environmentVariables,
        maxRevisions: _maxRevisions,
        ...data
      } = legacy;
      return {
        ...node,
        data: {
          ...data,
          workspacePolicy:
            legacy.workspacePolicy === "workflow" ? "workflow" : "isolated",
          // Before schema v2 this flag was decorative. Do not silently turn an
          // old saved graph into a blocking post-node approval workflow.
          ...(isLegacySnapshot ? { requiresApproval: false } : {}),
        },
      } as FlowNode;
    }),
    edges: snapshot.edges,
    ...(resetLegacyApproval
      ? {
          migrationNotices: [
            "Legacy specialist approval flags were reset because they were not runtime gates before workflow schema v2.",
          ],
        }
      : {}),
  };
}

/** Per-template browser storage key; software-company keeps the legacy key. */
export function workflowStorageKey(workflowId: string): string {
  return workflowId === WORKFLOW_ID
    ? WORKFLOW_STORAGE_KEY
    : `codex-corp-workflow:${workflowId}`;
}

export function readActiveWorkflowId(
  raw: string | null | undefined,
  fallback = WORKFLOW_ID,
): string {
  if (raw && raw.trim()) return raw.trim();
  return fallback;
}

/** Autosave the leaving template when the user switches to a different id. */
export function shouldAutosaveBeforeTemplateSwitch(
  currentId: string,
  nextId: string,
  running: boolean,
): boolean {
  return !running && currentId !== nextId;
}

/**
 * Baseline timeline after a template switch — clears prior run events so the
 * drawer does not show another graph's execution trail.
 */
export function templateSwitchBaselineEvents(
  templateName: string,
  at = new Date().toISOString(),
): RunEvent[] {
  return [
    {
      id: `switch-${at}`,
      at,
      type: "workflow.template",
      message: `Template context · ${templateName}`,
      level: "info",
    },
  ];
}

/** Parse a saved workflow JSON string into a snapshot, or null if invalid. */
export function parseWorkflowSnapshot(
  raw: string | null | undefined,
): WorkflowSnapshot | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkflowSnapshot> & {
      schemaVersion?: unknown;
    };
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges))
      return null;
    if (!parsed.nodes.length) return null;
    if (
      parsed.schemaVersion !== undefined &&
      parsed.schemaVersion !== WORKFLOW_SCHEMA_VERSION
    ) {
      // A newer writer may have different semantics. Fail closed instead of
      // silently applying the legacy migration and destroying unknown fields.
      return null;
    }
    return normalizeWorkflowSnapshot({
      schemaVersion: parsed.schemaVersion,
      nodes: parsed.nodes as FlowNode[],
      edges: parsed.edges as FlowEdge[],
    });
  } catch {
    return null;
  }
}

/** Normalize stored run history (web or native) into RunRecord[]. */
export function parseRunRecords(raw: string | null | undefined): RunRecord[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeRunRecord(item))
      .filter((item): item is RunRecord => Boolean(item));
  } catch {
    return [];
  }
}

export function normalizeRunRecord(value: unknown): RunRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  if (!id) return null;
  return {
    id,
    workflowId:
      typeof record.workflowId === "string" ? record.workflowId : WORKFLOW_ID,
    status: typeof record.status === "string" ? record.status : "unknown",
    createdAt:
      typeof record.createdAt === "string"
        ? record.createdAt
        : new Date(0).toISOString(),
    eventsJson:
      typeof record.eventsJson === "string" ? record.eventsJson : "[]",
    nodesJson:
      typeof record.nodesJson === "string" ? record.nodesJson : undefined,
    edgesJson:
      typeof record.edgesJson === "string" ? record.edgesJson : undefined,
    terminalReason:
      typeof record.terminalReason === "string"
        ? record.terminalReason
        : undefined,
    resumable:
      typeof record.resumable === "boolean" ? record.resumable : undefined,
    pinned: typeof record.pinned === "boolean" ? record.pinned : undefined,
    lastEventSequence:
      typeof record.lastEventSequence === "number"
        ? record.lastEventSequence
        : undefined,
  };
}

export function parseRunEvents(eventsJson: string | undefined): RunEvent[] {
  if (!eventsJson?.trim()) return [];
  try {
    const parsed = JSON.parse(eventsJson) as unknown;
    return Array.isArray(parsed) ? (parsed as RunEvent[]) : [];
  } catch {
    return [];
  }
}

export function parseRunNodes(
  nodesJson: string | undefined,
): FlowNode[] | null {
  if (!nodesJson?.trim()) return null;
  try {
    const parsed = JSON.parse(nodesJson) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed as FlowNode[];
  } catch {
    return null;
  }
}

export function parseRunEdges(
  edgesJson: string | undefined,
): FlowEdge[] | null {
  if (!edgesJson?.trim()) return null;
  try {
    const parsed = JSON.parse(edgesJson) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as FlowEdge[];
  } catch {
    return null;
  }
}

type OutputPayload = {
  summary?: string;
  data?: Record<string, unknown>;
  artifacts?: Artifact[];
  threadId?: string;
  status?: string;
};

/**
 * Build the node snapshot persisted with a run — statuses, structured outputs,
 * artifacts, and thread ids only (no hidden reasoning).
 */
export function buildPersistedRunNodes(
  baseNodes: FlowNode[],
  outputs: Record<string, OutputPayload | undefined>,
  completed: Set<string>,
  skipped: Set<string>,
): FlowNode[] {
  return baseNodes.map((node) => {
    const payload = outputs[node.id];
    let status: Status = node.data.status;
    if (completed.has(node.id)) status = "completed";
    else if (skipped.has(node.id)) {
      status =
        node.data.status === "failed" || node.data.status === "interrupted"
          ? node.data.status
          : "skipped";
    } else if (
      node.data.status === "running" ||
      node.data.status === "queued" ||
      node.data.status === "approval"
    ) {
      status = "interrupted";
    }
    const artifacts = (payload?.artifacts ??
      node.data.artifacts ??
      []) as Artifact[];
    return {
      ...node,
      data: {
        ...node.data,
        status,
        output: payload?.summary ?? node.data.output,
        structuredOutput: payload?.data ?? node.data.structuredOutput,
        artifacts,
        threadId:
          payload?.threadId ??
          (payload?.data?.threadId as string | undefined) ??
          node.data.threadId,
        // Drop aperture flags — display-only and must not stick across inspect.
        dimmed: false,
        highlighted: false,
      },
    };
  });
}

/** Result of rehydrating a run for the inspector/canvas. */
export type RunRehydration = {
  events: RunEvent[];
  nodes: FlowNode[] | null;
  /** null = field missing (keep canvas edges); array = explicit snapshot (may be empty). */
  edges: FlowEdge[] | null;
  deliveryArtifactPresent: boolean;
};

/**
 * Startup auto-load may apply a saved workflow only while the user has not
 * already Seeded, edited, or otherwise mutated the canvas after first paint.
 */
export function shouldApplyAutoloadSnapshot(
  userMutatedWorkflow: boolean,
): boolean {
  return !userMutatedWorkflow;
}

/**
 * Inspect rehydration should replace canvas edges only when the run snapshot
 * included an edges field. `null` keeps the current graph; `[]` is a valid
 * empty-edge workflow and must apply without relying on array truthiness.
 */
export function shouldReplaceEdgesFromRun(
  edges: FlowEdge[] | null | undefined,
): edges is FlowEdge[] {
  return edges != null;
}

export function rehydrateRunRecord(record: RunRecord): RunRehydration {
  const events = parseRunEvents(record.eventsJson);
  const nodes = parseRunNodes(record.nodesJson);
  const edges = parseRunEdges(record.edgesJson);
  const deliveryArtifactPresent = Boolean(
    nodes?.some((node) =>
      (node.data.artifacts ?? []).some(
        (artifact) =>
          artifact.name === "delivery-bundle.json" &&
          Boolean(artifact.content && artifact.content !== "{}"),
      ),
    ),
  );
  return { events, nodes, edges, deliveryArtifactPresent };
}
