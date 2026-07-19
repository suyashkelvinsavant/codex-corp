import { describe, expect, it } from "vitest";
import {
  advisoryAllowList,
  formatLiveToolBoundaryBlock,
  permissionGrantLabel,
  toolsUiHelperText,
} from "./tool-boundary";

describe("tool boundary honesty", () => {
  it("strips legacy MCP labels from the advisory allow-list", () => {
    expect(
      advisoryAllowList(["Shell", "MCP servers", "Web search", "  "]),
    ).toEqual(["Shell", "Web search"]);
  });

  it("labels visible grants as advisory for Live Codex", () => {
    expect(permissionGrantLabel("Shell", false)).toBe("denied");
    expect(permissionGrantLabel("Shell", true)).toBe("advisory");
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
    expect(block).not.toMatch(/MCP servers/i);
  });

  it("labels choices as preferences and identifies the real boundary", () => {
    expect(toolsUiHelperText()).toMatch(/execution preferences/i);
    expect(toolsUiHelperText()).toMatch(/not per-tool access controls/i);
    expect(toolsUiHelperText()).toMatch(
      /sandbox.*permission profile.*approval policy/i,
    );
    expect(toolsUiHelperText()).not.toMatch(/Demo mode/i);
  });
});
