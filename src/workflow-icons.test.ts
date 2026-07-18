import { describe, expect, it } from "vitest";
import { Network, Rocket } from "lucide-react";
import {
  DEFAULT_WORKFLOW_ICON,
  WORKFLOW_ICON_OPTIONS,
  normalizeWorkflowIcon,
  workflowIconComponent,
} from "./workflow-icons";

describe("workflow icons", () => {
  it("normalizes unknown ids to the default", () => {
    expect(normalizeWorkflowIcon(undefined)).toBe(DEFAULT_WORKFLOW_ICON);
    expect(normalizeWorkflowIcon("not-a-real-icon")).toBe(
      DEFAULT_WORKFLOW_ICON,
    );
    expect(normalizeWorkflowIcon("rocket")).toBe("rocket");
  });

  it("resolves components for known ids", () => {
    expect(workflowIconComponent("network")).toBe(Network);
    expect(workflowIconComponent("rocket")).toBe(Rocket);
    expect(WORKFLOW_ICON_OPTIONS.length).toBeGreaterThanOrEqual(12);
  });
});
