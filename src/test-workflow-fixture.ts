import type { FlowNode, Kind } from "./model";
import type { WorkflowTemplate } from "./templates";
import { defaultPlatformCriteria } from "./completion-criteria";
import { ensureSpecialistQuality } from "./specialist-defaults";

const ROLE_BY_ID: Record<string, string> = {
  research: "Researcher",
  architect: "Architect",
  designer: "Designer",
  creative: "Creative",
  builder: "Frontend Engineer",
  reviewer: "Code Reviewer",
};

function node(id: string, kind: Kind, label: string, index: number): FlowNode {
  const role =
    kind === "agent" || kind === "creative"
      ? ROLE_BY_ID[id] || "Frontend Engineer"
      : "Control";
  const quality = ensureSpecialistQuality({
    kind,
    role,
    label,
    prompt: kind === "agent" ? "You are the SOLE IMPLEMENTER." : "",
    tools: kind === "agent" ? ["Shell"] : [],
    skills: [],
    description: `${label} test fixture`,
  });
  return {
    id,
    type: "corpNode",
    position: {
      x: 80 + (index % 5) * 280,
      y: 100 + Math.floor(index / 5) * 220,
    },
    data: {
      label,
      role,
      kind,
      status: kind === "input" ? "completed" : "idle",
      model: kind === "agent" || kind === "creative" ? "" : "Control",
      effort: "low",
      tools: kind === "agent" || kind === "creative" ? quality.tools : [],
      skills: kind === "agent" || kind === "creative" ? quality.skills : [],
      prompt: kind === "agent" || kind === "creative" ? quality.prompt : "",
      description:
        kind === "agent" || kind === "creative"
          ? quality.description
          : `${label} test fixture`,
      duration: "—",
      tokens: 0,
      trace: ["Test fixture"],
      color: "#55d6be",
      completionCriteria:
        kind === "agent" || kind === "creative"
          ? defaultPlatformCriteria()
          : undefined,
    },
  } as FlowNode;
}

/** Explicit test-only fixture; never registered in the application catalog. */
export function makeTestWorkflow(): WorkflowTemplate {
  return {
    id: "software-company",
    name: "Software company test fixture",
    description: "Test-only executable graph",
    version: "v0.6",
    nodes: [
      node("input", "input", "Mission brief", 0),
      node("research", "agent", "Research", 1),
      node("architect", "agent", "Architect", 2),
      node("designer", "agent", "Designer", 3),
      node("creative", "creative", "Creative", 4),
      node("builder", "agent", "Builder", 5),
      node("reviewer", "agent", "Reviewer", 6),
      node("approval", "approval", "Approval", 7),
      node("output", "output", "Delivery", 8),
    ],
    edges: [
      {
        id: "e-input-research",
        source: "input",
        target: "research",
        data: { edgeType: "standard" },
      },
      {
        id: "e-input-architect",
        source: "input",
        target: "architect",
        data: { edgeType: "standard" },
      },
      {
        id: "e-research-designer",
        source: "research",
        target: "designer",
        data: { edgeType: "standard" },
      },
      {
        id: "e-architect-designer",
        source: "architect",
        target: "designer",
        data: { edgeType: "standard" },
      },
      {
        id: "e-designer-creative",
        source: "designer",
        target: "creative",
        data: { edgeType: "standard" },
      },
      {
        id: "e-creative-builder",
        source: "creative",
        target: "builder",
        data: { edgeType: "standard" },
      },
      {
        id: "e-research-builder",
        source: "research",
        target: "builder",
        data: { edgeType: "standard" },
      },
      {
        id: "e-architect-builder",
        source: "architect",
        target: "builder",
        data: { edgeType: "standard" },
      },
      {
        id: "e-builder-output",
        source: "builder",
        target: "reviewer",
        data: { edgeType: "standard" },
      },
      {
        id: "e-reviewer-approval",
        source: "reviewer",
        target: "approval",
        data: { edgeType: "standard" },
      },
      {
        id: "e-approval-output",
        source: "approval",
        target: "output",
        data: { edgeType: "standard" },
      },
      {
        id: "e-reviewer-builder",
        source: "reviewer",
        target: "builder",
        data: { edgeType: "revision", maxRevisions: 2 },
      },
    ],
  };
}
