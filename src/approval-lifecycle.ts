import type { ApprovalRequest } from "./model";

export type NativeApprovalResolution = {
  requests: ApprovalRequest[];
  resumeNodeId: string | null;
};

/**
 * Resolve one native approval without releasing a node that already has a
 * subsequent pending request. Stale/duplicate responses are intentionally
 * idempotent because both the native event and invoke completion may observe
 * the same resolution.
 */
export function resolveNativeApproval(
  requests: ApprovalRequest[],
  nativeRequestId: string,
  status: "approved" | "declined",
): NativeApprovalResolution {
  const match = requests.find(
    (request) =>
      request.nativeRequestId === nativeRequestId &&
      request.status === "pending",
  );
  if (!match) return { requests, resumeNodeId: null };

  const next = requests.map((request) =>
    request === match ? { ...request, status } : request,
  );
  const stillPendingForNode = next.some(
    (request) =>
      request.nodeId === match.nodeId && request.status === "pending",
  );
  return {
    requests: next,
    resumeNodeId: stillPendingForNode ? null : match.nodeId,
  };
}

/**
 * Remove pending run-scoped approvals when a run completes or terminates.
 * Already-resolved approvals are preserved for audit. Non-run-scoped approvals
 * (native Codex tool approvals without a runId) are left untouched.
 */
export function clearRunApprovals(
  approvals: ApprovalRequest[],
  runId: string,
): ApprovalRequest[] {
  return approvals.filter(
    (item) => !(item.runId === runId && item.status === "pending"),
  );
}
