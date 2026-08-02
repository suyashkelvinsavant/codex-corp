import type { FlowEdge, FlowNode } from "./model";

export type LocalTestStatus =
  | "launch_pending"
  | "launching"
  | "running"
  | "exited"
  | "launch_failed"
  | "declined"
  | "stopped"
  | "approved"
  | "changes_requested";

export type LocalLaunchPlan = {
  kind: "package-script" | "manifest" | "cargo" | "static";
  program: string;
  args: string[];
  cwd: string;
  entrypoint: string;
  displayCommand: string;
  script?: string;
};

export type LocalTestSession = {
  id: string;
  workflowId: string;
  runId: string;
  workspacePath: string;
  status: LocalTestStatus;
  plan: LocalLaunchPlan;
  feedback: string[];
  createdAt: string;
  updatedAt: string;
  pid?: number;
  lastError?: string;
  detectedUrl?: string;
};

const MAX_FEEDBACK_ITEMS = 8;
const MAX_FEEDBACK_LENGTH = 4_000;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 2_000;
const MAX_ENTRYPOINT_LENGTH = 4_000;
const MAX_DISPLAY_COMMAND_LENGTH = 32_000;
const SAFE_RESOLVED_PROGRAMS = new Set([
  "npm",
  "npm.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "yarn.cmd",
  "bun",
  "bun.exe",
  "python",
  "python.exe",
  "cargo",
  "cargo.exe",
]);
const SHELL_PROGRAMS = new Set([
  "cmd",
  "cmd.exe",
  "command.com",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "bash",
  "zsh",
  "wsl",
  "wsl.exe",
  "start",
  "start.exe",
]);

export function appendOperatorTestFeedback(
  existing: string[],
  feedback: string,
): string[] {
  const normalized = normalizeFeedback(feedback);
  if (!normalized) return existing.slice(-MAX_FEEDBACK_ITEMS);
  const withoutDuplicate = existing.filter(
    (item) => normalizeFeedback(item) !== normalized,
  );
  return [...withoutDuplicate, normalized].slice(-MAX_FEEDBACK_ITEMS);
}

export function applyLocalTestDecision(
  session: LocalTestSession,
  decision: "approve" | "request_changes",
  feedback: string,
): { ok: true; session: LocalTestSession } | { ok: false; error: string } {
  if (session.status !== "running" && session.status !== "exited") {
    return {
      ok: false,
      error: "The local test must be running before it can be reviewed.",
    };
  }
  const normalized = normalizeFeedback(feedback);
  if (decision === "request_changes" && !normalized) {
    return {
      ok: false,
      error:
        "Add at least one concrete piece of test feedback before requesting changes.",
    };
  }
  return {
    ok: true,
    session: {
      ...session,
      status: decision === "approve" ? "approved" : "changes_requested",
      feedback: normalized
        ? appendOperatorTestFeedback(session.feedback, normalized)
        : session.feedback,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Validate a native launch plan before showing or executing it in the UI.
 * Native validation remains authoritative; this duplicate is intentional so a
 * compromised/stale renderer cannot turn an unsafe plan into a clickable action.
 */
export function isSafeLocalLaunchPlan(
  plan: LocalLaunchPlan,
  workspacePath?: string,
): { ok: true } | { ok: false; reason: string } {
  if (!plan || typeof plan !== "object") {
    return { ok: false, reason: "launch plan is missing" };
  }
  if (typeof plan.program !== "string" || !plan.program.trim()) {
    return { ok: false, reason: "launch program is missing" };
  }
  if (typeof plan.cwd !== "string") {
    return { ok: false, reason: "launch working directory is malformed" };
  }
  if (!Array.isArray(plan.args)) {
    return { ok: false, reason: "launch arguments are malformed" };
  }
  if (
    typeof plan.entrypoint !== "string" ||
    !plan.entrypoint.trim() ||
    plan.entrypoint.length > MAX_ENTRYPOINT_LENGTH ||
    hasControlCharacters(plan.entrypoint)
  ) {
    return { ok: false, reason: "launch entrypoint is malformed" };
  }
  if (
    typeof plan.displayCommand !== "string" ||
    !plan.displayCommand.trim() ||
    plan.displayCommand.length > MAX_DISPLAY_COMMAND_LENGTH ||
    hasControlCharacters(plan.displayCommand)
  ) {
    return { ok: false, reason: "launch display command is malformed" };
  }
  if (
    plan.script !== undefined &&
    (typeof plan.script !== "string" ||
      !plan.script.trim() ||
      plan.script.length > MAX_ARG_LENGTH ||
      hasControlCharacters(plan.script))
  ) {
    return { ok: false, reason: "launch package script is malformed" };
  }
  const selectedWorkspacePath = workspacePath ?? plan.cwd;
  if (typeof selectedWorkspacePath !== "string") {
    return { ok: false, reason: "selected workspace is malformed" };
  }
  if (!isAbsolutePath(plan.cwd)) {
    return { ok: false, reason: "launch working directory must be absolute" };
  }
  if (!isAbsolutePath(selectedWorkspacePath)) {
    return { ok: false, reason: "selected workspace must be absolute" };
  }
  if (!isPathInside(plan.cwd, selectedWorkspacePath)) {
    return {
      ok: false,
      reason:
        "launch working directory must remain inside the selected workspace",
    };
  }
  if (hasControlCharacters(plan.program) || hasControlCharacters(plan.cwd)) {
    return { ok: false, reason: "launch plan contains control characters" };
  }
  if (plan.args.length > MAX_ARGS) {
    return { ok: false, reason: "launch plan has too many arguments" };
  }
  if (
    plan.args.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.length > MAX_ARG_LENGTH ||
        hasControlCharacters(arg),
    )
  ) {
    return {
      ok: false,
      reason:
        "launch plan contains control characters or an oversized argument",
    };
  }
  const basename = basenameOf(plan.program).toLowerCase();
  if (SHELL_PROGRAMS.has(basename)) {
    return {
      ok: false,
      reason: "shell interpreters are not allowed as launch programs",
    };
  }
  const knownRuntime = SAFE_RESOLVED_PROGRAMS.has(basename);
  if (isAbsolutePath(plan.program)) {
    if (!knownRuntime && !isPathInside(plan.program, selectedWorkspacePath)) {
      return {
        ok: false,
        reason: "launch executable must remain inside the selected workspace",
      };
    }
  } else if (!knownRuntime) {
    return {
      ok: false,
      reason: "launch program is not a recognized workspace-safe runtime",
    };
  }
  return { ok: true };
}

/** Choose the first reachable producer, preferring a conventional Builder node. */
export function chooseLocalTestRerunNode(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode | undefined {
  const input = nodes.find((node) => node.data.kind === "input");
  if (!input) return undefined;
  const reachable = new Set<string>([input.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (edge.data?.edgeType === "revision") continue;
      if (reachable.has(edge.source) && !reachable.has(edge.target)) {
        reachable.add(edge.target);
        changed = true;
      }
    }
  }
  const producers = nodes.filter(
    (node) =>
      reachable.has(node.id) &&
      (node.data.kind === "agent" || node.data.kind === "creative"),
  );
  return (
    producers.find((node) =>
      /builder|build|producer|implement|frontend|developer/i.test(
        `${node.data.label} ${node.data.role}`,
      ),
    ) ?? producers[0]
  );
}

export type LocalTestRerun =
  | {
      ok: true;
      feedback: string;
      rerunNode: FlowNode;
      nodes: FlowNode[];
    }
  | {
      ok: false;
      error: string;
    };

/** Build the next workflow snapshot only when feedback can reach a producer. */
export function prepareLocalTestRerun(
  nodes: FlowNode[],
  edges: FlowEdge[],
  feedback: string,
): LocalTestRerun {
  const normalizedFeedback = normalizeFeedback(feedback);
  if (!normalizedFeedback) {
    return { ok: false, error: "Local test feedback is required." };
  }
  const rerunNode = chooseLocalTestRerunNode(nodes, edges);
  if (!rerunNode) {
    return {
      ok: false,
      error: "No reachable producer node can receive local test feedback.",
    };
  }
  return {
    ok: true,
    feedback: normalizedFeedback,
    rerunNode,
    nodes: nodes.map((node) =>
      node.data.kind === "input"
        ? {
            ...node,
            data: {
              ...node.data,
              userTestFeedback: appendOperatorTestFeedback(
                node.data.userTestFeedback ?? [],
                normalizedFeedback,
              ),
            },
          }
        : node,
    ),
  };
}

export function formatLocalTestPrompt(session: LocalTestSession): string {
  const url = session.detectedUrl ? `\nOpen: ${session.detectedUrl}` : "";
  const script = session.plan.script ? `\nScript: ${session.plan.script}` : "";
  const instruction =
    session.status === "launch_pending"
      ? "Approve local launch in Approvals to start the app, then test it as a user and report what worked or what needs changing here."
      : "Please test the local build as a user. Report what worked and any concrete issue here, or approve it when it is ready.";
  return [
    "The Release Bundle is ready for a local test.",
    `Run: ${session.plan.displayCommand}`,
    `Folder: ${session.plan.cwd}`,
    `Entry: ${session.plan.entrypoint}${script}${url}`,
    instruction,
  ].join("\n");
}

function normalizeFeedback(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_FEEDBACK_LENGTH);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}|[\\/])/.test(value.trim());
}

function basenameOf(value: string): string {
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

function isPathInside(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedParent = normalizePath(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  );
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  const drive = normalized.match(/^[A-Za-z]:/);
  const prefix = drive
    ? drive[0].toLowerCase()
    : normalized.startsWith("/")
      ? "/"
      : "";
  const body = drive ? normalized.slice(2) : normalized;
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return (
    `${prefix}/${segments.join("/")}`.replace(/\/$/, "").toLowerCase() || "/"
  );
}
