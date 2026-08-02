import { describe, expect, it } from "vitest";
import {
  buildDeliveryBundle,
  deliveryStatusFromRun,
  deriveDeliveryStatus,
  pairCompareFailed,
  type DeliveryArtifactRef,
  type VerificationRow,
} from "./delivery-bundle";

const ARTIFACT_REF: DeliveryArtifactRef = {
  artifactKey: "builder::0::App.jsx",
  contentHash: "sha256:abc",
  sourceNodeId: "builder",
  name: "App.jsx",
  hostOrdinal: 0,
};

const PASSING_VERIFICATION: VerificationRow[] = [
  {
    id: "cmd-1",
    kind: "command",
    passed: true,
    enforcement: "required",
    detail: "npm_test green",
    source: "runtime",
  },
];

describe("delivery-bundle", () => {
  it("assembles live delivery-bundle.json with mission and safety metadata", () => {
    const delivery = buildDeliveryBundle({
      mission: "Build a landing page\n\n## Constraints\n- Single page only",
      generatedAt: "2026-01-01T00:00:00.000Z",
      upstreamOutputs: [
        {
          nodeId: "builder",
          role: "Frontend Engineer",
          label: "Build Agent",
          summary: "Implemented landing page",
          data: { filesWritten: ["src/App.jsx"] },
          artifacts: [
            {
              id: "1",
              name: "App.jsx",
              kind: "code",
              content: "export default function App() {}",
            },
          ],
        },
      ],
    });
    expect(delivery.data.schemaVersion).toBe("codex-corp.delivery.v3");
    expect(delivery.data.mode).toBe("preview");
    expect(delivery.data.mission).toContain("Single page only");
    expect(delivery.data.safety.approval).toBe("explicit-human");
    expect(delivery.data.safety.chainOfThought).toBe("not-exposed");
    expect(delivery.data.safety.passBitOwner).toBe("runtime");
    // Pair-compare fields always present (empty in pure preview without freeze).
    expect(Array.isArray(delivery.data.approvedArtifacts)).toBe(true);
    expect(Array.isArray(delivery.data.liveArtifactRefs)).toBe(true);
    // residualRisks: empty approval set is an honest residual in preview.
    expect(delivery.data.residualRisks).toContain(
      "empty_approval_artifact_set",
    );
    // Fail-closed: no runtime verification rows → pending, never pass.
    expect(delivery.data.status).toBe("pending");
    expect(delivery.data.review.outcome).toBe("pending");
    expect(delivery.data.verificationSummary).toBeUndefined();
    expect(delivery.artifacts[0]?.name).toBe("delivery-bundle.json");
    expect(delivery.artifacts[0]?.content).toContain("codex-corp.delivery.v3");
  });

  it("labels a purely handoff-driven preview as pending (never pass)", () => {
    const delivery = buildDeliveryBundle({
      mission: "x",
      generatedAt: "2026-01-01T00:00:00.000Z",
      upstreamOutputs: [
        {
          nodeId: "reviewer",
          role: "QA + Reviewer",
          label: "Quality Gate",
          summary: "Pass",
          data: { verdict: "pass", revision: 0 },
          artifacts: [],
        },
      ],
    });
    // Even a reviewer verdict of pass cannot produce a success without runtime rows.
    expect(delivery.data.status).toBe("pending");
  });

  it("adds claim residual only when criteria evidence is present", () => {
    const delivery = buildDeliveryBundle({
      mission: "x",
      generatedAt: "2026-01-01T00:00:00.000Z",
      upstreamOutputs: [
        {
          nodeId: "builder",
          role: "Builder",
          label: "Builder",
          summary: "Done",
          data: {
            criteria: [{ id: "c1", claim: "satisfied", evidence: "ok" }],
          },
          artifacts: [],
        },
      ],
    });
    expect(delivery.data.residualRisks).toContain(
      "claim_criteria_are_advisory_only",
    );
    expect(delivery.data.residualRisks).toContain(
      "empty_approval_artifact_set",
    );
    expect(delivery.data.safety.approval).toBe("explicit-human");
    expect(delivery.data.status).toBe("pending");
  });

  it("emits success only when runtime verification rows back a non-empty approved set", () => {
    const delivery = buildDeliveryBundle({
      mission: "x",
      generatedAt: "2026-01-01T00:00:00.000Z",
      verificationResults: PASSING_VERIFICATION,
      approvedArtifacts: [ARTIFACT_REF],
      liveArtifactRefs: [ARTIFACT_REF],
      upstreamOutputs: [
        {
          nodeId: "builder",
          role: "Builder",
          label: "Builder",
          summary: "Done",
          data: { filesWritten: ["src/App.jsx"] },
          artifacts: [
            {
              id: "1",
              name: "App.jsx",
              kind: "code",
              content: "x",
            },
          ],
        },
      ],
    });
    expect(delivery.data.status).toBe("success");
    expect(delivery.data.review.outcome).toBe("pass");
    expect(delivery.data.verificationSummary).toEqual([
      {
        results: PASSING_VERIFICATION,
        requiredFailed: [],
        passBitOwner: "runtime",
      },
    ]);
  });

  it("fails closed when a runtime verification row reports passed:false", () => {
    const row: VerificationRow = {
      id: "cmd-1",
      kind: "command",
      passed: false,
      enforcement: "required",
      detail: "npm_test exited 1",
      source: "runtime",
    };
    const delivery = buildDeliveryBundle({
      mission: "x",
      generatedAt: "2026-01-01T00:00:00.000Z",
      verificationResults: [row],
      approvedArtifacts: [ARTIFACT_REF],
      liveArtifactRefs: [ARTIFACT_REF],
      upstreamOutputs: [
        {
          nodeId: "builder",
          role: "Builder",
          label: "Builder",
          summary: "Done",
          data: {},
          artifacts: [],
        },
      ],
    });
    expect(delivery.data.status).toBe("failed");
    expect(delivery.data.review.outcome).toBe("fail");
    expect(delivery.data.verificationSummary).toEqual([
      { results: [row], requiredFailed: ["cmd-1"], passBitOwner: "runtime" },
    ]);
  });

  it("stays pending even when verification rows pass but the approval set is empty", () => {
    const status = deriveDeliveryStatus({
      upstreamOutputs: [],
      verificationResults: PASSING_VERIFICATION,
      approvedArtifacts: [],
      liveArtifactRefs: [],
    });
    expect(status).toBe("pending");
  });
});

describe("delivery-bundle fail-closed pair-compare", () => {
  it("passes when approved and live sets match exactly", () => {
    expect(pairCompareFailed([ARTIFACT_REF], [ARTIFACT_REF])).toBe(false);
  });

  it("passes for empty-to-empty (no file artifacts)", () => {
    expect(pairCompareFailed([], [])).toBe(false);
  });

  it("flags a hash mismatch against the approved snapshot", () => {
    const stale: DeliveryArtifactRef = {
      ...ARTIFACT_REF,
      contentHash: "sha256:stale",
    };
    expect(pairCompareFailed([ARTIFACT_REF], [stale])).toBe(true);
    expect(
      deriveDeliveryStatus({
        upstreamOutputs: [],
        verificationResults: PASSING_VERIFICATION,
        approvedArtifacts: [ARTIFACT_REF],
        liveArtifactRefs: [stale],
      }),
    ).toBe("failed");
  });

  it("flags a live key that is not in the approved set", () => {
    const extra: DeliveryArtifactRef = {
      ...ARTIFACT_REF,
      artifactKey: "builder::1::new.ts",
      hostOrdinal: 1,
    };
    expect(pairCompareFailed([ARTIFACT_REF], [ARTIFACT_REF, extra])).toBe(true);
    expect(
      deriveDeliveryStatus({
        upstreamOutputs: [],
        verificationResults: PASSING_VERIFICATION,
        approvedArtifacts: [ARTIFACT_REF],
        liveArtifactRefs: [ARTIFACT_REF, extra],
      }),
    ).toBe("failed");
  });

  it("flags an approved key missing from live", () => {
    expect(pairCompareFailed([ARTIFACT_REF], [])).toBe(true);
    expect(
      deriveDeliveryStatus({
        upstreamOutputs: [],
        verificationResults: PASSING_VERIFICATION,
        approvedArtifacts: [ARTIFACT_REF],
        liveArtifactRefs: [],
      }),
    ).toBe("failed");
  });

  it("flags handoff failures before trusting verification-free rows", () => {
    expect(
      deriveDeliveryStatus({
        upstreamOutputs: [{ nodeId: "b", data: { status: "failure" } }],
        verificationResults: PASSING_VERIFICATION,
        approvedArtifacts: [ARTIFACT_REF],
        liveArtifactRefs: [ARTIFACT_REF],
      }),
    ).toBe("failed");
  });
});

describe("deliveryStatusFromRun", () => {
  it("is pending for a run with no delivery bundle", () => {
    expect(deliveryStatusFromRun({ runStatus: "completed" })).toBe("pending");
    expect(
      deliveryStatusFromRun({ runStatus: "completed", nodesJson: "oops" }),
    ).toBe("pending");
  });

  it("is failed for a failed or cancelled run regardless of snapshot", () => {
    expect(deliveryStatusFromRun({ runStatus: "failed" })).toBe("failed");
    expect(deliveryStatusFromRun({ runStatus: "cancelled" })).toBe("failed");
  });

  it("reads a trusted bundle from the output node snapshot", () => {
    const nodesJson = JSON.stringify([
      { id: "builder", data: { kind: "agent" } },
      {
        id: "output",
        data: {
          kind: "output",
          structuredOutput: {
            status: "success",
            approvedArtifacts: [ARTIFACT_REF],
            liveArtifactRefs: [ARTIFACT_REF],
            verificationSummary: [
              { results: PASSING_VERIFICATION, passBitOwner: "runtime" },
            ],
          },
        },
      },
    ]);
    expect(deliveryStatusFromRun({ runStatus: "completed", nodesJson })).toBe(
      "success",
    );
  });

  it("flags a stale preview bundle as failed", () => {
    const nodesJson = JSON.stringify([
      {
        id: "output",
        data: {
          kind: "output",
          structuredOutput: {
            status: "success",
            approvedArtifacts: [ARTIFACT_REF],
            liveArtifactRefs: [
              { ...ARTIFACT_REF, contentHash: "sha256:stale" },
            ],
            verificationSummary: [
              { results: PASSING_VERIFICATION, passBitOwner: "runtime" },
            ],
          },
        },
      },
    ]);
    expect(deliveryStatusFromRun({ runStatus: "completed", nodesJson })).toBe(
      "failed",
    );
  });
});
