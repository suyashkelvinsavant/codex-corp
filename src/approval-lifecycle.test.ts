import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "./model";
import { resolveNativeApproval } from "./approval-lifecycle";

function request(
  id: string,
  nodeId: string,
  status: ApprovalRequest["status"] = "pending",
): ApprovalRequest {
  return {
    id,
    nativeRequestId: `native-${id}`,
    nodeId,
    title: "Approve command execution",
    detail: "{}",
    risk: "test",
    status,
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
