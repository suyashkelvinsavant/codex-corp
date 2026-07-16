/** Prompt helpers for skills discovered from the connected Codex app-server. */

export type SelectedCodexSkill = {
  id: string;
  label: string;
  directionHint: string;
};

export function resolveActiveSkill(
  skills: string[] | undefined,
  activeSkill: string | undefined,
): SelectedCodexSkill {
  const selected = (skills ?? []).filter(Boolean);
  const id =
    activeSkill && selected.includes(activeSkill)
      ? activeSkill
      : (selected[0] ?? "");
  return {
    id,
    label: id || "None selected",
    directionHint: id
      ? `Use the connector-provided ${id} skill when it is applicable.`
      : "No connector skill is selected; follow the node instructions only.",
  };
}

/** Preview of the runtime prompt addition; the inventory itself stays native-owned. */
export function composeCreativeSystemPrompt(
  basePrompt: string,
  skills: string[] | undefined,
  activeSkill: string | undefined,
): string {
  const selected = (skills ?? []).filter(Boolean);
  const primary = resolveActiveSkill(selected, activeSkill);
  return [
    basePrompt.trim(),
    selected.length
      ? `Selected Codex skills: ${selected.join(", ")}. Primary: ${primary.id}.`
      : "No Codex connector skills selected.",
    "Use selected skills only when applicable and follow their connector-provided instructions.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
