import {
  DEFAULT_MAX_REVISIONS,
  type FlowEdge,
  type FlowNode,
  type Kind,
} from "../model";
import { DEFAULT_NODE_EFFORT, DEFAULT_NODE_MODEL_ID } from "../codex-models";
import { defaultPlatformCriteria } from "../completion-criteria";
import type { CompletionCriterion } from "../completion-criteria";
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
    data: {
      edgeType,
      ...(edgeType === "revision"
        ? { maxRevisions: DEFAULT_MAX_REVISIONS }
        : {}),
    },
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
      role:
        kind === "approval"
          ? "Approver"
          : kind === "output"
            ? "Verified handoff"
            : "Control",
      kind,
      status: "idle",
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
              ? "After explicit approval, compare approved artifact hashes with the live artifact set and create a tamper-evident release bundle."
              : kind === "condition"
                ? "Route when the configured branch value matches."
                : "Define this node contract.",
      description:
        kind === "output"
          ? "Deterministically compares approved artifact hashes with live outputs and packages the verified, tamper-evident handoff. This is not an AI agent."
          : `${label} control node`,
      duration: "—",
      tokens: 0,
      trace: ["Template seed"],
      color: kindPopColor(kind),
      output:
        kind === "input"
          ? "Describe the product request for the company."
          : undefined,
      missionSource: kind === "input" ? "template" : undefined,
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
  timeoutSeconds = 120,
  executionPolicy: Pick<
    FlowNode["data"],
    "approvalPolicy" | "sandboxProfile" | "workspacePolicy"
  > = {},
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
      timeoutSeconds,
      sandboxProfile: inst.sandboxProfile,
      approvalPolicy: inst.approvalPolicy,
      workspacePolicy: inst.workspacePolicy ?? "isolated",
      ...executionPolicy,
      completionCriteria: inst.completionCriteria ?? defaultPlatformCriteria(),
      color: kindPopColor(inst.kind),
    },
  };
}

/** software-company-v1: input → pm → architect → builder → qa → release-coordinator → demo → release-commit → publish-approval → output (+ revision) */
export function buildSoftwareCompanyTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Mission brief", 0),
    packNode("pm", "product-manager", 1, undefined, 300),
    packNode("architect", "architect", 2, undefined, 300),
    packNode("builder", "builder", 3, "Builder", 600),
    packNode("qa", "qa-engineer", 4, undefined, 600),
    packNode("release-coordinator", "release-coordinator", 5, "Release Coordinator", 600),
    controlNode("demo", "approval", "Demo launch", 6),
    controlNode("release-commit", "approval", "Release commit", 7),
    controlNode("publish-approval", "approval", "Publish approval", 8),
    controlNode("output", "output", "Release Bundle", 9),
  ];
  const qa = nodes.find((node) => node.id === "qa");
  if (!qa) throw new Error("Software Company template is missing QA");
  const requiredCommands: CompletionCriterion[] = [
    {
      id: "software_npm_test",
      label: "Run the repository test suite",
      kind: "command",
      enabled: true,
      platform: false,
      enforcement: "required",
      templateId: "npm_test",
    },
    {
      id: "software_npm_build",
      label: "Run the production build",
      kind: "command",
      enabled: true,
      platform: false,
      enforcement: "required",
      templateId: "npm_run_build",
    },
  ];
  qa.data.completionCriteria = [
    ...(qa.data.completionCriteria ?? defaultPlatformCriteria()),
    ...requiredCommands,
  ];
  const edges: FlowEdge[] = [
    edge("e-in-pm", "input", "pm"),
    edge("e-pm-arch", "pm", "architect"),
    edge("e-arch-builder", "architect", "builder"),
    edge("e-builder-qa", "builder", "qa"),
    edge("e-qa-release-coordinator", "qa", "release-coordinator"),
    edge("e-release-coordinator-demo", "release-coordinator", "demo", "approval"),
    edge("e-demo-release-commit", "demo", "release-commit", "approval"),
    edge("e-release-commit-publish", "release-commit", "publish-approval", "approval"),
    edge("e-publish-output", "publish-approval", "output"),
    edge("e-qa-builder-rev", "qa", "builder", "revision"),
  ];
  return {
    id: "software-company-v1",
    name: "Software company",
    description:
      "PM → Architect → Builder → QA → Release Coordinator → Demo → Release commit → Publish approval → verified Release Bundle with revision loop.",
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
    controlNode("output", "output", "Release Bundle", 5),
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
      "Focused implement track: Architect → Senior SE → QA → Approval → verified Release Bundle.",
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
    packNode("builder", "builder", 5, "Builder"),
    packNode("reviewer", "code-reviewer", 6),
    controlNode("approval", "approval", "Approval", 7),
    controlNode("output", "output", "Release Bundle", 8),
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

/** product-launch-v1: pm → research → design → build → qa → approval → output */
export function buildProductLaunchTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Mission brief", 0),
    packNode("pm", "product-manager", 1, undefined, 300),
    packNode("researcher", "researcher", 2, undefined, 300),
    packNode("designer", "designer", 3, undefined, 300),
    packNode("builder", "builder", 4, "Builder", 600),
    packNode("qa", "qa-engineer", 5, undefined, 600),
    controlNode("approval", "approval", "Approval", 6),
    controlNode("output", "output", "Release Bundle", 7),
  ];
  const edges: FlowEdge[] = [
    edge("e-in-pm", "input", "pm"),
    edge("e-pm-research", "pm", "researcher"),
    edge("e-research-designer", "researcher", "designer"),
    edge("e-designer-builder", "designer", "builder"),
    edge("e-builder-qa", "builder", "qa"),
    edge("e-qa-approval", "qa", "approval", "approval"),
    edge("e-approval-out", "approval", "output"),
    edge("e-qa-builder-rev", "qa", "builder", "revision"),
  ];
  return {
    id: "product-launch-v1",
    name: "Product launch",
    description:
      "Evidence-led launch track: PM → Research → Design → Build → QA → Approval → verified Release Bundle.",
    version: "v1.0",
    nodes,
    edges,
    templateOrigin: "built-in",
    locked: true,
  };
}

/** security-review-v1: architect → security review → code review → approval → output */
export function buildSecurityReviewTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Review brief", 0),
    packNode("architect", "architect", 1, undefined, 300),
    packNode("security", "security-reviewer", 2, undefined, 480),
    packNode("reviewer", "code-reviewer", 3, undefined, 480),
    controlNode("approval", "approval", "Approval", 4),
    controlNode("output", "output", "Release Bundle", 5),
  ];
  const edges: FlowEdge[] = [
    edge("e-in-architect", "input", "architect"),
    edge("e-architect-security", "architect", "security"),
    edge("e-security-reviewer", "security", "reviewer"),
    edge("e-reviewer-approval", "reviewer", "approval", "approval"),
    edge("e-approval-out", "approval", "output"),
    edge("e-reviewer-security-rev", "reviewer", "security", "revision"),
  ];
  return {
    id: "security-review-v1",
    name: "Security review",
    description:
      "Threat-model and quality gate: Architect → Security Review → Code Review → Approval → verified Release Bundle.",
    version: "v1.0",
    nodes,
    edges,
    templateOrigin: "built-in",
    locked: true,
  };
}

/** incident-response-v1: security triage → architecture → remediation → qa → handoff → approval */
export function buildIncidentResponseTemplate(): BuiltinTemplate {
  const nodes: FlowNode[] = [
    controlNode("input", "input", "Incident brief", 0),
    packNode("security", "security-reviewer", 1, "Triage", 300),
    packNode("architect", "architect", 2, undefined, 300),
    packNode("remediator", "backend-engineer", 3, "Remediator", 600),
    packNode("qa", "qa-engineer", 4, undefined, 600),
    packNode("delivery", "delivery-agent", 5, "Incident handoff", 300),
    controlNode("approval", "approval", "Approval", 6),
    controlNode("output", "output", "Release Bundle", 7),
  ];
  const edges: FlowEdge[] = [
    edge("e-in-security", "input", "security"),
    edge("e-security-architect", "security", "architect"),
    edge("e-architect-remediator", "architect", "remediator"),
    edge("e-remediator-qa", "remediator", "qa"),
    edge("e-qa-delivery", "qa", "delivery"),
    edge("e-delivery-approval", "delivery", "approval", "approval"),
    edge("e-approval-out", "approval", "output"),
    edge("e-qa-remediator-rev", "qa", "remediator", "revision"),
  ];
  return {
    id: "incident-response-v1",
    name: "Incident response",
    description:
      "Contain and recover safely: Security Triage → Architect → Remediation → QA → Incident Handoff → Approval.",
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
    buildProductLaunchTemplate(),
    buildSecurityReviewTemplate(),
    buildIncidentResponseTemplate(),
  ];
}
