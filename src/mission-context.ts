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

const NON_MISSION_VALUES = new Set([
  "describe the product request for the company.",
  "no workflow mission was provided.",
  "hi",
  "hello",
  "hey",
]);

const GREETING_ONLY_RE =
  /^(?:hi|hello|hey)(?:\s+(?:there|codex|team|everyone))?[!,.?]*$/i;
const WORKFLOW_INFORMATION_RE =
  /^(?:(?:what|how)\b|can\s+you\s+(?:explain|describe|show|tell)\b).*(?:workflow|company|template|node|capabilit)/i;

/**
 * Return whether an input-node value is an operator-authored product request.
 * Template instructions and the empty-mission fallback are deliberately not
 * treated as work so they cannot launch a specialist run by accident.
 */
export function isConcreteMission(value: string | null | undefined): boolean {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return (
    Boolean(normalized) &&
    !NON_MISSION_VALUES.has(normalized) &&
    !GREETING_ONLY_RE.test(normalized) &&
    !WORKFLOW_INFORMATION_RE.test(normalized)
  );
}

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
