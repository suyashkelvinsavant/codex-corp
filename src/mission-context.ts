/**
 * Authorized mission composition for specialist threads.
 * Mission brief text + constraints + acceptance notes → single userInput string.
 */

export type MissionBriefFields = {
  /** Primary mission text (input node `output`). */
  output?: string;
  missionConstraints?: string[];
  acceptanceNotes?: string;
};

/** Normalize constraint lines (trim, drop empties, de-dupe preserving order). */
export function normalizeMissionConstraints(
  lines: string[] | undefined | null,
): string[] {
  if (!lines?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Build the authorized mission string specialists receive as userInput.
 * Empty mission falls back to a clear placeholder (never silent empty).
 */
export function composeAuthorizedMission(brief: MissionBriefFields): string {
  const mission =
    (brief.output ?? "").trim() || "No workflow mission was provided.";
  const constraints = normalizeMissionConstraints(brief.missionConstraints);
  const acceptance = (brief.acceptanceNotes ?? "").trim();

  const parts: string[] = [mission];

  if (constraints.length) {
    parts.push(
      ["## Constraints", ...constraints.map((c) => `- ${c}`)].join("\n"),
    );
  }
  if (acceptance) {
    parts.push(`## Acceptance notes\n${acceptance}`);
  }

  return parts.join("\n\n");
}

/** Parse a multiline textarea into constraint lines. */
export function constraintsFromTextarea(text: string): string[] {
  return normalizeMissionConstraints(text.split(/\r?\n/));
}

export function constraintsToTextarea(lines: string[] | undefined): string {
  return (lines ?? []).join("\n");
}
