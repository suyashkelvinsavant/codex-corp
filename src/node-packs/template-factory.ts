import type { FlowEdge, FlowNode, Kind } from "../model";
import { DEFAULT_NODE_EFFORT, DEFAULT_NODE_MODEL_ID } from "../codex-models";
import { defaultPlatformCriteria } from "../completion-criteria";
import { kindPopColor } from "../kind-colors";
import { instantiatePackById } from "./instantiate";

/** Local shape to avoid circular import with templates.ts. */
type BuiltinTemplate = {
  id: string;
  name: string;
  description: string;
  version: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  templateOrigin: "built-in";
  locked: true;
};

function edge(
  id: string,
  source: string,
  target: string,
  edgeType: "standard" | "revision" | "approval" = "standard",
): FlowEdge {
  return {
    id,
    source,
    target,
    data: { edgeType },
  };
}

function controlNode(
  id: string,
  kind: Kind,
  label: string,
  index: number,
  extras: Partial<FlowNode["data"]> = {},
): FlowNode {
  return {
    id,
    type: "corpNode",
    position: {
      x: 80 + (index % 5) * 280,
      y: 100 + Math.floor(index / 5) * 220,
    },
    data: {
      label,
      role: kind === "approval" ? "Approver" : "Control",
      kind,
      status: kind === "input" ? "completed" : "idle",
      model:
        kind === "approval"
          ? "Human"
          : kind === "output"
            ? "Collector"
            : "Control",
      effort: "low",
      tools: [],
      prompt:
        kind === "input"
          ? "Capture the user request and constraints."
          : kind === "approval"
            ? "Pause until a human approves the reviewed deliverable."
            : kind === "output"
              ? "Collect approved artifacts and execution notes."
              : kind === "condition"
                ? "Route when the configured branch value matches."
                : "Define this node contract.",
      description: `${label} control node`,
      duration: "—",
      tokens: 0,
      trace: ["Template seed"],
      color: kindPopColor(kind),
      output:
        kind === "input"
          ? "Describe the product request for the company."
          : undefined,
      conditionRule:
        kind === "condition"
          ? {
              path: "$.status",
              operator: "==",
              value: "success",
              trueBranch: "success",
              falseBranch: "otherwise",
            }
          : undefined,
      ...extras,
    },
  };
}

function packNode(
  id: string,
  packId: string,
  index: number,
  labelOverride?: string,
): FlowNode {
  const inst = instantiatePackById(packId);
  if (!inst) throw new Error(`Unknown pack ${packId}`);
  return {
    id,
    type: "corpNode",
    position: {
      x: 80 + (index % 5) * 280,
      y: 100 + Math.floor(index / 5) * 220,
    },
    data: {
      label: labelOverride ?? inst.label,
      role: inst.role,
      kind: inst.kind,
      status: "idle",
      model: DEFAULT_NODE_MODEL_ID,
      effort: DEFAULT_NODE_EFFORT,
      tools: inst.tools,
      skills: inst.skills,
      packId: inst.packId,
      packVersion: inst.packVersion,
      baseInstructions: inst.baseInstructions,
      developerInstructions: inst.developerInstructions,
      prompt: inst.prompt,
      description: inst.description,
      duration: "—",
      tokens: 0,
      trace: ["Template seed"],
      maxRetries: 2,
      timeoutSeconds: 120,
      completionCriteria: inst.completionCriteria ?? defaultPlatformCriteria(),
      color: kindPopColor(inst.kind),
    },
  };
}

/** software-company-v1: input → pm → architect → builder → qa → approval → output (+ revision) */
export function buildSoftwareCompanyTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Mission brief", 0),
    packNode("pm", "product-manager", 1),
    packNode("architect", "architect", 2),
    packNode("builder", "frontend-engineer", 3, "Builder"),
    packNode("qa", "qa-engineer", 4),
    controlNode("approval", "approval", "Approval", 5),
    controlNode("output", "output", "Delivery", 6),
  ];
  const edges: FlowEdge[] = [
    edge("e-in-pm", "input", "pm"),
    edge("e-pm-arch", "pm", "architect"),
    edge("e-arch-builder", "architect", "builder"),
    edge("e-builder-qa", "builder", "qa"),
    edge("e-qa-approval", "qa", "approval", "approval"),
    edge("e-approval-out", "approval", "output"),
    edge("e-qa-builder-rev", "qa", "builder", "revision"),
  ];
  return {
    id: "software-company-v1",
    name: "Software company",
    description:
      "PM → Architect → Builder → QA → Approval → Delivery with revision loop.",
    version: "v1.0",
    nodes,
    edges,
    templateOrigin: "built-in",
    locked: true,
  };
}

/** code-change-delivery-v1: architect → senior-SE → qa → approval → output */
export function buildCodeChangeDeliveryTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Mission brief", 0),
    packNode("architect", "architect", 1),
    packNode("senior", "senior-software-engineer", 2),
    packNode("qa", "qa-engineer", 3),
    controlNode("approval", "approval", "Approval", 4),
    controlNode("output", "output", "Delivery", 5),
  ];
  const edges: FlowEdge[] = [
    edge("e-in-arch", "input", "architect"),
    edge("e-arch-senior", "architect", "senior"),
    edge("e-senior-qa", "senior", "qa"),
    edge("e-qa-approval", "qa", "approval", "approval"),
    edge("e-approval-out", "approval", "output"),
    edge("e-qa-senior-rev", "qa", "senior", "revision"),
  ];
  return {
    id: "code-change-delivery-v1",
    name: "Code change delivery",
    description:
      "Focused implement track: Architect → Senior SE → QA → Approval → Delivery.",
    version: "v1.0",
    nodes,
    edges,
    templateOrigin: "built-in",
    locked: true,
  };
}

/** launch-review-v1: pm → researcher → architect → condition → … */
export function buildLaunchReviewTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Mission brief", 0),
    packNode("pm", "product-manager", 1),
    packNode("researcher", "researcher", 2),
    packNode("architect", "architect", 3),
    controlNode("gate", "condition", "Ready to build?", 4),
    packNode("builder", "senior-software-engineer", 5, "Builder"),
    packNode("reviewer", "code-reviewer", 6),
    controlNode("approval", "approval", "Approval", 7),
    controlNode("output", "output", "Delivery", 8),
  ];
  const edges: FlowEdge[] = [
    edge("e-in-pm", "input", "pm"),
    edge("e-pm-research", "pm", "researcher"),
    edge("e-research-arch", "researcher", "architect"),
    edge("e-arch-gate", "architect", "gate"),
    edge("e-gate-builder", "gate", "builder"),
    edge("e-builder-review", "builder", "reviewer"),
    edge("e-review-approval", "reviewer", "approval", "approval"),
    edge("e-approval-out", "approval", "output"),
    edge("e-review-builder-rev", "reviewer", "builder", "revision"),
  ];
  return {
    id: "launch-review-v1",
    name: "Launch review",
    description:
      "Discovery through gated build: PM → Research → Architect → Condition → Build → Review → Approval.",
    version: "v1.0",
    nodes,
    edges,
    templateOrigin: "built-in",
    locked: true,
  };
}

export function builtinWorkflowTemplates(): BuiltinTemplate[] {
  return [
    buildSoftwareCompanyTemplate(),
    buildCodeChangeDeliveryTemplate(),
    buildLaunchReviewTemplate(),
  ];
}
