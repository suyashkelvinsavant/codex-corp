import { isSpecialistKind } from "../model";
import { NEUTRAL_HARNESS_CORE } from "./harness-core";
import { getPack } from "./packs";
import type { MigratableInstructionData } from "./types";

function hasSplitFields(data: MigratableInstructionData): boolean {
  return (
    Boolean((data.baseInstructions ?? "").trim()) ||
    Boolean((data.developerInstructions ?? "").trim())
  );
}

/** Instruction fields always written by migrateInstructionFields for specialists. */
export type MigratedInstructionFields = {
  baseInstructions: string;
  developerInstructions: string;
  prompt: string;
  packId?: string;
  packVersion?: string;
};

/**
 * Legacy instruction migration (plan I.1.1).
 * - Pack-matched + legacy single prompt → rehydrate from pack (no double harness).
 * - No pack + only prompt → developer=prompt, base=harness-core.
 * - Both split fields set → keep.
 */
export function migrateInstructionFields<T extends MigratableInstructionData>(
  data: T,
): T & MigratedInstructionFields {
  if (!isSpecialistKind(data.kind)) {
    return {
      ...data,
      baseInstructions: data.baseInstructions ?? "",
      developerInstructions: data.developerInstructions ?? data.prompt ?? "",
      prompt: data.prompt ?? "",
    };
  }

  if (hasSplitFields(data)) {
    // Keep dual fields; mirror developer into deprecated prompt when prompt empty.
    const developer =
      (data.developerInstructions ?? "").trim() ||
      (data.prompt ?? "").trim() ||
      "";
    const base = (data.baseInstructions ?? "").trim() || NEUTRAL_HARNESS_CORE;
    return {
      ...data,
      baseInstructions: base,
      developerInstructions: developer,
      prompt: developer || data.prompt || "",
    };
  }

  const pack = data.packId ? getPack(data.packId) : undefined;
  const legacyPrompt = (data.prompt ?? "").trim();

  if (pack) {
    // Pack-matched: rehydrate dual fields from pack (never double-layer old prompt + base).
    return {
      ...data,
      packId: pack.id,
      packVersion: pack.version,
      baseInstructions: pack.baseInstructions,
      developerInstructions: pack.developerInstructions,
      prompt: pack.developerInstructions,
    };
  }

  if (legacyPrompt) {
    return {
      ...data,
      baseInstructions: NEUTRAL_HARNESS_CORE,
      developerInstructions: legacyPrompt,
      prompt: legacyPrompt,
    };
  }

  // Empty specialist: neutral empty-agent defaults applied by callers when placing.
  return {
    ...data,
    baseInstructions: NEUTRAL_HARNESS_CORE,
    developerInstructions: "",
    prompt: "",
  };
}

/** Effective developer contract for UI weakness checks and runtime fallbacks. */
export function effectiveDeveloperInstructions(
  data: MigratableInstructionData,
): string {
  const migrated = migrateInstructionFields(data);
  return (
    (migrated.developerInstructions ?? "").trim() ||
    (migrated.prompt ?? "").trim()
  );
}

/** Effective base for connector send (empty = opt-in native Codex base). */
export function effectiveBaseInstructions(
  data: MigratableInstructionData,
): string {
  const migrated = migrateInstructionFields(data);
  return (migrated.baseInstructions ?? "").trim();
}
