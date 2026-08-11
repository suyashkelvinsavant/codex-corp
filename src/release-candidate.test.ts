import { describe, expect, it } from "vitest";
import {
  createReleaseCandidate,
  transitionPublishState,
} from "./release-candidate";

describe("release candidate", () => {
  it("starts in pending publish state", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    expect(candidate.publishState).toBe("pending");
  });

  it("transitions publish state from pending to approved", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const next = transitionPublishState(candidate, "approved");
    expect(next.publishState).toBe("approved");
  });

  it("transitions publish state from approved to pushed", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const approved = transitionPublishState(candidate, "approved");
    const pushed = transitionPublishState(approved, "pushed");
    expect(pushed.publishState).toBe("pushed");
  });

  it("does not transition from pushed back to pending", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const pushed = transitionPublishState(
      transitionPublishState(candidate, "approved"),
      "pushed",
    );
    const next = transitionPublishState(pushed, "pending");
    expect(next.publishState).toBe("pushed");
  });

  it("transitions from pending to declined", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const next = transitionPublishState(candidate, "declined");
    expect(next.publishState).toBe("declined");
  });

  it("does not transition from declined to approved", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const declined = transitionPublishState(candidate, "declined");
    const next = transitionPublishState(declined, "approved");
    expect(next.publishState).toBe("declined");
  });

  it("transitions from failed back to pending for retry", () => {
    const candidate = createReleaseCandidate({
      runId: "run1",
      approvedArtifactKeys: [{ key: "a", hash: "h" }],
    });
    const failed = transitionPublishState(candidate, "failed");
    const next = transitionPublishState(failed, "pending");
    expect(next.publishState).toBe("pending");
  });
});
