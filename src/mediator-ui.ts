/**
 * Company mediator control plane (not a graph node).
 * Types + pure helpers for notifications, question modals, and approval modals.
 */

import type { RunEvent, StructuredApproval } from "./model";

export type MediatorNotificationLevel =
  "info" | "warning" | "error" | "success";

export type MediatorNotification = {
  id: string;
  at: string;
  title: string;
  body: string;
  level: MediatorNotificationLevel;
  /** Graph node to focus, if any. */
  nodeId?: string;
  runId?: string;
  eventType?: string;
};

export type MediatorQuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type MediatorQuestion = {
  id: string;
  title: string;
  body: string;
  options?: MediatorQuestionOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  optionsOnly?: boolean;
  placeholder?: string;
  secret?: boolean;
  blocksRun?: boolean;
  source: "mediator" | "approval-node" | "specialist-request";
};

export type MediatorQuestionAnswer = {
  questionId: string;
  optionIds: string[];
  freeText?: string;
  at: string;
};

export type MediatorConfirmation = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
};

/**
 * Actions that Byte may request must pause for an explicit in-app decision.
 * Read-only mediator tools intentionally return null and continue directly.
 */
export function mediatorToolConfirmation(
  tool: string,
): MediatorConfirmation | null {
  switch (tool) {
    case "company_run":
      return {
        title: "Allow Byte to run?",
        body: "Byte requested permission to start the current workflow.",
        confirmLabel: "Run workflow",
        cancelLabel: "Cancel",
      };
    case "company_run_from":
      return {
        title: "Allow Byte to run from this node?",
        body: "Byte requested permission to start from this node and intentionally skip its ancestors.",
        confirmLabel: "Start from node",
        cancelLabel: "Cancel",
      };
    case "company_approve":
      return {
        title: "Allow Byte to approve?",
        body: "Byte requested permission to approve the pending human gate.",
        confirmLabel: "Approve",
        cancelLabel: "Cancel",
      };
    case "company_decline":
      return {
        title: "Allow Byte to decline?",
        body: "Byte requested permission to decline the pending human gate.",
        confirmLabel: "Decline",
        cancelLabel: "Cancel",
      };
    default:
      return null;
  }
}

/** Lifecycle events that should surface as chat progress + optional toast. */
export function isLifecycleRunEvent(type: string): boolean {
  return (
    type === "node.started" ||
    type === "node.attempt.started" ||
    type === "node.completed" ||
    type === "node.attempt.completed" ||
    type === "node.failed" ||
    type === "node.attempt.failed" ||
    type === "node.revision" ||
    type === "run.started" ||
    type === "run.completed" ||
    type === "run.interrupted" ||
    type === "approval.requested" ||
    type === "approval.autorun" ||
    type === "approval.declined" ||
    type === "approval.approved" ||
    type.startsWith("revision.")
  );
}

/**
 * Raw app-server notifications are useful for the node's live trace, but only
 * bounded lifecycle transitions belong in the execution timeline. In
 * particular, agent-message deltas may contain a single token and must never
 * become one timeline row per notification.
 */
export function isCodexAgentLifecycleEvent(type: string): boolean {
  if (!type) return false;
  if (
    type.endsWith("/delta") ||
    type.includes("reasoning") ||
    type.includes("tokenUsage")
  ) {
    return false;
  }
  return (
    type === "thread/started" ||
    type === "turn/started" ||
    type === "turn/completed" ||
    type === "turn/failed" ||
    type === "turn/interrupted" ||
    type === "item/started" ||
    type === "item/completed" ||
    type.includes("approval") ||
    type.includes("error") ||
    type.includes("timeout")
  );
}

export function notificationLevelForEvent(
  type: string,
  level?: string,
): MediatorNotificationLevel {
  if (level === "error" || type === "node.failed") return "error";
  if (
    level === "warning" ||
    type === "node.revision" ||
    type.includes("approval") ||
    type === "run.interrupted"
  )
    return "warning";
  if (type === "node.completed" || type === "run.completed") return "success";
  return "info";
}

export function progressLineFromRunEvent(event: RunEvent): string | null {
  if (!isLifecycleRunEvent(event.type)) return null;
  const msg = (event.message || "").trim();
  if (event.type === "node.started" || event.type === "node.attempt.started") {
    return `**In progress:** ${msg || event.nodeId || "node"}`;
  }
  if (
    event.type === "node.completed" ||
    event.type === "node.attempt.completed"
  ) {
    return `**Completed:** ${msg || event.nodeId || "node"}`;
  }
  if (event.type === "node.failed" || event.type === "node.attempt.failed") {
    return `**Failed:** ${msg || event.nodeId || "node"}`;
  }
  if (event.type === "node.revision" || event.type.startsWith("revision.")) {
    return `**Revision:** ${msg || event.nodeId || "node"}`;
  }
  if (event.type.includes("approval") || event.type === "approval.autorun") {
    return `**Approval:** ${msg || "checkpoint"}`;
  }
  if (event.type === "run.started") return `**Run started** ${msg}`.trim();
  if (event.type === "run.completed") return `**Run finished** ${msg}`.trim();
  if (event.type === "run.interrupted")
    return `**Run interrupted** ${msg}`.trim();
  return msg || null;
}

export function notificationFromRunEvent(
  event: RunEvent,
  runId?: string,
): MediatorNotification | null {
  const line = progressLineFromRunEvent(event);
  if (!line) return null;
  const plain = line.replace(/\*\*/g, "");
  return {
    id: event.id || crypto.randomUUID(),
    at: event.at || new Date().toISOString(),
    title: plain.split(":")[0] || "Company",
    body: plain,
    level: notificationLevelForEvent(event.type, event.level),
    nodeId: event.nodeId,
    runId,
    eventType: event.type,
  };
}

export function formatQuestionAnswerForChat(
  question: MediatorQuestion,
  answer: MediatorQuestionAnswer,
): string {
  const labels =
    question.options
      ?.filter((o) => answer.optionIds.includes(o.id))
      .map((o) => o.label) ?? [];
  const parts = [
    `Answered **${question.title}**`,
    labels.length ? `Options: ${labels.join(", ")}` : null,
    answer.freeText?.trim() ? `Note: ${answer.freeText.trim()}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export type ChatRunIntent =
  | { kind: "status" }
  | { kind: "run"; mission?: string }
  | { kind: "stop" }
  | { kind: "approve" }
  | { kind: "decline" }
  | { kind: "set_mission"; mission: string }
  | { kind: "help" }
  | { kind: "unknown" };

/** Lightweight intent parse for mediator control (not a graph node). */
export function parseMediatorControlIntent(raw: string): ChatRunIntent {
  const q = raw.trim();
  const lower = q.toLowerCase();
  if (!q) return { kind: "unknown" };
  if (/^(status|progress|where|state)\b/.test(lower) || lower === "status")
    return { kind: "status" };
  if (/^(stop|cancel|abort|interrupt)\b/.test(lower)) return { kind: "stop" };
  if (/^(approve|accept|lgtm|ship it)\b/.test(lower))
    return { kind: "approve" };
  if (/^(decline|reject|deny)\b/.test(lower)) return { kind: "decline" };
  const setMission = q.match(
    /^(?:set\s+mission|mission)\s*[:\-]\s*([\s\S]+)$/i,
  );
  if (setMission?.[1]?.trim())
    return { kind: "set_mission", mission: setMission[1].trim() };
  const runWith = q.match(
    /^(?:run|start|execute)(?:\s+with)?\s*[:\-]\s*([\s\S]+)$/i,
  );
  if (runWith?.[1]?.trim()) return { kind: "run", mission: runWith[1].trim() };
  if (/^(run|start|execute|launch)\b/.test(lower)) return { kind: "run" };
  if (/^(help|commands|\?)$/.test(lower)) return { kind: "help" };
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Structured approval parsing
// ---------------------------------------------------------------------------

export function parseStructuredApproval(
  method: string,
  params: Record<string, unknown>,
): StructuredApproval {
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    return {
      kind: "fileChange",
      files: [],
      reason: (params.reason as string) ?? null,
      grantRoot: (params.grantRoot as string) ?? null,
    };
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    const command = Array.isArray(params.command)
      ? (params.command as string[]).join(" ")
      : typeof params.command === "string"
        ? params.command
        : "";
    return {
      kind: "execCommand",
      command,
      cwd: (params.cwd as string) ?? ".",
      reason: (params.reason as string) ?? null,
      commandActions: Array.isArray(params.commandActions)
        ? (params.commandActions as {
            type: string;
            command: string;
            name?: string;
            path?: string | null;
            query?: string | null;
          }[])
        : undefined,
      additionalPermissions: params.additionalPermissions,
      availableDecisions: Array.isArray(params.availableDecisions)
        ? params.availableDecisions.map(String)
        : undefined,
    };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      permissions: params.permissions,
      reason: (params.reason as string) ?? null,
    };
  }
  return { kind: "unknown" };
}

export function mediatorControlHelpText(): string {
  return [
    "Byte commands:",
    "• **status** — who is in progress / completed / blocked",
    "• **run** — start the company (uses Mission brief)",
    "• **run with:** _mission text_ — update Mission brief then run",
    "• **mission:** _text_ — update Mission brief only",
    "• **stop** — interrupt the active run",
    "• **approve** / **decline** — resolve the open human gate",
  ].join("\n");
}
