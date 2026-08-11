/**
 * Dynamic tools for the company chat mediator (Live Codex).
 * Natural language → model tool calls → host executes against graph state.
 */

import type {
  ApprovalRequest,
  FlowEdge,
  FlowNode,
  RunEvent,
  RunRecord,
} from "./model";
import { ensureCompletionCriteria } from "./completion-criteria";
import { composeAuthorizedMission } from "./mission-context";
import type { MediatorQuestion, MediatorQuestionAnswer } from "./mediator-ui";
import type { LocalTestSession } from "./local-test";
import type { AppProjectMode, AppWorkspaceSelection } from "./workflow-chat";
import { ok, fail, trunc, type DynamicToolSpecJson, type ToolExecResult } from "./tool-helpers";
import { executeNodeHandler, resolveNode } from "./company-node-handlers";

// Re-export shared types for backward compatibility.
export type { DynamicToolSpecJson, ToolExecResult };

export const COMPANY_MEDIATOR_SYSTEM_PROMPT = `You are Byte for Codex Corp — the human-facing companion for a multi-specialist company graph (not a graph node yourself).

## Core job
Steer the company with **tools** and talk to the operator. You do **not** implement product code.

## Requirements-first (critical)
- Greetings and vague openers ("hi", "hello", "hey") are **not** build orders.
- Questions about the workflow, its nodes, status, capabilities, or how it works do **not** need an app folder.
- Call company_select_app_workspace only after the operator clearly asks to create/build/scaffold a software project or modify/fix/refactor an existing project. Never call it for greetings, general information, workflow inspection, brainstorming, or ambiguous requests.
- A direct build request that names the product or feature is minimally actionable even when optional details are omitted. For example, "create a simple fish bowl shop website" is actionable. Use conservative defaults for unspecified presentation details.
- After company_select_app_workspace returns a selection for a new app, compose a concrete mission from the operator's request, the selected folder, and conservative defaults, then call company_run. The host confirmation for company_run is the operator's confirmation.
- Do not ask optional scope or style questions before starting an actionable new-app request. Ask only when a missing decision materially affects safety, irreversible data changes, billing, authentication, or mutually incompatible product behavior.
- For an existing app, establish what should change and what must be preserved. Include material folder constraints in the mission before starting the company.
- Do **not** treat a preloaded MISSION brief as confirmed user intent. Template seeds or leftover mission text are **hypotheses** until the operator affirms or replaces them.
- Ask short, concrete questions when the mission is empty, genuinely ambiguous, or only a seed. Optional catalog contents, visual style, and similar refinements can be decided by the specialists unless the operator specified them.
- Only after the operator has a clear mission may you offer to **set mission** and **run** the company.

## Tools
- Never invent run status, failures, node outputs, or artifacts — call tools first (company_status, company_list_nodes, node_*).
- For failures, treat the runtime-owned criteria evaluation and terminal reason as the source of truth; traces are supporting evidence only. If a summary conflicts with verification, report the conflict and the verified result.
- Only say the run started when company_run returns started: true. If the tool fails or returns started: false, report that exact result and do not claim a run began.
- company_run / company_run_from / company_stop / company_set_mission / approval tools for control.
- After a completed Release Bundle, report the local-test status from company_status. The operator must launch, test, and approve or give concrete feedback; never claim the app was tested without that evidence.
- company_ask_operator for blocking structured questions when a decision is missing.
- company_list_nodes + node_get / node_get_trace / node_get_events / node_get_experience / node_task_progress for inspection. Call node_get_experience when a node has repeated failures to see its historical outcomes and recurring failure classes. After a run with recurring failures, call node_refine_lessons to produce durable, versioned harness lessons that are prepended to the specialist's developer instructions on future runs; call node_list_lessons to inspect the active lessons for a node's pattern before advising prompt changes.

## Style
Brief, accurate markdown. No marketing fluff. No assumed product (landing page, app type, stack) unless the operator stated it.`;

export type MediatorHostContext = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  events: RunEvent[];
  running: boolean;
  runId: string | null;
  workflowId: string;
  approvals: ApprovalRequest[];
  localTest?: LocalTestSession | null;
  runHistory: RunRecord[];
  /** Side effects — optional for pure unit tests */
  actions?: {
    run?: (mission?: string) => Promise<boolean> | boolean;
    stop?: () => Promise<void> | void;
    setMission?: (mission: string) => void;
    approve?: () => Promise<void> | void;
    decline?: () => Promise<void> | void;
    focusNode?: (nodeId: string) => void;
    runFrom?: (nodeId: string) => Promise<boolean> | boolean;
    askOperator?: (
      question: MediatorQuestion,
    ) => Promise<MediatorQuestionAnswer | null>;
    selectAppWorkspace?: (
      suggestedMode: AppProjectMode,
    ) => Promise<AppWorkspaceSelection | null>;
  };
};

export function companyMediatorDynamicTools(): DynamicToolSpecJson[] {
  const emptyObject = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const nodeRef = {
    type: "object",
    properties: {
      nodeId: { type: "string", description: "Graph node id if known" },
      label: {
        type: "string",
        description: "Node label or role substring, e.g. Builder, Quality Gate",
      },
    },
    additionalProperties: false,
  };
  return [
    {
      type: "function",
      name: "company_select_app_workspace",
      description:
        "Open the app-context and folder picker. Call this ONLY after the operator clearly expresses intent to create/build/scaffold a new software project or modify/fix/refactor an existing project. Do NOT call for greetings (for example: hi), workflow information, status/capability questions, general advice, brainstorming, research, or any request that does not require working in a local app folder. Set suggestedMode to new for a new project and existing for changes to an existing project.",
      inputSchema: {
        type: "object",
        properties: {
          suggestedMode: {
            type: "string",
            enum: ["new", "existing"],
            description:
              "The project intent already inferred from the operator's request.",
          },
        },
        required: ["suggestedMode"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "company_status",
      description:
        "Overall company run status, progress, pending approvals, terminal reason, and runtime-owned criteria failures when available.",
      inputSchema: emptyObject,
    },
    {
      type: "function",
      name: "company_run",
      description:
        "Start the company workflow. Pass a concrete mission for a new or changed request; omit it only when the current Mission brief was already confirmed.",
      inputSchema: {
        type: "object",
        properties: {
          mission: {
            type: "string",
            description: "Optional mission brief to apply before run",
          },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "company_stop",
      description: "Stop/interrupt the active company run.",
      inputSchema: emptyObject,
    },
    {
      type: "function",
      name: "company_run_from",
      description:
        "Start a run at a validated graph node. Upstream ancestors are intentionally skipped.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "company_ask_operator",
      description:
        "Block and ask the operator a structured question with choices and/or free text.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          options: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["id", "label"],
              additionalProperties: false,
            },
          },
          multiSelect: { type: "boolean" },
          allowFreeText: { type: "boolean" },
          placeholder: { type: "string" },
          timeoutSeconds: { type: "number", minimum: 30, maximum: 1800 },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "company_set_mission",
      description: "Update the Mission brief authorized text.",
      inputSchema: {
        type: "object",
        properties: {
          mission: { type: "string" },
        },
        required: ["mission"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "company_approve",
      description: "Approve the pending human release/tool gate.",
      inputSchema: emptyObject,
    },
    {
      type: "function",
      name: "company_decline",
      description: "Decline the pending human gate (fail closed).",
      inputSchema: emptyObject,
    },
    {
      type: "function",
      name: "company_list_nodes",
      description: "List graph nodes with id, label, role, kind, status.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "Optional kind filter: agent, creative, input, approval, output, …",
          },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "node_get",
      description: "Inspect a node’s config and live run fields.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "node_get_output",
      description:
        "Get a node’s summary, structured output excerpt, and artifact names.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "node_get_trace",
      description: "Recent execution trace lines for a node.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          label: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "node_get_criteria",
      description:
        "Completion criteria and last evaluation for a specialist node.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "node_get_events",
      description:
        "Run timeline events for a node (failures, starts, revisions).",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          label: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "node_task_progress",
      description:
        "Digest of allotted task vs progress: status, criteria ratio, last error, revisions, output presence.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "node_focus",
      description: "Focus/select a node in the graph editor UI.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "node_get_experience",
      description:
        "Durable run experience for a node pattern (success/failure outcomes, failure classes, tokens, latency). Call this before giving advice about a repeated failure or before suggesting prompt/tool changes.",
      inputSchema: nodeRef,
    },
    {
      type: "function",
      name: "node_refine_lessons",
      description:
        "Run a deliberate refinement pass over this workflow's node experience to produce or update durable, versioned harness lessons. The lessons are prepended to matching specialists' developer instructions on future runs and transfer across workflows sharing the same role/model/effort pattern. Call after a run with recurring failures to capture evidence-backed guidance.",
      inputSchema: { ...nodeRef, properties: { ...nodeRef.properties } },
    },
    {
      type: "function",
      name: "node_list_lessons",
      description:
        "List active harness lessons for a node's specialist pattern (role/model/effort). Use before advising prompt changes to see the durable, reviewable guidance already applied at run time. Each lesson has snapshot rollback history.",
      inputSchema: nodeRef,
    },
  ];
}

export async function executeCompanyMediatorTool(
  name: string,
  rawArgs: unknown,
  ctx: MediatorHostContext,
): Promise<ToolExecResult> {
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  const str = (k: string) =>
    typeof args[k] === "string" ? (args[k] as string) : undefined;
  const num = (k: string) =>
    typeof args[k] === "number" ? (args[k] as number) : undefined;

  try {
    switch (name) {
      case "company_select_app_workspace": {
        const suggestedMode = str("suggestedMode");
        if (suggestedMode !== "new" && suggestedMode !== "existing") {
          return fail("suggestedMode must be new or existing");
        }
        if (!ctx.actions?.selectAppWorkspace) {
          return fail("App workspace selection is unavailable");
        }
        const selection = await ctx.actions.selectAppWorkspace(suggestedMode);
        if (!selection) {
          return ok({
            selected: false,
            reason: "Operator chose not to select a folder",
          });
        }
        return ok({ selected: true, ...selection });
      }
      case "company_status": {
        const pending = ctx.approvals.filter((a) => a.status === "pending");
        const completed = ctx.nodes.filter(
          (n) => n.data.status === "completed" && n.data.kind !== "note",
        ).length;
        const total = ctx.nodes.filter((n) => n.data.kind !== "note").length;
        const recent = ctx.events.slice(-12).map((e) => ({
          type: e.type,
          message: e.message,
          nodeId: e.nodeId,
          level: e.level,
        }));
        const input = ctx.nodes.find((n) => n.data.kind === "input");
        const failedCriteria = ctx.nodes.flatMap((node) =>
          (node.data.criteriaEvaluation ?? [])
            .filter((criterion) => criterion.status === "fail")
            .map((criterion) => ({
              nodeId: node.id,
              nodeLabel: node.data.label,
              criterionId: criterion.id,
              label: criterion.label,
              enforcement: criterion.enforcement,
              detail: trunc(criterion.detail, 800),
            })),
        );
        return ok({
          running: ctx.running,
          runId: ctx.runId,
          progress: `${completed}/${total}`,
          pendingApprovals: pending.map((a) => ({
            id: a.id,
            title: a.title,
            nodeId: a.nodeId,
          })),
          missionExcerpt: trunc(input?.data.output ?? "", 400),
          lastRun: ctx.runHistory[0]
            ? {
                id: ctx.runHistory[0].id,
                status: ctx.runHistory[0].status,
                createdAt: ctx.runHistory[0].createdAt,
                terminalReason: ctx.runHistory[0].terminalReason ?? null,
              }
            : null,
          verification: {
            source: "runtime criteriaEvaluation",
            failedCriteria,
          },
          localTest: ctx.localTest
            ? {
                id: ctx.localTest.id,
                runId: ctx.localTest.runId,
                status: ctx.localTest.status,
                entrypoint: ctx.localTest.plan.entrypoint,
                command: ctx.localTest.plan.displayCommand,
                feedback: ctx.localTest.feedback,
                lastError: ctx.localTest.lastError ?? null,
              }
            : null,
          recentEvents: recent,
        });
      }
      case "company_run": {
        const mission = str("mission")?.trim();
        if (mission) ctx.actions?.setMission?.(mission);
        if (ctx.running)
          return ok({ started: false, reason: "Already running" });
        if (!ctx.actions?.run) return fail("Company run action is unavailable");
        const started = await ctx.actions.run(mission);
        if (!started) return fail("Company run did not start");
        return ok({ started: true, missionUpdated: Boolean(mission) });
      }
      case "company_run_from": {
        const resolved = resolveNode(ctx, {
          nodeId: str("nodeId"),
          label: str("label"),
        });
        if (resolved.error) return fail(resolved.error);
        const node = resolved.node!;
        if (node.data.kind === "note") return fail("Notes cannot be run");
        if (!ctx.actions?.runFrom)
          return fail("Company run-from action is unavailable");
        const started = await ctx.actions.runFrom(node.id);
        if (!started) return fail("Company run did not start");
        return ok({ started: true, nodeId: node.id, skippedAncestors: true });
      }
      case "company_stop": {
        if (!ctx.running)
          return ok({ stopped: false, reason: "No active run" });
        await ctx.actions?.stop?.();
        return ok({ stopped: true });
      }
      case "company_set_mission": {
        const mission = str("mission")?.trim();
        if (!mission) return fail("mission is required");
        ctx.actions?.setMission?.(mission);
        return ok({ missionSet: true, length: mission.length });
      }
      case "company_approve": {
        const pending = ctx.approvals.filter((a) => a.status === "pending");
        if (!pending.length)
          return ok({ approved: false, reason: "No pending approval" });
        await ctx.actions?.approve?.();
        return ok({ approved: true, nodeId: pending[0]?.nodeId });
      }
      case "company_decline": {
        const pending = ctx.approvals.filter((a) => a.status === "pending");
        if (!pending.length)
          return ok({ declined: false, reason: "No pending approval" });
        await ctx.actions?.decline?.();
        return ok({ declined: true, nodeId: pending[0]?.nodeId });
      }
      case "company_ask_operator": {
        const title = str("title")?.trim();
        const body = str("body")?.trim();
        if (!title || !body) return fail("title and body are required");
        if (!ctx.actions?.askOperator)
          return fail("operator question UI is unavailable");
        const rawOptions = Array.isArray(args.options)
          ? args.options.slice(0, 8)
          : [];
        const options = rawOptions.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const option = value as Record<string, unknown>;
          if (typeof option.id !== "string" || typeof option.label !== "string")
            return [];
          return [
            {
              id: option.id,
              label: option.label,
              description:
                typeof option.description === "string"
                  ? option.description
                  : undefined,
            },
          ];
        });
        const timeoutSeconds = Math.max(
          30,
          Math.min(num("timeoutSeconds") ?? 300, 1800),
        );
        const answer = await Promise.race([
          ctx.actions.askOperator({
            id: crypto.randomUUID(),
            title,
            body,
            options,
            multiSelect: args.multiSelect === true,
            allowFreeText: args.allowFreeText !== false,
            placeholder: str("placeholder"),
            blocksRun: true,
            source: "mediator",
          }),
          new Promise<null>((resolve) =>
            window.setTimeout(() => resolve(null), timeoutSeconds * 1000),
          ),
        ]);
        if (!answer)
          return fail("operator cancelled or the question timed out");
        return ok({ answered: true, ...answer });
      }
      case "company_list_nodes": {
        const kind = str("kind")?.toLowerCase();
        const list = ctx.nodes
          .filter((n) => !kind || n.data.kind === kind)
          .map((n) => ({
            id: n.id,
            label: n.data.label,
            role: n.data.role,
            kind: n.data.kind,
            status: n.data.status,
          }));
        return ok({ nodes: list });
      }
      case "node_get":
      case "node_get_output":
      case "node_get_trace":
      case "node_get_criteria":
      case "node_get_events":
      case "node_task_progress":
      case "node_get_experience":
      case "node_refine_lessons":
      case "node_list_lessons":
      case "node_focus": {
        const result = await executeNodeHandler(name, args, ctx);
        if (result) return result;
        return fail(`Unhandled node tool: ${name}`);
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(String(e));
  }
}

/** Context digest text packed into the mediator user turn. */
export function buildMediatorContextDigest(ctx: MediatorHostContext): string {
  const input = ctx.nodes.find((n) => n.data.kind === "input");
  const rawMission = (input?.data.output ?? "").trim();
  const mission = composeAuthorizedMission({
    output: input?.data.output,
    missionConstraints: input?.data.missionConstraints,
    acceptanceNotes: input?.data.acceptanceNotes,
  });
  const missionState = rawMission
    ? "PRESENT (graph seed or prior operator text — confirm before treating as ordered work)"
    : "EMPTY (gather requirements; do not invent a product)";
  const nodes = ctx.nodes
    .filter((n) => n.data.kind !== "note")
    .map((n) => `${n.id}|${n.data.label}|${n.data.status}`)
    .join("; ");
  const recent = ctx.events
    .slice(-8)
    .map((e) => `${e.type}:${e.message}`)
    .join(" | ");
  return [
    `RUNNING=${ctx.running} RUN_ID=${ctx.runId ?? "none"}`,
    `MISSION_STATE=${missionState}`,
    `MISSION_BRIEF (authorized store; not a chat reply template):\n${trunc(mission || "(empty)", 1500)}`,
    `NODES: ${nodes}`,
    `LOCAL_TEST: ${ctx.localTest?.status ?? "none"}${ctx.localTest ? ` · ${ctx.localTest.plan.entrypoint}` : ""}`,
    `RECENT_EVENTS: ${recent || "(none)"}`,
    `MEDIATOR_HINT: For greetings, acknowledge and ask what they want the company to build or investigate. Do not announce a product plan from seed mission text.`,
  ].join("\n\n");
}
