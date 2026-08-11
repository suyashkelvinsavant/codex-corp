import { describe, expect, it } from "vitest";
import { deriveDecisionCenterOpen } from "./decision-center-visibility";
import type { DecisionCenterVisibilityArgs } from "./decision-center-visibility";

describe("decision center visibility", () => {
  const baseArgs: DecisionCenterVisibilityArgs = {
    approvals: [],
    activeConfirmation: null,
    activeQuestion: null,
    localTest: null,
    manualOpen: false,
  };

  it("is closed when there are no pending decisions and no manual open", () => {
    expect(deriveDecisionCenterOpen(baseArgs)).toBe(false);
  });

  it("is open when a native approval is pending", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        approvals: [
          {
            id: "a1",
            nodeId: "n1",
            title: "t",
            detail: "d",
            risk: "r",
            status: "pending",
          },
        ],
      }),
    ).toBe(true);
  });

  it("is closed when all approvals are resolved and no other decision is pending", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        approvals: [
          {
            id: "a1",
            nodeId: "n1",
            title: "t",
            detail: "d",
            risk: "r",
            status: "approved",
          },
          {
            id: "a2",
            nodeId: "n2",
            title: "t",
            detail: "d",
            risk: "r",
            status: "declined",
          },
        ],
      }),
    ).toBe(false);
  });

  it("is open when a confirmation is active", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        activeConfirmation: { id: "c1" } as never,
      }),
    ).toBe(true);
  });

  it("is open when a question is active", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        activeQuestion: { id: "q1" } as never,
      }),
    ).toBe(true);
  });

  it("is open when local test launch is pending", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        localTest: { status: "launch_pending" } as never,
      }),
    ).toBe(true);
  });

  it("is open when manually opened with no pending decisions", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        manualOpen: true,
      }),
    ).toBe(true);
  });

  it("is closed when manually closed and no pending decisions remain", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        manualOpen: false,
      }),
    ).toBe(false);
  });

  it("is open when both a pending approval and manual open exist", () => {
    expect(
      deriveDecisionCenterOpen({
        ...baseArgs,
        approvals: [
          {
            id: "a1",
            nodeId: "n1",
            title: "t",
            detail: "d",
            risk: "r",
            status: "pending",
          },
        ],
        manualOpen: true,
      }),
    ).toBe(true);
  });
});
