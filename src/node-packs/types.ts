import type { CompletionCriterion } from "../completion-criteria";
import type { Kind } from "../model";

/** Builtin specialist pack — SSOT for role catalog instantiation. */
export type NodePack = {
  id: string;
  version: string;
  label: string;
  role: string;
  kind: "agent" | "creative";
  /** Lower sorts first; empty-agent is intentionally last. */
  menuOrder: number;
  description: string;
  baseInstructions: string;
  developerInstructions: string;
  harnessCoreVersion: string;
  tools: string[];
  skills: string[];
  nonGoals?: string[];
  completionCriteria?: CompletionCriterion[];
  sandboxProfile?: "read-only" | "workspace-write";
  approvalPolicy?: "on-request" | "untrusted" | "never";
};

export type PackKind = NodePack["kind"];

/** Fields written onto a specialist node when a pack is applied. */
export type PackInstantiation = {
  packId: string;
  packVersion: string;
  label: string;
  role: string;
  kind: PackKind;
  description: string;
  baseInstructions: string;
  developerInstructions: string;
  /** Deprecated single-blob mirror of developerInstructions for legacy readers. */
  prompt: string;
  tools: string[];
  skills: string[];
  completionCriteria?: CompletionCriterion[];
  sandboxProfile?: "read-only" | "workspace-write";
  approvalPolicy?: "on-request" | "untrusted" | "never";
};

export type MigratableInstructionData = {
  kind: Kind;
  role?: string;
  label?: string;
  packId?: string;
  packVersion?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  /** @deprecated Prefer dual instruction fields. */
  prompt?: string;
  tools?: string[];
  skills?: string[];
  description?: string;
};
