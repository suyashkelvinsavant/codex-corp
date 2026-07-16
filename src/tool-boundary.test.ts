import { describe, expect, it } from "vitest";
import {
  advisoryAllowList,
  formatLiveToolBoundaryBlock,
  isMcpToolLabel,
  mcpStatusLabel,
  permissionGrantLabel,
  toolsUiHelperText,
} from "./tool-boundary";

describe("tool boundary honesty", () => {
  it("classifies MCP labels and strips them from the advisory allow-list", () => {
    expect(isMcpToolLabel("MCP servers")).toBe(true);
    expect(isMcpToolLabel("Shell")).toBe(false);
    expect(
      advisoryAllowList(["Shell", "MCP servers", "Web search", "  "]),
    ).toEqual(["Shell", "Web search"]);
  });

  it("labels grants as advisory for Live Codex (MCP never connected)", () => {
    expect(permissionGrantLabel("Shell", false)).toBe("denied");
    expect(permissionGrantLabel("Shell", true)).toBe("advisory");
    expect(permissionGrantLabel("MCP servers", true)).toBe("not connected");
    expect(mcpStatusLabel(["Shell"])).toBe("Not selected");
    expect(mcpStatusLabel(["MCP servers"])).toBe("Selected · not connected");
  });

  it("formats a Live boundary block with allow-list and disclaimers", () => {
    const block = formatLiveToolBoundaryBlock({
      tools: ["Shell", "Workspace write", "MCP servers"],
      approvalPolicy: "on-request",
      sandboxProfile: "workspace-write",
      workspacePolicy: "isolated",
    });
    expect(block).toContain("advisory prompt constraint");
    expect(block).toContain("Preferred tools only: Shell, Workspace write");
    expect(block).not.toMatch(/Preferred tools only:.*MCP/);
    expect(block).toContain("Approval policy: on-request");
    expect(block).toContain("NOT connected");
  });

  it("uses Live-only UI helper copy (no mode flag)", () => {
    expect(toolsUiHelperText()).toMatch(/advisory allow-list/i);
    expect(toolsUiHelperText()).toMatch(/MCP is not connected/i);
    expect(toolsUiHelperText()).not.toMatch(/Demo mode/i);
  });
});
