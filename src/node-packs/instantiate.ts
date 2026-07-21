import { defaultPlatformCriteria } from "../completion-criteria";
import { findPackForRole, getPack } from "./packs";
import type { NodePack, PackInstantiation } from "./types";

/** Build node data fields from a pack (deep-copied arrays). */
export function instantiatePack(pack: NodePack): PackInstantiation {
  return {
    packId: pack.id,
    packVersion: pack.version,
    label: pack.label,
    role: pack.role,
    kind: pack.kind,
    description: pack.description,
    baseInstructions: pack.baseInstructions,
    developerInstructions: pack.developerInstructions,
    prompt: pack.developerInstructions,
    tools: [...pack.tools],
    // Packs describe role guidance, but connector skills are workspace-scoped
    // capabilities and must only be populated from live operator selections.
    skills: [],
    skillHints: [...pack.skillHints],
    completionCriteria: pack.completionCriteria
      ? pack.completionCriteria.map((c) => ({ ...c }))
      : defaultPlatformCriteria(),
    sandboxProfile: pack.sandboxProfile,
    approvalPolicy: pack.approvalPolicy,
  };
}

export function instantiatePackById(packId: string): PackInstantiation | null {
  const pack = getPack(packId);
  return pack ? instantiatePack(pack) : null;
}

export function instantiatePackForRole(
  role: string,
  kind: "agent" | "creative" = "agent",
): PackInstantiation {
  const pack =
    findPackForRole(role, kind) ??
    (kind === "creative" ? getPack("creative") : getPack("empty-agent"));
  if (!pack) {
    throw new Error(`No pack available for role=${role} kind=${kind}`);
  }
  const inst = instantiatePack(pack);
  if (role.trim() && pack.id === "empty-agent") {
    inst.role = role.trim();
    inst.label = role.trim();
    inst.description = `${role.trim()} specialist — configure the developer contract.`;
  }
  return inst;
}
