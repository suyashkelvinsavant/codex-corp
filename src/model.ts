import type { Edge, Node } from "@xyflow/react";
import { z } from "zod";
import type {
  CompletionCriterion,
  CriterionEvaluation,
} from "./completion-criteria";

export const AgentOutputSchema = z.object({
  status: z.enum(["success", "failure", "needs_revision"]),
  summary: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  artifacts: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        kind: z.enum(["code", "document", "json", "image", "link"]).optional(),
        type: z.enum(["code", "document", "json", "image", "link"]).optional(),
        content: z.string().optional(),
      }),
    )
    .default([]),
});

export type Status =
  | "draft"
  | "invalid"
  | "idle"
  | "queued"
  | "running"
  | "approval"
  | "completed"
  | "needs_revision"
  | "failed"
  | "interrupted"
  | "skipped";

export type Kind =
  | "agent"
  | "creative"
  | "cron"
  | "input"
  | "approval"
  | "condition"
  | "merge"
  | "output"
  | "note";
export type EdgeKind =
  "standard" | "revision" | "approval" | "conditional" | "merge";

/** True for nodes that run isolated Codex-style specialist threads. */
export function isSpecialistKind(kind: Kind): boolean {
  return kind === "agent" || kind === "creative";
}

export type Artifact = {
  id: string;
  name: string;
  kind: "code" | "document" | "json" | "image" | "link";
  content?: string;
  /** Host-assigned after materialize. */
  hostOrdinal?: number;
  artifactKey?: string;
  contentHash?: string;
};

export type AgentData = {
  label: string;
  role: string;
  kind: Kind;
  status: Status;
  model: string;
  /** Reasoning effort — Codex may advertise low/medium/high/xhigh/max/ultra. */
  effort: string;
  tools: string[];
  /** MCP tools selected from the live Codex connector inventory (advisory). */
  connectorTools?: string[];
  /** Named permission profile returned by permissionProfile/list. */
  permissionProfile?: string;
  /** Optional connector collaboration preset for the turn. */
  collaborationMode?: "default" | "plan";
  /** Codex response style applied at thread and turn level. */
  personality?: "none" | "friendly" | "pragmatic";
  /**
   * @deprecated Prefer `developerInstructions` (+ `baseInstructions`).
   * Kept as a legacy mirror of the developer role contract for older graphs.
   */
  prompt: string;
  /** Authored harness-like base; empty = opt-in native Codex base. */
  baseInstructions?: string;
  /** Role/developer contract for this specialist. */
  developerInstructions?: string;
  /** Builtin pack id when instantiated from the role catalog. */
  packId?: string;
  packVersion?: string;
  description: string;
  duration: string;
  tokens: number;
  trace: string[];
  /** Ephemeral, bounded assistant text assembled from app-server deltas. */
  streamingPreview?: string;
  output?: string;
  structuredOutput?: Record<string, unknown>;
  inputSchema?: string;
  outputSchema?: string;
  artifacts?: Artifact[];
  requiresApproval?: boolean;
  revisions?: number;
  maxRevisions?: number;
  retries?: number;
  maxRetries?: number;
  timeoutSeconds?: number;
  memoryMode?: "none" | "workflow" | "persistent";
  workspacePolicy?: "isolated" | "workflow" | "custom";
  approvalPolicy?: "on-request" | "untrusted" | "never";
  sandboxProfile?: "read-only" | "workspace-write";
  environmentVariables?: string[];
  condition?: string;
  conditionRule?: ConditionRule;
  /** Skills selected from the live Codex connector inventory. */
  skills?: string[];
  /** Primary connector skill used for this run. */
  activeSkill?: string;
  /**
   * Mission Brief (`input`) only: where the authorized mission text came from.
   * Chat mediator writes `chat`; inspector/manual edit uses `manual`.
   */
  missionSource?: "manual" | "chat" | "template";
  /** Mediator session that last set the mission (optional). */
  chatSessionId?: string;
  /** Structured constraints attached via chat or inspector. */
  missionConstraints?: string[];
  /** Acceptance notes / DoD for specialists. */
  acceptanceNotes?: string;
  /** ISO timestamp of last mission edit. */
  missionUpdatedAt?: string;
  /** Cron Trigger only: standard five-field cron expression. */
  cronExpression?: string;
  /** Cron Trigger only: IANA timezone used for matching. */
  cronTimezone?: string;
  /** Cron Trigger only: disabled schedules remain on canvas but do not fire. */
  cronEnabled?: boolean;
  /**
   * Per-specialist completion criteria (platform + custom).
   * Injected into system prompt; evaluated after each run.
   */
  completionCriteria?: CompletionCriterion[];
  /** Last post-run evaluation of completionCriteria. */
  criteriaEvaluation?: CriterionEvaluation[];
  color: string;
  threadId?: string;
  dimmed?: boolean;
  highlighted?: boolean;
  validationErrors?: string[];
  contextInputs?: number;
};

export type ConditionOperator =
  "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "exists";

export type ConditionRule = {
  sourceNodeId?: string;
  path: string;
  operator: ConditionOperator;
  value?: unknown;
  trueBranch: string;
  falseBranch: string;
};

export type EdgeData = {
  edgeType: EdgeKind;
  highlighted?: boolean;
  dimmed?: boolean;
  condition?: string;
  mapping?: Record<string, string>;
  maxRevisions?: number;
};

export type FlowNode = Node<AgentData>;
export type FlowEdge = Edge<EdgeData>;

export type WorkflowSnapshot = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type ValidationProblem = {
  id: string;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type RunEvent = {
  id: string;
  at: string;
  type: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  level?: "info" | "warning" | "error";
};

export type ApprovalRequest = {
  id: string;
  nodeId: string;
  title: string;
  detail: string;
  risk: string;
  status: "pending" | "approved" | "declined";
  nativeRequestId?: string;
  runId?: string;
};

export type RunRecord = {
  id: string;
  workflowId: string;
  status: string;
  createdAt: string;
  eventsJson?: string;
  /** Full graph nodes with per-run statuses, outputs, and artifacts (no CoT). */
  nodesJson?: string;
  /** Edges at the time of the run, for faithful rehydration. */
  edgesJson?: string;
  terminalReason?: string;
  resumable?: boolean;
  pinned?: boolean;
  lastEventSequence?: number;
};

export type CodexInfo = {
  found: boolean;
  version?: string;
  executable?: string;
  appServerAvailable?: boolean;
  compatible: boolean;
  supportedRange?: string;
  lastTestedVersion?: string;
  selectedSource?: string;
  fallbackAvailable?: boolean;
  incompatibilityReason?: string;
  compatibilityWarning?: string;
  capabilities?: string[];
};
