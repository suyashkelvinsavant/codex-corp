import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DecisionCenterModal } from "./decision-center-modal";

describe("DecisionCenterModal", () => {
  it("renders Byte action confirmations as an in-app modal", () => {
    const markup = renderToStaticMarkup(
      createElement(DecisionCenterModal, {
        approvals: [],
        confirmation: {
          title: "Allow Byte to run?",
          body: "Byte requested permission to start the current workflow.",
          confirmLabel: "Run workflow",
          cancelLabel: "Cancel",
        },
        question: null,
        selectedOptions: [],
        freeText: "",
        onFreeTextChange: vi.fn(),
        onToggleOption: vi.fn(),
        onDecideApproval: vi.fn(),
        onResolveConfirmation: vi.fn(),
        onResolveQuestion: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("BYTE ACTION REQUEST");
    expect(markup).toContain("Allow Byte to run?");
    expect(markup).toContain(
      "Byte requested permission to start the current workflow.",
    );
    expect(markup).toContain("Run workflow");
    expect(markup).toContain("Cancel");
  });

  it("keeps long approval content in a wrapping, vertically scrollable surface", () => {
    const longCommand =
      '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64\\pwsh.exe" -Command Get-ChildItem -Force -Recurse -Filter package.json';
    const markup = renderToStaticMarkup(
      createElement(DecisionCenterModal, {
        approvals: [
          {
            id: "approval-long-command",
            nodeId: "qa",
            title: "Approve command execution",
            detail: longCommand,
            risk: "May inspect project files.",
            status: "pending",
            structured: {
              kind: "execCommand",
              command: longCommand,
              cwd: "C:\\workspace\\CodexCorp\\workspaces\\company-mediator",
            },
          },
        ],
        confirmation: null,
        question: null,
        selectedOptions: [],
        freeText: "",
        onFreeTextChange: vi.fn(),
        onToggleOption: vi.fn(),
        onDecideApproval: vi.fn(),
        onResolveConfirmation: vi.fn(),
        onResolveQuestion: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(markup).toContain('class="structured-command"');
    expect(markup).toContain("Get-ChildItem");
  });

  it("renders local test launch approval with the exact user-visible launch details", () => {
    const markup = renderToStaticMarkup(
      createElement(DecisionCenterModal, {
        approvals: [],
        confirmation: null,
        question: null,
        selectedOptions: [],
        freeText: "",
        onFreeTextChange: vi.fn(),
        onToggleOption: vi.fn(),
        onDecideApproval: vi.fn(),
        onResolveConfirmation: vi.fn(),
        onResolveQuestion: vi.fn(),
        onResolveLocalTestLaunch: vi.fn(),
        localTest: {
          id: "local-test-1",
          workflowId: "workflow-1",
          runId: "run-1",
          workspacePath: "C:/projects/shipit",
          status: "launch_pending",
          plan: {
            kind: "package-script",
            program: "npm.cmd",
            args: ["run", "dev"],
            cwd: "C:/projects/shipit",
            entrypoint: "package.json#scripts.dev",
            displayCommand: "npm.cmd run dev",
            script: "vite --host 127.0.0.1",
          },
          feedback: [],
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          detectedUrl: "http://127.0.0.1:4173",
        },
        onClose: vi.fn(),
      }),
    );

    expect(markup).toContain("LOCAL TEST · RELEASE BUNDLE");
    expect(markup).toContain("Launch for testing");
    expect(markup).toContain("npm.cmd run dev");
    expect(markup).toContain("vite --host 127.0.0.1");
    expect(markup).toContain("Open: http://127.0.0.1:4173");
  });
});
