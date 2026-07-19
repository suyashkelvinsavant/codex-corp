/**
 * Tool / permission boundary helpers for Live Codex.
 *
 * Selected capabilities become an advisory preference block
 * injected into the agent turn. The Codex app-server owns sandbox + approval
 * policy; this product does not hard-enforce tool ACLs and does not connect MCP.
 */

export const STANDARD_TOOL_LABELS = [
  "Workspace read",
  "Workspace write",
  "Shell",
  "Network",
  "Web search",
] as const;

function isLegacyMcpToolLabel(label: string): boolean {
  return label.trim().toLowerCase().includes("mcp");
}

/** Tools that can appear in a Live advisory allow-list (excludes MCP). */
export function advisoryAllowList(tools: string[]): string[] {
  return tools
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0 && !isLegacyMcpToolLabel(tool));
}

export function permissionGrantLabel(tool: string, granted: boolean): string {
  if (!granted) return "denied";
  return "advisory";
}

export function toolsUiHelperText(): string {
  return "These are execution preferences, not per-tool access controls. The Codex app-server enforces the selected sandbox, permission profile, and approval policy.";
}

export type LiveBoundaryInput = {
  tools: string[];
  approvalPolicy: string;
  sandboxProfile: string;
  workspacePolicy: string;
};

export function formatLiveToolBoundaryBlock(input: LiveBoundaryInput): string {
  const allow = advisoryAllowList(input.tools);
  const lines = [
    "TOOL BOUNDARY (advisory prompt constraint — not a hard sandbox ACL enforced by Codex Corp):",
    allow.length
      ? `Preferred tools only: ${allow.join(", ")}.`
      : "No tools explicitly preferred; minimize tool use.",
    `Approval policy: ${input.approvalPolicy}. Sandbox profile: ${input.sandboxProfile}. Workspace policy: ${input.workspacePolicy}.`,
    "Do not use tools outside the preferred list unless the operator expands it.",
    "Host/app-server tool approvals still apply when policy is on-request or untrusted; never treat generated commands as pre-approved.",
  ];
  return lines.join("\n");
}
