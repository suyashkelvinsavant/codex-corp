import { expect, test } from "@playwright/test";
import { validateWorkflow } from "../src/graph";
import { makeTestWorkflow } from "../src/test-workflow-fixture";

/**
 * Exercise the renderer against a deterministic Tauri IPC boundary. This is
 * intentionally a browser test rather than a component snapshot: it proves
 * the persisted native session becomes a visible approval modal and then a
 * workflow-chat test card after the operator approves launch.
 */
test("Release Bundle local test moves from approval modal into workflow chat", async ({
  page,
}) => {
  const workflow = JSON.parse(JSON.stringify(makeTestWorkflow()));
  workflow.nodes = workflow.nodes.map((node: { data: { kind: string } }) =>
    node.data.kind === "input"
      ? { ...node, data: { ...node.data, output: "Build a test app" } }
      : node.data.kind === "agent" || node.data.kind === "creative"
        ? { ...node, data: { ...node.data, model: "gpt-5.6" } }
        : node,
  );
  expect(validateWorkflow(workflow.nodes, workflow.edges)).toEqual([]);
  const pending = {
    id: "local-test-browser-1",
    workflowId: workflow.id,
    runId: "run-browser-1",
    workspacePath: "C:/fixture/release",
    status: "launch_pending",
    plan: {
      kind: "package-script",
      program: "npm.cmd",
      args: ["run", "dev"],
      cwd: "C:/fixture/release",
      entrypoint: "package.json#scripts.dev",
      displayCommand: "npm.cmd run dev",
      script: "vite --host 127.0.0.1",
    },
    feedback: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    detectedUrl: "http://127.0.0.1:4173",
  };

  await page.addInitScript(
    ({ catalogItem, initialSession }) => {
      const callbacks = new Map<number, (event: unknown) => void>();
      let callbackId = 0;
      let session = initialSession;
      const emptyChat = JSON.stringify({ sessions: [], activeSessionId: null });
      const calls: Array<{ command: string; args: Record<string, unknown> }> =
        [];
      (
        window as typeof window & { __localTestCalls?: typeof calls }
      ).__localTestCalls = calls;

      (window as typeof window & { isTauri?: boolean }).isTauri = true;
      (
        window as typeof window & {
          __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
        }
      ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener() {
          /* deterministic browser fixture */
        },
      };
      (
        window as typeof window & { __TAURI_INTERNALS__?: unknown }
      ).__TAURI_INTERNALS__ = {
        transformCallback(callback: (event: unknown) => void) {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          calls.push({ command, args });
          if (command === "list_workflow_catalog") {
            return [JSON.stringify(catalogItem)];
          }
          if (command === "get_local_test") {
            return args.workflowId === catalogItem.id ? session : null;
          }
          if (command === "approve_local_test_launch") {
            session = {
              ...session,
              status: "running",
              pid: 4321,
            };
            return session;
          }
          if (command === "submit_local_test_feedback") {
            session = {
              ...session,
              status: args.approved ? "approved" : "changes_requested",
              pid: null,
              feedback: args.approved ? [] : [String(args.feedback ?? "")],
            };
            return session;
          }
          if (command === "stop_local_test") {
            session = { ...session, status: "stopped", pid: null };
            return session;
          }
          if (command === "get_chat_store") return emptyChat;
          if (command === "list_runs") return [];
          if (command === "list_portfolio_run_summaries") return [];
          if (command === "get_app_settings") return { costPer1kTokensUsd: 0 };
          if (command === "discover_codex") {
            return {
              found: true,
              version: "codex-cli 0.144.1",
              compatible: true,
              appServerAvailable: true,
              supportedRange: "codex-cli 0.140–0.150",
              lastTestedVersion: "codex-cli 0.144.1",
              selectedSource: "System CLI",
              fallbackAvailable: false,
              capabilities: [],
            };
          }
          if (command === "list_codex_models") {
            return [
              {
                id: "gpt-5.6",
                model: "gpt-5.6",
                displayName: "GPT-5.6",
                effortOptions: ["low"],
                defaultEffort: "low",
              },
            ];
          }
          if (command === "list_codex_capabilities") return {};
          if (command === "validate_workflow") return [];
          if (command === "start_run") {
            return {
              id: "run-browser-rerun",
              workflowId: catalogItem.id,
              status: "running",
              createdAt: "2026-08-02T00:01:00.000Z",
            };
          }
          if (command === "get_default_chat_workspace") return "C:/fixture";
          if (command === "choose_chat_workspace") return null;
          if (command === "plugin:event|listen") return callbackId;
          if (command === "plugin:event|unlisten") return null;
          if (command === "plugin:event|emit") return null;
          return null;
        },
      };
    },
    { catalogItem: workflow, initialSession: pending },
  );

  await page.goto("/");
  await page
    .locator(".workflow-card")
    .filter({ hasText: workflow.name })
    .click();

  await expect(
    page.getByRole("heading", { name: "Launch the app for operator testing?" }),
  ).toBeVisible();
  const approvals = page.getByRole("dialog", {
    name: "Approvals & questions",
  });
  await expect(approvals.getByText("npm.cmd run dev")).toBeVisible();
  await expect(approvals.getByText("vite --host 127.0.0.1")).toBeVisible();

  await page.getByRole("button", { name: "Launch for testing" }).click();
  await expect(
    page.getByRole("heading", { name: "Test the local build" }),
  ).toBeVisible();
  await expect(page.getByText("Try the app like a user.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve local test" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Request changes" }),
  ).toBeVisible();

  const feedback = "The save button needs a visible confirmation.";
  await page.getByLabel("Local test feedback").fill(feedback);
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(
    page.getByText(`Operator requested changes after local testing:`),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (
          window as typeof window & {
            __localTestCalls?: Array<{
              command: string;
              args: Record<string, unknown>;
            }>;
          }
        ).__localTestCalls?.some((call) => call.command === "start_run"),
      ),
    )
    .toBe(true);
  const savedGraph = await page.evaluate(() => {
    const calls =
      (
        window as typeof window & {
          __localTestCalls?: Array<{
            command: string;
            args: Record<string, unknown>;
          }>;
        }
      ).__localTestCalls?.filter((item) => item.command === "save_workflow") ??
      [];
    const snapshot = calls.at(-1)?.args.snapshot as
      { graphJson?: string } | undefined;
    return snapshot?.graphJson ? JSON.parse(snapshot.graphJson) : null;
  });
  expect(
    savedGraph.nodes.find(
      (node: { data: { kind: string } }) => node.data.kind === "input",
    ).data.userTestFeedback,
  ).toContain(feedback);
});
