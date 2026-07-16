import type { Kind, Status } from "./model";

export const CONTROL_KINDS = new Set<Kind>([
  "input",
  "cron",
  "output",
  "approval",
  "condition",
  "merge",
]);

export function controlKindLabel(kind: Kind): string {
  switch (kind) {
    case "input":
      return "Entry";
    case "cron":
      return "Schedule";
    case "output":
      return "Delivery";
    case "approval":
      return "Human gate";
    case "condition":
      return "Branch";
    case "merge":
      return "Join";
    default:
      return kind;
  }
}

export const statusText: Record<Status, string> = {
  draft: "Draft",
  invalid: "Invalid",
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  approval: "Waiting approval",
  completed: "Completed",
  needs_revision: "Needs revision",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
};
