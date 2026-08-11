export type ArtifactSnapshotEntry = { key: string; hash: string };

export type PublishState =
  | "pending"
  | "approved"
  | "declined"
  | "pushed"
  | "failed";

export type ReleaseCandidate = {
  runId: string;
  approvedArtifactKeys: ArtifactSnapshotEntry[];
  commitHash?: string;
  commitBranch?: string;
  publishState: PublishState;
  publishError?: string;
  pushedAt?: number;
};

export function createReleaseCandidate(args: {
  runId: string;
  approvedArtifactKeys: ArtifactSnapshotEntry[];
}): ReleaseCandidate {
  return {
    runId: args.runId,
    approvedArtifactKeys: args.approvedArtifactKeys,
    publishState: "pending",
  };
}

const PUBLISH_TRANSITIONS: Record<PublishState, PublishState[]> = {
  pending: ["approved", "declined", "failed"],
  approved: ["pushed", "failed"],
  declined: [],
  pushed: [],
  failed: ["pending"],
};

export function transitionPublishState(
  candidate: ReleaseCandidate,
  next: PublishState,
): ReleaseCandidate {
  const allowed = PUBLISH_TRANSITIONS[candidate.publishState];
  if (!allowed.includes(next)) return candidate;
  return { ...candidate, publishState: next };
}
