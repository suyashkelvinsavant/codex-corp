/**
 * Role-aware specialist defaults for graph library drops and Workflow Architect.
 * Pack catalog is SSOT; this module preserves the historical API surface.
 */

import type { Kind } from "./model";
import { instantiatePackForRole, type PackInstantiation } from "./node-packs";
import {
  effectiveDeveloperInstructions,
  migrateInstructionFields,
} from "./node-packs/migrate";

/** Below this, a specialist prompt is treated as incomplete for run readiness. */
export const MIN_SPECIALIST_PROMPT_CHARS = 120;

const PLACEHOLDER_PROMPTS = new Set(
  [
    "define this node contract.",
    "you are a specialist.",
    "todo",
    "tbd",
    "placeholder",
  ].map((s) => s.toLowerCase()),
);

export type SpecialistKind = "agent" | "creative";

export type SpecialistDefaults = {
  prompt: string;
  baseInstructions: string;
  developerInstructions: string;
  packId: string;
  packVersion: string;
  tools: string[];
  skills: string[];
  skillHints: string[];
  description: string;
};

function fromInstantiation(inst: PackInstantiation): SpecialistDefaults {
  return {
    prompt: inst.developerInstructions,
    baseInstructions: inst.baseInstructions,
    developerInstructions: inst.developerInstructions,
    packId: inst.packId,
    packVersion: inst.packVersion,
    tools: [...inst.tools],
    skills: [...inst.skills],
    skillHints: [...inst.skillHints],
    description: inst.description,
  };
}

function isSpecialistKindLocal(kind: Kind): kind is SpecialistKind {
  return kind === "agent" || kind === "creative";
}

export function defaultSpecialistForRole(
  role: string,
  kind: Kind = "agent",
): SpecialistDefaults {
  if (!isSpecialistKindLocal(kind)) {
    return {
      prompt: "",
      baseInstructions: "",
      developerInstructions: "",
      packId: "",
      packVersion: "",
      tools: [],
      skills: [],
      skillHints: [],
      description: "",
    };
  }
  return fromInstantiation(instantiatePackForRole(role, kind));
}

export function isWeakSpecialistPrompt(
  prompt: string | undefined | null,
): boolean {
  const text = (prompt ?? "").trim();
  if (text.length < MIN_SPECIALIST_PROMPT_CHARS) return true;
  if (PLACEHOLDER_PROMPTS.has(text.toLowerCase())) return true;
  if (
    text.length < 200 &&
    !text.includes("\n") &&
    text.split(/\s+/).length < 25
  ) {
    return true;
  }
  return false;
}

export type SpecialistNodeFields = {
  kind: Kind;
  role?: string;
  label?: string;
  packId?: string;
  packVersion?: string;
  prompt?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  tools?: string[];
  skills?: string[];
  description?: string;
};

/** Fields always populated by ensureSpecialistQuality for specialists. */
export type EnsuredSpecialistFields = {
  packId: string;
  packVersion: string;
  baseInstructions: string;
  developerInstructions: string;
  prompt: string;
  tools: string[];
  skills: string[];
  skillHints: string[];
  description: string;
};

/**
 * Fill missing/weak specialist fields with pack defaults.
 * Does not overwrite strong operator/Architect-authored developer contracts.
 */
export function ensureSpecialistQuality<T extends SpecialistNodeFields>(
  data: T,
): T & EnsuredSpecialistFields {
  if (!isSpecialistKindLocal(data.kind)) {
    return {
      ...data,
      packId: data.packId ?? "",
      packVersion: data.packVersion ?? "",
      baseInstructions: data.baseInstructions ?? "",
      developerInstructions: data.developerInstructions ?? data.prompt ?? "",
      prompt: data.prompt ?? "",
      tools: data.tools ? [...data.tools] : [],
      skills: data.skills ? [...data.skills] : [],
      skillHints: [],
      description: data.description ?? "",
    };
  }

  const migrated = migrateInstructionFields(data);
  const defaults = defaultSpecialistForRole(
    migrated.role || migrated.label || "",
    data.kind,
  );

  const developer = effectiveDeveloperInstructions(migrated);
  const strongDeveloper = !isWeakSpecialistPrompt(developer);
  const nextDeveloper = strongDeveloper
    ? developer
    : defaults.developerInstructions;
  const nextBase =
    (migrated.baseInstructions ?? "").trim().length > 0
      ? (migrated.baseInstructions as string)
      : defaults.baseInstructions;

  const tools =
    Array.isArray(migrated.tools) && migrated.tools.length > 0
      ? migrated.tools
      : defaults.tools;
  const configuredSkills =
    Array.isArray(migrated.skills) && migrated.skills.length > 0
      ? migrated.skills
      : defaults.skills;
  // Do not filter explicit operator selections here. Persisted snapshots are
  // migrated centrally, while an in-session connector choice is authoritative.
  const skills = configuredSkills;
  const description =
    (migrated.description ?? "").trim().length > 0
      ? migrated.description!
      : defaults.description;

  return {
    ...migrated,
    packId: migrated.packId || defaults.packId,
    packVersion: migrated.packVersion || defaults.packVersion,
    baseInstructions: nextBase,
    developerInstructions: nextDeveloper,
    prompt: nextDeveloper,
    tools: [...tools],
    skills: [...skills],
    skillHints: [...defaults.skillHints],
    description,
  };
}

/** Architect system-prompt obligations (asserted in tests). */
export const ARCHITECT_PROMPT_QUALITY_REQUIREMENTS = [
  "detailed system prompt",
  "tools",
  "skills",
  "least-privilege",
  "never leave specialist prompts empty",
] as const;
