/**
 * Node inspection and learning tool handlers for the company mediator.
 *
 * Extracted from company-mediator-tools.ts as a cohesive group: all node_*
 * tools share the `resolveNode` helper and operate on graph node state.
 */

import type { FlowNode } from "./model";
import { ensureCompletionCriteria } from "./completion-criteria";
import { listNodeExperience, formatExperienceDigest } from "./node-experience";
import {
  listHarnessLessons,
  refineHarnessLessons,
  formatLessonDigest,
} from "./harness-lessons";
import { ok, fail, trunc, type ToolExecResult } from "./tool-helpers";
import type { MediatorHostContext } from "./company-mediator-tools";

export function resolveNode(
  ctx: MediatorHostContext,
  args: { nodeId?: string; label?: string },
): {
  node?: FlowNode;
  error?: string;
  candidates?: Array<{ id: string; label: string }>;
} {
  const id = args.nodeId?.trim();
  if (id) {
    const byId = ctx.nodes.find((n) => n.id === id);
    if (byId) return { node: byId };
  }
  const q = (args.label ?? args.nodeId ?? "").trim().toLowerCase();
  if (!q) return { error: "Provide nodeId or label" };
  const matches = ctx.nodes.filter((n) => {
    const label = n.data.label.toLowerCase();
    const role = n.data.role.toLowerCase();
    return (
      n.id.toLowerCase() === q ||
      label === q ||
      role === q ||
      label.includes(q) ||
      role.includes(q)
    );
  });
  if (matches.length === 1) return { node: matches[0] };
  if (matches.length > 1) {
    return {
      error: "Ambiguous node match",
      candidates: matches.map((n) => ({ id: n.id, label: n.data.label })),
    };
  }
  return { error: `No node matched "${q}"` };
}

/**
 * Execute a node_* tool by name. Returns null if the tool name is not a node
 * handler, so the caller can fall through to other handlers.
 */
export async function executeNodeHandler(
  name: string,
  args: Record<string, unknown>,
  ctx: MediatorHostContext,
): Promise<ToolExecResult | null> {
  const str = (k: string) =>
    typeof args[k] === "string" ? (args[k] as string) : undefined;
  const num = (k: string) =>
    typeof args[k] === "number" ? (args[k] as number) : undefined;

  if (name === "node_focus") {
    const resolved = resolveNode(ctx, {
      nodeId: str("nodeId"),
      label: str("label"),
    });
    if (resolved.error) {
      return fail(
        resolved.candidates
          ? `${resolved.error}: ${JSON.stringify(resolved.candidates)}`
          : resolved.error,
      );
    }
    const node = resolved.node!;
    ctx.actions?.focusNode?.(node.id);
    return ok({ focused: node.id, label: node.data.label });
  }

  // All remaining node_* tools require node resolution
  const nodeNames = new Set([
    "node_get",
    "node_get_output",
    "node_get_trace",
    "node_get_criteria",
    "node_get_events",
    "node_task_progress",
    "node_get_experience",
    "node_refine_lessons",
    "node_list_lessons",
  ]);
  if (!nodeNames.has(name)) return null;

  const resolved = resolveNode(ctx, {
    nodeId: str("nodeId"),
    label: str("label"),
  });
  if (resolved.error) {
    return fail(
      resolved.candidates
        ? `${resolved.error}: ${JSON.stringify(resolved.candidates)}`
        : resolved.error,
    );
  }
  const node = resolved.node!;

  if (name === "node_get") {
    return ok({
      id: node.id,
      label: node.data.label,
      role: node.data.role,
      kind: node.data.kind,
      status: node.data.status,
      model: node.data.model,
      effort: node.data.effort,
      sandbox: node.data.sandboxProfile,
      tools: node.data.tools,
      promptExcerpt: trunc(node.data.prompt ?? "", 800),
      revisions: node.data.revisions ?? 0,
      retries: node.data.retries ?? 0,
      threadId: node.data.threadId,
      duration: node.data.duration,
      tokens: node.data.tokens,
    });
  }

  if (name === "node_get_output") {
    const arts = (node.data.artifacts ?? []).map((a) => ({
      name: a.name,
      kind: a.kind,
      preview: a.content ? trunc(a.content, 200) : undefined,
    }));
    return ok({
      id: node.id,
      status: node.data.status,
      summary: node.data.output ?? null,
      structuredOutput: trunc(
        JSON.stringify(node.data.structuredOutput ?? {}),
        1500,
      ),
      artifacts: arts,
    });
  }

  if (name === "node_get_trace") {
    const limit = Math.min(num("limit") ?? 20, 50);
    return ok({
      id: node.id,
      trace: (node.data.trace ?? []).slice(-limit),
    });
  }

  if (name === "node_get_criteria") {
    return ok({
      id: node.id,
      criteria: ensureCompletionCriteria(node.data.completionCriteria),
      evaluation: node.data.criteriaEvaluation ?? [],
    });
  }

  if (name === "node_get_events") {
    const limit = Math.min(num("limit") ?? 20, 50);
    const ev = ctx.events
      .filter((e) => e.nodeId === node.id)
      .slice(-limit)
      .map((e) => ({
        type: e.type,
        message: e.message,
        level: e.level,
        at: e.at,
      }));
    return ok({ id: node.id, events: ev });
  }

  if (name === "node_get_experience") {
    const records = await listNodeExperience({
      workflowId: ctx.workflowId,
      nodeId: node.id,
      role: node.data.role,
      model: node.data.model,
      effort: node.data.effort,
    });
    return ok({
      id: node.id,
      role: node.data.role,
      model: node.data.model,
      effort: node.data.effort,
      digest: formatExperienceDigest(records),
      records: records.slice(0, 20),
    });
  }

  if (name === "node_refine_lessons") {
    const result = await refineHarnessLessons(ctx.workflowId);
    return ok({ workflowId: ctx.workflowId, ...result });
  }

  if (name === "node_list_lessons") {
    const lessons = await listHarnessLessons({
      role: node.data.role,
      model: node.data.model,
      effort: node.data.effort,
    });
    return ok({
      id: node.id,
      role: node.data.role,
      model: node.data.model,
      effort: node.data.effort,
      digest: formatLessonDigest(lessons),
      lessons,
    });
  }

  // node_task_progress
  {
    const criteria = ensureCompletionCriteria(node.data.completionCriteria);
    const evals = node.data.criteriaEvaluation ?? [];
    const enabled = criteria.filter((c) => c.enabled);
    const passed = evals.filter((e) => e.status === "pass").length;
    const failed = evals.filter((e) => e.status === "fail").length;
    const lastErr = [...ctx.events]
      .reverse()
      .find(
        (e) =>
          e.nodeId === node.id &&
          (e.level === "error" ||
            /fail/i.test(e.type) ||
            /fail/i.test(e.message)),
      );
    return ok({
      id: node.id,
      label: node.data.label,
      role: node.data.role,
      status: node.data.status,
      allottedTaskExcerpt: trunc(node.data.prompt ?? "", 600),
      hasOutput: Boolean(node.data.output?.trim()),
      outputSummary: node.data.output
        ? trunc(node.data.output, 400)
        : null,
      criteriaEnabled: enabled.length,
      criteriaPassed: passed,
      criteriaFailed: failed,
      criteriaPending: enabled.length - passed - failed,
      revisions: node.data.revisions ?? 0,
      lastError: lastErr
        ? { type: lastErr.type, message: lastErr.message, at: lastErr.at }
        : null,
      artifactCount: node.data.artifacts?.length ?? 0,
    });
  }
}
