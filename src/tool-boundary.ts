/**
 * Tool / permission boundary helpers for Live Codex.
 *
 * Selected tools (except MCP) become an advisory allow-list text block
 * injected into the agent turn. The Codex app-server owns sandbox + approval
 * policy; this product does not hard-enforce tool ACLs and does not connect MCP.
 */

export const MCP_TOOL_LABEL = "MCP servers";

export const STANDARD_TOOL_LABELS = [
  "Workspace read",
  "Workspace write",
  "Shell",
  "Network",
  "Web search",
  MCP_TOOL_LABEL,
] as const;

export function isMcpToolLabel(label: string): boolean {
  return label.trim().toLowerCase().includes("mcp");
}

/** Tools that can appear in a Live advisory allow-list (excludes MCP). */
export function advisoryAllowList(tools: string[]): string[] {
  return tools
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0 && !isMcpToolLabel(tool));
}

export function mcpIsSelected(tools: string[]): boolean {
  return tools.some(isMcpToolLabel);
}

export function permissionGrantLabel(tool: string, granted: boolean): string {
  if (!granted) return "denied";
  if (isMcpToolLabel(tool)) return "not connected";
  return "advisory";
}

export function mcpStatusLabel(tools: string[]): string {
  return mcpIsSelected(tools) ? "Selected · not connected" : "Not selected";
}

export function toolsUiHelperText(): string {
  return "Live Codex injects non-MCP grants as an advisory allow-list into the agent prompt. Workspace sandbox and approval policy are applied by the Codex app-server. MCP is not connected here. Explicit one-time approvals still apply for tool actions.";
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
  if (mcpIsSelected(input.tools)) {
    lines.push(
      "MCP servers: selected in the UI but NOT connected in this product—do not assume MCP tools exist.",
    );
  } else {
    lines.push("MCP servers: not selected and not connected.");
  }
  return lines.join("\n");
}
