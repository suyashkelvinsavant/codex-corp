import { describe, expect, it } from "vitest";
import { mediatorToolConfirmation } from "./mediator-ui";

describe("mediator action confirmations", () => {
  it.each([
    ["company_run", "Allow Byte to run?", "Run workflow"],
    [
      "company_run_from",
      "Allow Byte to run from this node?",
      "Start from node",
    ],
    ["company_approve", "Allow Byte to approve?", "Approve"],
    ["company_decline", "Allow Byte to decline?", "Decline"],
  ])(
    "describes %s as an explicit operator decision",
    (tool, title, confirmLabel) => {
      expect(mediatorToolConfirmation(tool)).toMatchObject({
        title,
        confirmLabel,
        cancelLabel: "Cancel",
      });
    },
  );

  it("does not create confirmations for read-only or unknown tools", () => {
    expect(mediatorToolConfirmation("company_status")).toBeNull();
    expect(mediatorToolConfirmation("unknown_tool")).toBeNull();
  });
});
