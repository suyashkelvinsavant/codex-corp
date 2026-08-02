import {
  DEFAULT_MAX_REVISIONS,
  type Artifact,
  type FlowEdge,
  type FlowNode,
  type RunEvent,
  type RunRecord,
  type Status,
  type WorkflowSnapshot,
} from "./model";
import { getPack } from "./node-packs/packs";
import {
  deliveryStatusFromRun,
  type DeliveryPreviewStatus,
} from "./delivery-bundle";
import { missionBriefStatus } from "./mission-context";

export const WORKFLOW_ID = "software-company";
/** Legacy browser key for the original software-company workflow (back-compat). */
export const WORKFLOW_STORAGE_KEY = "codex-corp-workflow";
export const ACTIVE_WORKFLOW_KEY = "codex-corp-active-workflow";
export const RUNS_STORAGE_KEY = "codex-corp-runs";
export const WORKFLOW_SCHEMA_VERSION = 4 as const;

export type LoadedWorkflowState = {
  graphJson: string;
  workspacePath: string | null;
};

/** Normalize current native records and legacy raw graph payloads at one boundary. */
export function normalizeLoadedWorkflowState(
  value: unknown,
): LoadedWorkflowState | null {
  if (typeof value === "string") {
    return { graphJson: value, workspacePath: null };
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    graphJson?: unknown;
    workspacePath?: unknown;
  };
  if (typeof candidate.graphJson !== "string") return null;
  const workspacePath =
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.trim().length > 0
      ? candidate.workspacePath.trim()
      : null;
  return { graphJson: candidate.graphJson, workspacePath };
}

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
  const sourceVersion = snapshot.schemaVersion ?? 1;
  const isPreApprovalGateSnapshot = sourceVersion < 2;
  const resetLegacyApproval =
    isPreApprovalGateSnapshot &&
    snapshot.nodes.some(
      (node) =>
        (node.data.kind === "agent" || node.data.kind === "creative") &&
        node.data.requiresApproval === true,
    );
  const repairedMissingRevisionLimit = snapshot.edges.some(
    (edge) =>
      edge.data?.edgeType === "revision" &&
      edge.data.maxRevisions === undefined,
  );
  const migrationNotices: string[] = [];
  let removedPackSkillHints = false;
  let repairedMissionStatus = false;
  const affectedSoftwareCompanyPolicy =
    sourceVersion === 2 &&
    isAffectedSoftwareCompanyPolicy(snapshot.nodes, snapshot.edges);
  const hasLegacyDeliveryControl =
    sourceVersion < 4 && snapshot.nodes.some(isLegacyDeliveryControl);
  if (resetLegacyApproval) {
    migrationNotices.push(
      "Legacy specialist approval flags were reset because they were not runtime gates before workflow schema v2.",
    );
  }
  if (repairedMissingRevisionLimit) {
    migrationNotices.push(
      "Added the missing revision limit to an affected saved workflow.",
    );
  }
  if (affectedSoftwareCompanyPolicy) {
    migrationNotices.push(
      "Restored on-request approvals for the affected Software Company workflow so dependency setup can request permission.",
    );
  }
  if (hasLegacyDeliveryControl) {
    migrationNotices.push(
      "Renamed the default Delivery control to Release Bundle and clarified its verified handoff purpose.",
    );
  }
  const nodes = snapshot.nodes.map((node) => {
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
        ...(data.kind === "input" &&
        data.status === "completed" &&
        missionBriefStatus(data.output) === "idle"
          ? (() => {
              repairedMissionStatus = true;
              return { status: "idle" as const };
            })()
          : {}),
        ...(sourceVersion < 4 && isLegacyDeliveryControl(node)
          ? {
              label: "Release Bundle",
              role: "Verified handoff",
              prompt:
                "After explicit approval, compare approved artifact hashes with the live artifact set and create a tamper-evident release bundle.",
              description:
                "Deterministically compares approved artifact hashes with live outputs and packages the verified, tamper-evident handoff. This is not an AI agent.",
            }
          : {}),
        ...(sourceVersion < 4 && data.packId && Array.isArray(data.skills)
          ? (() => {
              const hints = new Set(getPack(data.packId)?.skillHints ?? []);
              const skills = data.skills.filter(
                (skill) => typeof skill === "string" && !hints.has(skill),
              );
              if (skills.length !== data.skills.length) {
                removedPackSkillHints = true;
              }
              return { skills };
            })()
          : {}),
        workspacePolicy:
          legacy.workspacePolicy === "workflow" ? "workflow" : "isolated",
        // Before schema v2 this flag was decorative. Do not silently turn an
        // old saved graph into a blocking post-node approval workflow.
        ...(isPreApprovalGateSnapshot ? { requiresApproval: false } : {}),
        ...(affectedSoftwareCompanyPolicy &&
        (data.kind === "agent" || data.kind === "creative")
          ? { approvalPolicy: "on-request" as const }
          : {}),
      },
    } as FlowNode;
  });
  if (removedPackSkillHints) {
    migrationNotices.push(
      "Removed obsolete role skill hints from saved specialists; connector skills must be selected from the live workspace inventory.",
    );
  }
  if (repairedMissionStatus) {
    migrationNotices.push(
      "Reset an unconfirmed Mission brief to idle; a template seed is not completed work.",
    );
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    nodes,
    edges: snapshot.edges.map((edge) =>
      edge.data?.edgeType === "revision" && edge.data.maxRevisions === undefined
        ? {
            ...edge,
            data: { ...edge.data, maxRevisions: DEFAULT_MAX_REVISIONS },
          }
        : edge,
    ),
    ...(migrationNotices.length ? { migrationNotices } : {}),
  };
}

function isLegacyDeliveryControl(node: FlowNode): boolean {
  return (
    node.data.kind === "output" &&
    node.data.label === "Delivery" &&
    node.data.role === "Control" &&
    node.data.model === "Collector"
  );
}

function isAffectedSoftwareCompanyPolicy(
  nodes: FlowNode[],
  edges: FlowEdge[],
): boolean {
  const expectedPacks = new Map([
    ["pm", "product-manager"],
    ["architect", "architect"],
    ["builder", "frontend-engineer"],
    ["qa", "qa-engineer"],
  ]);
  const specialists = nodes.filter((node) => expectedPacks.has(node.id));
  if (specialists.length !== expectedPacks.size) return false;
  if (
    !specialists.every(
      (node) =>
        node.data.packId === expectedPacks.get(node.id) &&
        node.data.approvalPolicy === "never" &&
        node.data.sandboxProfile === "workspace-write" &&
        node.data.workspacePolicy === "workflow",
    )
  ) {
    return false;
  }
  return edges.some(
    (edge) =>
      edge.source === "qa" &&
      edge.target === "builder" &&
      edge.data?.edgeType === "revision",
  );
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
      (typeof parsed.schemaVersion !== "number" ||
        !Number.isInteger(parsed.schemaVersion) ||
        parsed.schemaVersion < 1 ||
        parsed.schemaVersion > WORKFLOW_SCHEMA_VERSION)
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
  /** Fail-closed delivery status (P5): derived from the run's output node
   *  verificationSummary + pair-compare, never contradicting a failed run. */
  deliveryStatus: DeliveryPreviewStatus;
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
  // P5: the run-inspector chip derives the same fail-closed Delivery status as
  // the overview list — from the output node's verificationSummary + pair-compare.
  const deliveryStatus = deliveryStatusFromRun({
    runStatus: record.status,
    nodesJson: record.nodesJson,
  });
  return { events, nodes, edges, deliveryArtifactPresent, deliveryStatus };
}
