import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Harness lessons — durable, versioned, reviewable supplemental guidance.
 *
 * TypeScript bridge for the Rust `harness_lessons` module. Mirrors the
 * `node-experience.ts` bridge pattern: returns empty arrays / no-ops outside
 * the Tauri desktop shell (e.g. unit tests) so callers do not need to guard.
 */

export type HarnessLesson = {
  id: number;
  role: string;
  model: string;
  effort: string;
  title: string;
  body: string;
  evidence: Record<string, unknown>;
  status: "active" | "superseded" | "rolled_back";
  source: "refine" | "manual";
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type LessonSnapshot = {
  id: number;
  lessonId: number;
  version: number;
  body: string;
  evidence: Record<string, unknown>;
  snapshotReason: "create" | "refine" | "edit" | "rollback";
  createdAt: string;
};

export type RefineAction = {
  role: string;
  model: string;
  effort: string;
  action: "created" | "updated" | "skipped";
  lessonId: number | null;
  reason: string;
};

export type RefineResult = {
  actions: RefineAction[];
  summary: { created: number; updated: number; skipped: number };
};

export type LessonQuery = {
  role?: string;
  model?: string;
  effort?: string;
  includeInactive?: boolean;
};

function coerceLesson(row: unknown): HarnessLesson {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id ?? 0),
    role: String(r.role ?? ""),
    model: String(r.model ?? ""),
    effort: String(r.effort ?? ""),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    evidence:
      r.evidence && typeof r.evidence === "object"
        ? (r.evidence as Record<string, unknown>)
        : {},
    status: (String(r.status ?? "active") as HarnessLesson["status"]),
    source: (String(r.source ?? "manual") as HarnessLesson["source"]),
    currentVersion: Number(r.currentVersion ?? 1),
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  };
}

function coerceSnapshot(row: unknown): LessonSnapshot {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id ?? 0),
    lessonId: Number(r.lessonId ?? 0),
    version: Number(r.version ?? 1),
    body: String(r.body ?? ""),
    evidence:
      r.evidence && typeof r.evidence === "object"
        ? (r.evidence as Record<string, unknown>)
        : {},
    snapshotReason: (String(
      r.snapshotReason ?? "create",
    ) as LessonSnapshot["snapshotReason"]),
    createdAt: String(r.createdAt ?? ""),
  };
}

/** List harness lessons, optionally filtered by specialist pattern. */
export async function listHarnessLessons(
  query: LessonQuery = {},
): Promise<HarnessLesson[]> {
  if (!isTauri()) return [];
  const rows =
    (await invoke<unknown[]>("list_harness_lessons", {
      role: query.role ?? null,
      model: query.model ?? null,
      effort: query.effort ?? null,
      includeInactive: query.includeInactive ?? false,
    })) ?? [];
  return rows.map(coerceLesson);
}

/** Active lessons for a specialist pattern (role/model/effort). */
export async function activeLessonsForPattern(
  role: string,
  model: string,
  effort: string,
): Promise<HarnessLesson[]> {
  return listHarnessLessons({ role, model, effort, includeInactive: false });
}

/** Create a new lesson manually. Returns the new lesson id. */
export async function createHarnessLesson(input: {
  role: string;
  model: string;
  effort: string;
  title: string;
  body: string;
  evidence?: Record<string, unknown>;
  source?: "refine" | "manual";
}): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("create_harness_lesson", {
    role: input.role,
    model: input.model,
    effort: input.effort,
    title: input.title,
    body: input.body,
    evidence: input.evidence ?? {},
    source: input.source ?? "manual",
  });
}

/** Update a lesson body/evidence. Returns the new version. */
export async function updateHarnessLesson(
  id: number,
  body: string,
  evidence: Record<string, unknown>,
): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("update_harness_lesson", { id, body, evidence });
}

/** Roll back a lesson to a prior snapshot version. Returns the restored version. */
export async function rollbackHarnessLesson(
  id: number,
  toVersion: number,
): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("rollback_harness_lesson", { id, toVersion });
}

/** Delete a lesson and its snapshots. */
export async function deleteHarnessLesson(id: number): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("delete_harness_lesson", { id });
}

/** List snapshot history for a lesson, newest-first. */
export async function listHarnessLessonSnapshots(
  lessonId: number,
): Promise<LessonSnapshot[]> {
  if (!isTauri()) return [];
  const rows =
    (await invoke<unknown[]>("list_harness_lesson_snapshots", {
      lessonId,
    })) ?? [];
  return rows.map(coerceSnapshot);
}

/**
 * Run a deliberate refinement pass over node experience. Reviews recurring
 * failures and produces/updates durable lessons with evidence. Optionally
 * scoped to one workflow.
 */
export async function refineHarnessLessons(
  workflowId?: string,
): Promise<RefineResult> {
  if (!isTauri())
    return { actions: [], summary: { created: 0, updated: 0, skipped: 0 } };
  const result = await invoke<unknown>("refine_harness_lessons_cmd", {
    workflowId: workflowId ?? null,
  });
  const r = result as Record<string, unknown>;
  const actions = Array.isArray(r.actions) ? (r.actions as RefineAction[]) : [];
  const summary =
    r.summary && typeof r.summary === "object"
      ? (r.summary as RefineResult["summary"])
      : { created: 0, updated: 0, skipped: 0 };
  return { actions, summary };
}

/**
 * Human-readable digest of active lessons for a specialist pattern, suitable
 * for packing into Byte/mediator context or the inspector UI.
 */
export function formatLessonDigest(lessons: HarnessLesson[]): string {
  if (!lessons.length) return "No active harness lessons for this pattern.";
  const lines = lessons.map((lesson) => {
    const failureClass =
      (lesson.evidence.failureClass as string | undefined) ?? "general";
    return `- #${lesson.id} "${lesson.title}" [${lesson.source}, v${lesson.currentVersion}, ${failureClass}]: ${lesson.body}`;
  });
  return [
    `Active harness lessons: ${lessons.length}.`,
    ...lines,
    "These lessons are prepended to the specialist's developer instructions at run time.",
  ].join("\n");
}
