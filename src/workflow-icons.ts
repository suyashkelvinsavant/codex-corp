/**
 * Curated icons for company workflows (homescreen cards + identity editor).
 */
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  Briefcase,
  Building2,
  Factory,
  Flame,
  Globe2,
  HeartHandshake,
  Layers,
  Network,
  Package,
  Rocket,
  Sparkles,
  Target,
  Workflow,
  Zap,
} from "lucide-react";

export const DEFAULT_WORKFLOW_ICON = "network";

export type WorkflowIconOption = {
  id: string;
  label: string;
  Icon: LucideIcon;
};

/** Picker options shown in the identity modal. */
export const WORKFLOW_ICON_OPTIONS: WorkflowIconOption[] = [
  { id: "network", label: "Network", Icon: Network },
  { id: "workflow", label: "Workflow", Icon: Workflow },
  { id: "building", label: "Company", Icon: Building2 },
  { id: "factory", label: "Factory", Icon: Factory },
  { id: "rocket", label: "Launch", Icon: Rocket },
  { id: "target", label: "Target", Icon: Target },
  { id: "zap", label: "Energy", Icon: Zap },
  { id: "flame", label: "Momentum", Icon: Flame },
  { id: "globe", label: "Global", Icon: Globe2 },
  { id: "briefcase", label: "Business", Icon: Briefcase },
  { id: "package", label: "Delivery", Icon: Package },
  { id: "layers", label: "Layers", Icon: Layers },
  { id: "boxes", label: "Systems", Icon: Boxes },
  { id: "bot", label: "Agents", Icon: Bot },
  { id: "sparkles", label: "Creative", Icon: Sparkles },
  { id: "heart", label: "Care", Icon: HeartHandshake },
];

const BY_ID = new Map(WORKFLOW_ICON_OPTIONS.map((opt) => [opt.id, opt]));

export function normalizeWorkflowIcon(icon?: string | null): string {
  const id = (icon ?? "").trim();
  return BY_ID.has(id) ? id : DEFAULT_WORKFLOW_ICON;
}

export function workflowIconComponent(
  icon?: string | null,
): LucideIcon {
  return BY_ID.get(normalizeWorkflowIcon(icon))?.Icon ?? Network;
}

export function workflowIconLabel(icon?: string | null): string {
  return BY_ID.get(normalizeWorkflowIcon(icon))?.label ?? "Network";
}
