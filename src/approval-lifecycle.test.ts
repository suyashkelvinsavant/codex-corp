import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "./model";
import { clearRunApprovals, resolveNativeApproval } from "./approval-lifecycle";

function request(
  id: string,
  nodeId: string,
  status: ApprovalRequest["status"] = "pending",
  runId?: string,
): ApprovalRequest {
  return {
    id,
    nativeRequestId: `native-${id}`,
    nodeId,
    title: "Approve command execution",
    detail: "{}",
    risk: "test",
    status,
    runId,
  };
}

describe("native approval lifecycle", () => {
  it("resumes a node after its only approval is accepted", () => {
    const result = resolveNativeApproval(
      [request("one", "builder")],
      "native-one",
      "approved",
    );
    expect(result.requests[0].status).toBe("approved");
    expect(result.resumeNodeId).toBe("builder");
  });

  it("resumes a node after its only approval is declined", () => {
    const result = resolveNativeApproval(
      [request("one", "builder")],
      "native-one",
      "declined",
    );
    expect(result.requests[0].status).toBe("declined");
    expect(result.resumeNodeId).toBe("builder");
  });

  it("does not resume between two sequential approvals for the same node", () => {
    const result = resolveNativeApproval(
      [request("one", "builder"), request("two", "builder")],
      "native-one",
      "approved",
    );
    expect(result.resumeNodeId).toBeNull();
    expect(result.requests.map((item) => item.status)).toEqual([
      "approved",
      "pending",
    ]);
  });

  it("ignores a stale or duplicate native approval response", () => {
    const original = [request("one", "builder", "approved")];
    const result = resolveNativeApproval(original, "missing", "declined");
    expect(result.requests).toBe(original);
    expect(result.resumeNodeId).toBeNull();
  });

  it("does not let another node's pending approval pin the resolved node", () => {
    const result = resolveNativeApproval(
      [request("one", "builder"), request("two", "qa")],
      "native-one",
      "approved",
    );
    expect(result.resumeNodeId).toBe("builder");
    expect(result.requests[1].status).toBe("pending");
  });
});

describe("clearRunApprovals", () => {
  it("removes pending run-scoped approvals for the completed run", () => {
    const approvals = [
      request("a1", "n1", "pending", "run1"),
      request("a2", "n2", "pending", "run2"),
      request("a3", "n3", "approved", "run1"),
    ];
    const result = clearRunApprovals(approvals, "run1");
    expect(result.map((a) => a.id)).toEqual(["a2", "a3"]);
  });

  it("leaves non-run-scoped approvals untouched", () => {
    const approvals = [request("a1", "n1", "pending")];
    const result = clearRunApprovals(approvals, "run1");
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });

  it("leaves already-resolved run-scoped approvals untouched", () => {
    const approvals = [
      request("a1", "n1", "approved", "run1"),
      request("a2", "n2", "declined", "run1"),
    ];
    const result = clearRunApprovals(approvals, "run1");
    expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});
