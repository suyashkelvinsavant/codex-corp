import type { ApprovalRequest } from "./model";
import type { MediatorConfirmation, MediatorQuestion } from "./mediator-ui";
import type { LocalTestSession } from "./local-test";

export type DecisionCenterVisibilityArgs = {
  approvals: ApprovalRequest[];
  activeConfirmation: MediatorConfirmation | null;
  activeQuestion: MediatorQuestion | null;
  localTest: LocalTestSession | null;
  manualOpen: boolean;
};

/**
 * Derives whether the decision-center modal should be visible from the
 * actual set of pending decisions, rather than from independent state.
 *
 * This prevents the stale-modal bug where the popup remains open with
 * "No pending decisions" after the last approval has already been resolved.
 */
export function deriveDecisionCenterOpen(
  args: DecisionCenterVisibilityArgs,
): boolean {
  const hasPendingApproval = args.approvals.some(
    (item) => item.status === "pending",
  );
  const hasPendingLocalTest = args.localTest?.status === "launch_pending";
  return (
    hasPendingApproval ||
    args.activeConfirmation !== null ||
    args.activeQuestion !== null ||
    hasPendingLocalTest ||
    args.manualOpen
  );
}
