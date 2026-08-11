import type { FlowEdge, FlowNode, ValidationProblem } from "./model";
import { jsonSchemaDefinitionError } from "./json-schema";
import { isSpecialistKind } from "./model";
import { validateConditionRule } from "./condition-rules";
import { isValidCronExpression, isValidCronTimezone } from "./cron-trigger";
import {
  COMMAND_TEMPLATE_IDS,
  normalizeCriterionKind,
} from "./completion-criteria";
import {
  isWeakSpecialistPrompt,
  MIN_SPECIALIST_PROMPT_CHARS,
} from "./specialist-defaults";

const executable = (node: FlowNode) => node.data.kind !== "note";

export function upstreamLineage(
  nodeId: string,
  edges: FlowEdge[],
): Set<string> {
  const seen = new Set<string>(nodeId ? [nodeId] : []);
  const visit = (id: string) => {
    for (const edge of edges) {
      if (edge.target !== id || edge.data?.edgeType === "revision") continue;
      if (!seen.has(edge.source)) {
        seen.add(edge.source);
        visit(edge.source);
      }
    }
  };
  if (nodeId) visit(nodeId);
  return seen;
}

export function standardCycle(edges: FlowEdge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data?.edgeType === "revision") continue;
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of adjacency.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateWorkflow(
  nodes: FlowNode[],
  edges: FlowEdge[],
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputs = nodes.filter((node) => node.data.kind === "input");
  const outputs = nodes.filter((node) => node.data.kind === "output");
  const cronTriggers = nodes.filter((node) => node.data.kind === "cron");
  if (!inputs.length)
    problems.push({
      id: "missing-input",
      severity: "error",
      message: "Add at least one Input node.",
    });
  if (!outputs.length)
    problems.push({
      id: "missing-output",
      severity: "error",
      message: "Add at least one Output node.",
    });

  for (const node of nodes) {
    if (node.data.kind === "agent" || node.data.kind === "creative") {
      const timeout = node.data.timeoutSeconds ?? 120;
      if (!Number.isFinite(timeout) || timeout < 10 || timeout > 1800) {
        problems.push({
          id: `timeout-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} timeout must be between 10 and 1800 seconds.`,
        });
      }
      const readOnly =
        node.data.permissionProfile?.includes("read-only") ||
        (!node.data.permissionProfile &&
          node.data.sandboxProfile === "read-only");
      if (
        readOnly &&
        node.data.tools.some((tool) => tool.toLowerCase().includes("write"))
      ) {
        problems.push({
          id: `write-boundary-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} cannot prefer write capability under a read-only boundary.`,
        });
      }
    }
    if (node.data.kind === "cron") {
      if (!isValidCronExpression(node.data.cronExpression ?? "")) {
        problems.push({
          id: `cron-expression-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} needs a valid five-field cron expression.`,
        });
      }
      if (!isValidCronTimezone(node.data.cronTimezone ?? "UTC")) {
        problems.push({
          id: `cron-timezone-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} needs a valid IANA timezone such as UTC or Asia/Kolkata.`,
        });
      }
      const targets = edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => byId.get(edge.target));
      if (!targets.some((target) => target?.data.kind === "input")) {
        problems.push({
          id: `cron-input-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} must connect to an Input node.`,
        });
      }
    }
    if (node.data.kind !== "condition") continue;
    for (const [index, message] of validateConditionRule(
      node.data.conditionRule,
    ).entries()) {
      problems.push({
        id: `condition-rule-${node.id}-${index}`,
        severity: "error",
        nodeId: node.id,
        message,
      });
    }
    const inbound = edges.filter(
      (edge) => edge.target === node.id && edge.data?.edgeType !== "revision",
    );
    if (inbound.length > 1 && !node.data.conditionRule?.sourceNodeId) {
      problems.push({
        id: `condition-source-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message:
          "Conditions with multiple upstream nodes require an explicit source node.",
      });
    }
  }

  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      problems.push({
        id: `dangling-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Edge references a missing node.",
      });
    }
    if (edge.source === edge.target) {
      problems.push({
        id: `self-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Self-connections are not allowed.",
      });
    }
    if (
      edge.data?.edgeType === "revision" &&
      !(edge.data.maxRevisions && edge.data.maxRevisions > 0)
    ) {
      problems.push({
        id: `revision-limit-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Revision edges require a positive limit.",
      });
    }
    if (edge.data?.edgeType === "conditional" && !edge.data.condition?.trim()) {
      problems.push({
        id: `condition-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Conditional edges require a result condition.",
      });
    }
    for (const [field, path] of Object.entries(edge.data?.mapping ?? {})) {
      if (!field.trim() || !path.startsWith("$.")) {
        problems.push({
          id: `mapping-${edge.id}-${field}`,
          severity: "error",
          edgeId: edge.id,
          message:
            "Edge field mappings must use non-empty fields and $. paths.",
        });
      }
    }
    const target = byId.get(edge.target);
    if (
      edge.data?.edgeType === "approval" &&
      target?.data.kind !== "approval"
    ) {
      problems.push({
        id: `approval-target-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Approval edges must terminate at an Approval node.",
      });
    }
    if (edge.data?.edgeType === "merge" && target?.data.kind !== "merge") {
      problems.push({
        id: `merge-target-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Merge dependencies must terminate at a Merge node.",
      });
    }
    if (
      edge.data?.edgeType === "revision" &&
      target &&
      !isSpecialistKind(target.data.kind)
    ) {
      problems.push({
        id: `revision-target-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message:
          "Revision feedback must return to an Agent or Creative Studio node.",
      });
    }
  }

  for (const node of nodes.filter(executable)) {
    const inbound = edges.some((edge) => edge.target === node.id);
    const outbound = edges.some((edge) => edge.source === node.id);
    if (
      node.data.kind === "input" || node.data.kind === "cron"
        ? !outbound
        : node.data.kind === "output"
          ? !inbound
          : !inbound || !outbound
    ) {
      problems.push({
        id: `disconnected-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${node.data.label} is disconnected from an executable path.`,
      });
    }
    if (isSpecialistKind(node.data.kind)) {
      const developer =
        (node.data.developerInstructions ?? "").trim() ||
        (node.data.prompt ?? "").trim();
      if (!developer) {
        problems.push({
          id: `prompt-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} needs developer instructions.`,
        });
      } else if (isWeakSpecialistPrompt(developer)) {
        problems.push({
          id: `prompt-quality-${node.id}`,
          severity: "warning",
          nodeId: node.id,
          message: `${node.data.label} should use a detailed developer contract (≥${MIN_SPECIALIST_PROMPT_CHARS} chars, role-specific, not a placeholder).`,
        });
      }
      for (const criterion of node.data.completionCriteria ?? []) {
        if (!criterion.enabled && !criterion.platform) continue;
        const kind = normalizeCriterionKind(criterion.kind);
        const required =
          Boolean(criterion.platform) || criterion.enforcement === "required";
        if (kind === "unknown") {
          problems.push({
            id: `criterion-kind-${node.id}-${criterion.id}`,
            severity: "error",
            nodeId: node.id,
            message: `${node.data.label}: unknown criterion kind "${criterion.kind}" — required gates cannot be satisfied by an unverified kind. Use structured_json, concise_summary, no_hidden_reasoning, claim, command, artifact_exists, or architecture_policy.`,
          });
        }
        if (required && (kind === "claim" || kind === "custom")) {
          problems.push({
            id: `criterion-claim-required-${node.id}-${criterion.id}`,
            severity: "error",
            nodeId: node.id,
            message: `${node.data.label}: required claim criteria are invalid — use platform/command/artifact_exists/architecture_policy.`,
          });
        }
        if (kind === "command") {
          const tid = (criterion.templateId ?? "").trim();
          if (
            !tid ||
            !(COMMAND_TEMPLATE_IDS as readonly string[]).includes(tid)
          ) {
            problems.push({
              id: `criterion-command-${node.id}-${criterion.id}`,
              severity: "error",
              nodeId: node.id,
              message: `${node.data.label}: command criterion needs an allowlisted templateId.`,
            });
          }
        }
        if (kind === "artifact_exists") {
          const hasName = Boolean((criterion.artifactName ?? "").trim());
          const hasPath = Boolean((criterion.artifactPath ?? "").trim());
          if (!hasName && !hasPath) {
            problems.push({
              id: `criterion-artifact-${node.id}-${criterion.id}`,
              severity: "error",
              nodeId: node.id,
              message: `${node.data.label}: artifact_exists criterion needs artifactName or artifactPath.`,
            });
          }
        }
      }
    }
    if (isSpecialistKind(node.data.kind) && !node.data.tools?.length) {
      problems.push({
        id: `tools-${node.id}`,
        severity: "warning",
        nodeId: node.id,
        message: `${node.data.label} has no tools configured — Byte should set least-privilege tools.`,
      });
    }
    if (isSpecialistKind(node.data.kind) && !node.data.model.trim()) {
      problems.push({
        id: `model-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${node.data.label} needs a Codex model (Config → Model, or Refresh models).`,
      });
    }
    for (const [label, schema] of [
      ["input", node.data.inputSchema],
      ["output", node.data.outputSchema],
    ] as const) {
      if (!schema?.trim()) continue;
      const error = jsonSchemaDefinitionError(schema);
      if (error) {
        problems.push({
          id: `${label}-schema-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} has an invalid ${label} JSON Schema: ${error}.`,
        });
      }
    }
  }

  const cycle = standardCycle(edges);
  if (cycle)
    problems.push({
      id: "standard-cycle",
      severity: "error",
      message: `Standard cycle detected: ${cycle.join(" → ")}. Use a bounded revision edge instead.`,
    });

  if (inputs.length && outputs.length) {
    const reachable = new Set(
      (cronTriggers.length ? cronTriggers : inputs).map((node) => node.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges.filter(
        (edge) => edge.data?.edgeType !== "revision",
      )) {
        if (reachable.has(edge.source) && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          changed = true;
        }
      }
    }
    for (const output of outputs)
      if (!reachable.has(output.id)) {
        problems.push({
          id: `unreachable-${output.id}`,
          severity: "error",
          nodeId: output.id,
          message: `${output.data.label} is not reachable from an Input node.`,
        });
      }
  }
  return problems;
}

export function readyNodeIds(
  nodes: FlowNode[],
  edges: FlowEdge[],
  completed: Set<string>,
  skipped = new Set<string>(),
): string[] {
  return nodes
    .filter((node) => {
      if (
        !executable(node) ||
        completed.has(node.id) ||
        skipped.has(node.id) ||
        node.data.kind === "input" ||
        node.data.kind === "cron"
      )
        return false;
      const inbound = edges.filter(
        (edge) => edge.target === node.id && edge.data?.edgeType !== "revision",
      );
      return (
        inbound.length > 0 &&
        inbound.every(
          (edge) => completed.has(edge.source) || skipped.has(edge.source),
        )
      );
    })
    .map((node) => node.id);
}
