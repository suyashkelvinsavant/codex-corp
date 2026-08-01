import { describe, expect, it } from "vitest";
import {
  parseVerificationLoopNode,
  parseVerificationLoops,
  summarizeVerificationLoops,
} from "./analytics";

describe("analytics verification loops", () => {
  it("parses per-node reports from the command response", () => {
    const reports = parseVerificationLoops({
      runId: "run-1",
      nodes: [
        {
          nodeId: "reviewer",
          verificationRevisions: 2,
          criterionIds: ["cmd-1", "arch-1"],
        },
        { nodeId: "qa", verificationRevisions: 1, criterionIds: ["hidden-1"] },
      ],
    });
    expect(reports.length).toBe(2);
    expect(reports[0]).toEqual({
      nodeId: "reviewer",
      verificationRevisions: 2,
      criterionIds: ["cmd-1", "arch-1"],
    });
    expect(reports[1].criterionIds).toEqual(["hidden-1"]);
  });

  it("degrades to empty for malformed / non-array payloads", () => {
    expect(parseVerificationLoops(undefined)).toEqual([]);
    expect(parseVerificationLoops(null)).toEqual([]);
    expect(parseVerificationLoops("boom")).toEqual([]);
    expect(parseVerificationLoops({ nodes: "not-an-array" })).toEqual([]);
    expect(
      parseVerificationLoops({ nodes: [null, "x", { nodeId: "" }] }),
    ).toEqual([]);
  });

  it("normalizes string revision counts and drops non-positive rows", () => {
    expect(
      parseVerificationLoopNode({
        nodeId: "a",
        verificationRevisions: "3",
        criterionIds: ["c1"],
      }),
    ).toEqual({
      nodeId: "a",
      verificationRevisions: 3,
      criterionIds: ["c1"],
    });
    expect(
      parseVerificationLoopNode({ nodeId: "b", verificationRevisions: 0 }),
    ).toBeNull();
    expect(
      parseVerificationLoopNode({ nodeId: "c", verificationRevisions: -1 }),
    ).toBeNull();
    expect(
      parseVerificationLoopNode({
        nodeId: "d",
        verificationRevisions: 1,
        criterionIds: [1, "c2", null],
      }),
    ).toEqual({
      nodeId: "d",
      verificationRevisions: 1,
      criterionIds: ["c2"],
    });
  });

  it("summarizes totals for the inspector chip", () => {
    const summary = summarizeVerificationLoops([
      { nodeId: "reviewer", verificationRevisions: 2, criterionIds: ["cmd-1"] },
    ]);
    expect(summary.total).toBe(2);
    expect(summary.byNode[0].nodeId).toBe("reviewer");
  });

  it("produces an empty summary with no reports", () => {
    expect(summarizeVerificationLoops([]).total).toBe(0);
  });
});
