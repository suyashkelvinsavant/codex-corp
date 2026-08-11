//! Harness lessons — durable, versioned, reviewable supplemental guidance.
//!
//! Adaptation of prime-agent's Continual Harness to Codex Corp's Rust-owned
//! state architecture. Where prime-agent stores refinements as supplemental
//! prompts/memories with snapshot rollback and a `/refine` review pass, this
//! module owns the same invariants in SQLite:
//!
//! - **Lesson**: a named, versioned piece of supplemental harness guidance
//!   keyed by `(role, model, effort)` so a lesson learned in one workflow
//!   transfers to the same specialist pattern in another.
//! - **Refine**: a deliberate, deterministic, evidence-backed refinement pass
//!   that reviews `node_experience` trajectories and produces or updates
//!   lessons. Rust owns this logic (not an LLM) so refinement is reproducible
//!   and auditable; the operator remains the human review path via edit/rollback.
//! - **Snapshot**: every body change is recorded as an immutable snapshot so a
//!   bad refinement can be rolled back to any prior version.
//! - **Application**: at run time, active lessons matching a node's pattern are
//!   prepended to the specialist's developer instructions by `workflow_runtime`.
//!
//! The immutable base system prompt (`baseInstructions`) is never touched by
//! lessons — they are supplemental to developer instructions only, matching
//! prime-agent's "never rewrites the immutable base system prompt" invariant.

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

use crate::db_guard_for;
use crate::Database;

/// Lesson status. Only `active` lessons are applied at run time.
const STATUS_ACTIVE: &str = "active";
/// Soft-deleted by the operator; retained for audit and later pruning.
const STATUS_SUPERSEDED: &str = "superseded";
/// Reserved for future explicit rollback-as-inactive transitions. Currently
/// `rollback_lesson` re-activates the lesson, so this is unused in production.
#[allow(dead_code)]
const STATUS_ROLLED_BACK: &str = "rolled_back";

/// Why a snapshot was recorded.
const REASON_CREATE: &str = "create";
const REASON_REFINE: &str = "refine";
const REASON_EDIT: &str = "edit";
const REASON_ROLLBACK: &str = "rollback";

/// Minimum recent failures for a pattern before refine produces a lesson.
const REFINE_MIN_FAILURES: usize = 2;

/// Create the harness-lessons schema. Idempotent.
///
/// The partial unique index on `(role, model, effort) WHERE status='active'`
/// enforces at most one active lesson per pattern. On databases that predate
/// this invariant, duplicate active lessons may already exist; the index
/// creation is attempted separately and a failure is tolerated (the
/// application-layer check in `create_lesson` still prevents new duplicates)
/// rather than blocking startup.
pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS harness_lessons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,
                model TEXT NOT NULL,
                effort TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                source TEXT NOT NULL DEFAULT 'refine',
                current_version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_harness_lessons_pattern
                ON harness_lessons(role, model, effort, status);
            CREATE TABLE IF NOT EXISTS harness_lesson_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lesson_id INTEGER NOT NULL,
                version INTEGER NOT NULL,
                body TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                snapshot_reason TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (lesson_id) REFERENCES harness_lessons(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_harness_lesson_snapshots_lesson
                ON harness_lesson_snapshots(lesson_id, version);",
        )
        .map_err(|error| error.to_string())?;
    // At most one active lesson per specialist pattern. A partial unique index
    // is the hard storage-level guard. Created separately so a pre-existing
    // duplicate-active-lesson legacy database does not block startup: the
    // application-layer check in `create_lesson` still prevents new duplicates.
    let _ = connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS udx_harness_lessons_active_pattern
         ON harness_lessons(role, model, effort) WHERE status='active'",
        [],
    );
    Ok(())
}

/// Durable lesson row.
#[derive(Debug, Clone)]
pub(crate) struct HarnessLesson {
    pub id: i64,
    pub role: String,
    pub model: String,
    pub effort: String,
    pub title: String,
    pub body: String,
    pub evidence: Value,
    pub status: String,
    pub source: String,
    pub current_version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Snapshot row — immutable history of one lesson body version.
#[derive(Debug, Clone)]
pub(crate) struct LessonSnapshot {
    pub id: i64,
    pub lesson_id: i64,
    pub version: i64,
    pub body: String,
    pub evidence: Value,
    pub snapshot_reason: String,
    pub created_at: String,
}

fn row_to_lesson(row: &rusqlite::Row) -> rusqlite::Result<HarnessLesson> {
    let evidence_json: String = row.get(6)?;
    let evidence = serde_json::from_str(&evidence_json).unwrap_or(Value::Null);
    Ok(HarnessLesson {
        id: row.get(0)?,
        role: row.get(1)?,
        model: row.get(2)?,
        effort: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        evidence,
        status: row.get(7)?,
        source: row.get(8)?,
        current_version: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn row_to_snapshot(row: &rusqlite::Row) -> rusqlite::Result<LessonSnapshot> {
    // SELECT order: id, lesson_id, version, body, evidence_json, snapshot_reason, created_at
    let body: String = row.get(3)?;
    let evidence_json: String = row.get(4)?;
    let evidence = serde_json::from_str(&evidence_json).unwrap_or(Value::Null);
    Ok(LessonSnapshot {
        id: row.get(0)?,
        lesson_id: row.get(1)?,
        version: row.get(2)?,
        body,
        evidence,
        snapshot_reason: row.get(5)?,
        created_at: row.get(6)?,
    })
}

/// Serialize evidence JSON compactly for storage.
fn pack_evidence(evidence: &Value) -> String {
    serde_json::to_string(evidence).unwrap_or_else(|_| "{}".into())
}

/// List lessons, optionally filtered by pattern and status.
/// When `include_inactive` is false, only `active` lessons are returned.
pub(crate) fn list_lessons(
    connection: &Connection,
    role: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    include_inactive: bool,
) -> Result<Vec<HarnessLesson>, String> {
    let mut sql = String::from(
        "SELECT id,role,model,effort,title,body,evidence_json,status,source,current_version,created_at,updated_at FROM harness_lessons WHERE 1=1",
    );
    // Bind optional filters to owned locals so the trait-object borrows live
    // long enough. `String` is sized and coerces cleanly to `&dyn ToSql`.
    let role_owned = role.map(String::from);
    let model_owned = model.map(String::from);
    let effort_owned = effort.map(String::from);
    let mut args: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if let Some(r) = &role_owned {
        sql.push_str(" AND role=?");
        args.push(r);
    }
    if let Some(m) = &model_owned {
        sql.push_str(" AND model=?");
        args.push(m);
    }
    if let Some(e) = &effort_owned {
        sql.push_str(" AND effort=?");
        args.push(e);
    }
    if !include_inactive {
        sql.push_str(" AND status='active'");
    }
    sql.push_str(" ORDER BY updated_at DESC, id DESC");
    let mut statement = connection.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(args.as_slice(), row_to_lesson)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Active lessons for a specialist pattern, ordered oldest-first so the
/// run-time guidance concatenation is stable and deterministic.
pub(crate) fn active_lessons_for_pattern(
    connection: &Connection,
    role: &str,
    model: &str,
    effort: &str,
) -> Result<Vec<HarnessLesson>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,role,model,effort,title,body,evidence_json,status,source,current_version,created_at,updated_at
             FROM harness_lessons
             WHERE role=?1 AND model=?2 AND effort=?3 AND status='active'
             ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![role, model, effort], row_to_lesson)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Concatenated guidance text from all active lessons for a pattern.
/// Returns `None` when no active lessons exist so the caller can skip prepending.
pub(crate) fn lesson_guidance(
    connection: &Connection,
    role: &str,
    model: &str,
    effort: &str,
) -> Result<Option<String>, String> {
    let lessons = active_lessons_for_pattern(connection, role, model, effort)?;
    if lessons.is_empty() {
        return Ok(None);
    }
    let mut blocks = Vec::with_capacity(lessons.len());
    for lesson in &lessons {
        blocks.push(format!(
            "[Harness lesson #{} '{}': {}]\n{}",
            lesson.id, lesson.title, lesson.source, lesson.body
        ));
    }
    Ok(Some(format!(
        "Supplemental harness lessons for this specialist pattern:\n{}\n--- end harness lessons ---",
        blocks.join("\n\n")
    )))
}

/// Record a snapshot for a lesson at its current version.
fn record_snapshot(
    connection: &Connection,
    lesson_id: i64,
    version: i64,
    body: &str,
    evidence: &Value,
    reason: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO harness_lesson_snapshots(lesson_id,version,body,evidence_json,snapshot_reason)
             VALUES(?1,?2,?3,?4,?5)",
            params![lesson_id, version, body, pack_evidence(evidence), reason],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a new lesson. Records the initial snapshot at version 1.
/// Returns an error if an active lesson already exists for the pattern — at
/// most one active lesson per `(role, model, effort)` is allowed so run-time
/// guidance is not duplicated. Update the existing lesson instead, or
/// soft-delete it first.
#[allow(clippy::too_many_arguments)] // parameter set is the lesson's natural shape
pub(crate) fn create_lesson(
    connection: &Connection,
    role: &str,
    model: &str,
    effort: &str,
    title: &str,
    body: &str,
    evidence: &Value,
    source: &str,
) -> Result<i64, String> {
    if active_lessons_for_pattern(connection, role, model, effort)?
        .into_iter()
        .next()
        .is_some()
    {
        return Err(format!(
            "an active lesson already exists for pattern {role}/{model}/{effort}; \
             update it or deactivate it before creating a new one"
        ));
    }
    let evidence_json = pack_evidence(evidence);
    connection
        .execute(
            "INSERT INTO harness_lessons(role,model,effort,title,body,evidence_json,status,source,current_version)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1)",
            params![role, model, effort, title, body, evidence_json, STATUS_ACTIVE, source],
        )
        .map_err(|e| e.to_string())?;
    let id = connection.last_insert_rowid();
    record_snapshot(connection, id, 1, body, evidence, REASON_CREATE)?;
    Ok(id)
}

/// Update a lesson's body and evidence. Snapshots the prior version and bumps
/// `current_version`. Returns the new version. The title is left unchanged —
/// this is the operator-facing edit path (Tauri `update_harness_lesson`), and
/// operators edit body/evidence only. Use `update_lesson_with_title` when a
/// refinement shifts the failure signature and the title must follow.
pub(crate) fn update_lesson(
    connection: &Connection,
    id: i64,
    body: &str,
    evidence: &Value,
    reason: &str,
) -> Result<i64, String> {
    update_lesson_inner(connection, id, None, body, evidence, reason)
}

/// Update a lesson's title, body, and evidence. Snapshots the prior version
/// and bumps `current_version`. Returns the new version. Used by refine when
/// the dominant failure class or stop reason shifts — the title is derived
/// from the new signature and must stay consistent with the body so the
/// inspector UI and Byte/mediator digests do not show a stale label.
pub(crate) fn update_lesson_with_title(
    connection: &Connection,
    id: i64,
    title: &str,
    body: &str,
    evidence: &Value,
    reason: &str,
) -> Result<i64, String> {
    update_lesson_inner(connection, id, Some(title), body, evidence, reason)
}

fn update_lesson_inner(
    connection: &Connection,
    id: i64,
    title: Option<&str>,
    body: &str,
    evidence: &Value,
    reason: &str,
) -> Result<i64, String> {
    let prior: (String, String, i64) = connection
        .query_row(
            "SELECT body,evidence_json,current_version FROM harness_lessons WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("lesson {id} not found: {e}"))?;
    let prior_evidence: Value =
        serde_json::from_str(&prior.1).unwrap_or(Value::Null);
    record_snapshot(connection, id, prior.2, &prior.0, &prior_evidence, reason)?;
    let next_version = prior.2 + 1;
    match title {
        Some(title) => {
            connection
                .execute(
                    "UPDATE harness_lessons SET title=?2,body=?3,evidence_json=?4,current_version=?5,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id, title, body, pack_evidence(evidence), next_version],
                )
                .map_err(|e| e.to_string())?;
        }
        None => {
            connection
                .execute(
                    "UPDATE harness_lessons SET body=?2,evidence_json=?3,current_version=?4,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id, body, pack_evidence(evidence), next_version],
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(next_version)
}

/// Roll back a lesson to a prior snapshot version. The current body is
/// snapshotted first (so the rollback itself is auditable), then the target
/// version's body is restored and a new snapshot records the rollback.
/// Returns the restored version.
pub(crate) fn rollback_lesson(
    connection: &Connection,
    id: i64,
    to_version: i64,
) -> Result<i64, String> {
    let current: (String, String, i64, String) = connection
        .query_row(
            "SELECT body,evidence_json,current_version,status FROM harness_lessons WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("lesson {id} not found: {e}"))?;
    if to_version == current.2 {
        return Err(format!(
            "lesson {id} is already at version {to_version}"
        ));
    }
    if to_version < 1 || to_version > current.2 {
        return Err(format!(
            "version {to_version} is out of range for lesson {id} (1..={})",
            current.2
        ));
    }
    // Snapshot the current state so the rollback is reversible.
    let current_evidence: Value =
        serde_json::from_str(&current.1).unwrap_or(Value::Null);
    record_snapshot(connection, id, current.2, &current.0, &current_evidence, REASON_ROLLBACK)?;
    // Load the target snapshot.
    let target: (String, String) = connection
        .query_row(
            "SELECT body,evidence_json FROM harness_lesson_snapshots
             WHERE lesson_id=?1 AND version=?2
             ORDER BY id DESC LIMIT 1",
            params![id, to_version],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("snapshot version {to_version} not found: {e}"))?;
    let target_evidence: Value =
        serde_json::from_str(&target.1).unwrap_or(Value::Null);
    let next_version = current.2 + 1;
    connection
        .execute(
            "UPDATE harness_lessons SET body=?2,evidence_json=?3,current_version=?4,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id, target.0, pack_evidence(&target_evidence), next_version],
        )
        .map_err(|e| e.to_string())?;
    // Record the restored state as a new snapshot so the version history is linear.
    record_snapshot(connection, id, next_version, &target.0, &target_evidence, REASON_ROLLBACK)?;
    Ok(next_version)
}

/// Soft-delete a lesson: mark it `superseded` so it stops applying at run
/// time but the row and its snapshot history are retained for audit and later
/// reaping by `prune_lessons`. This is the operator-facing delete path (Tauri
/// `delete_harness_lesson`) — the row is intentionally not removed so a
/// mistaken delete can be reviewed and so retention can age it out.
pub(crate) fn delete_lesson(connection: &Connection, id: i64) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE harness_lessons SET status=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id, STATUS_SUPERSEDED],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("lesson {id} not found"));
    }
    Ok(())
}

/// Hard-delete a lesson row and its snapshots. Used by
/// `delete_lessons_for_workflow` when a workflow is itself deleted — the
/// lesson's evidence only referenced that workflow, so there is nothing left
/// to audit. Not exposed as a Tauri command.
///
/// Snapshots are deleted explicitly before the parent lesson because SQLite
/// has foreign keys disabled by default and this codebase does not enable
/// `PRAGMA foreign_keys = ON`. Relying on the declared `ON DELETE CASCADE`
/// would silently leave orphaned snapshot rows that accumulate forever with
/// no cleanup path. Deleting the child rows explicitly is correct regardless
/// of the foreign-key pragma state.
fn hard_delete_lesson(connection: &Connection, id: i64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM harness_lesson_snapshots WHERE lesson_id=?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute("DELETE FROM harness_lessons WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// List snapshot history for a lesson, newest-first.
pub(crate) fn list_snapshots(
    connection: &Connection,
    lesson_id: i64,
) -> Result<Vec<LessonSnapshot>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,lesson_id,version,body,evidence_json,snapshot_reason,created_at
             FROM harness_lesson_snapshots
             WHERE lesson_id=?1
             ORDER BY version DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![lesson_id], row_to_snapshot)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Get a single lesson by id.
#[allow(dead_code)] // used in tests; kept as a stable read API
pub(crate) fn get_lesson(connection: &Connection, id: i64) -> Result<HarnessLesson, String> {
    connection
        .query_row(
            "SELECT id,role,model,effort,title,body,evidence_json,status,source,current_version,created_at,updated_at
             FROM harness_lessons WHERE id=?1",
            params![id],
            row_to_lesson,
        )
        .map_err(|e| format!("lesson {id} not found: {e}"))
}

// ---------------------------------------------------------------------------
// Refine — deliberate, deterministic, evidence-backed lesson production
// ---------------------------------------------------------------------------

/// Summary of one refine action on one pattern.
#[derive(Debug, Clone)]
pub(crate) struct RefineAction {
    pub role: String,
    pub model: String,
    pub effort: String,
    pub action: String, // "created" | "updated" | "skipped"
    pub lesson_id: Option<i64>,
    pub reason: String,
}

/// Result of a refine pass.
#[derive(Debug, Clone)]
pub(crate) struct RefineResult {
    pub actions: Vec<RefineAction>,
}

/// Pattern key for grouping experience rows.
/// `Ord` is derived so a `BTreeMap` can group rows deterministically across
/// runs (the iteration order is the sorted key order, not a random one).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct PatternKey {
    role: String,
    model: String,
    effort: String,
}

/// One experience row reduced for refinement.
#[derive(Debug, Clone)]
struct ExperienceRow {
    failure_class: Option<String>,
    stop_reason: Option<String>,
    outcome: String,
    workflow_id: String,
}

/// Load experience rows grouped by pattern, optionally scoped to one workflow.
/// Grouping uses a `BTreeMap` so the iteration order (and therefore the order
/// of refine actions) is deterministic across runs — a `HashMap` would use a
/// random `RandomState` seed and produce non-reproducible output.
fn load_experience_for_refine(
    connection: &Connection,
    workflow_id: Option<&str>,
) -> Result<BTreeMap<PatternKey, Vec<ExperienceRow>>, String> {
    let sql = if workflow_id.is_some() {
        "SELECT role,model,effort,failure_class,stop_reason,outcome,workflow_id
         FROM node_experience
         WHERE workflow_id=?1
         ORDER BY observed_at DESC, id DESC LIMIT 500"
    } else {
        "SELECT role,model,effort,failure_class,stop_reason,outcome,workflow_id
         FROM node_experience
         ORDER BY observed_at DESC, id DESC LIMIT 500"
    };
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    // Collect raw tuples first, then group, so the two query_map branches
    // don't produce incompatible closure types.
    type RawExpRow = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let raw_rows: Vec<RawExpRow> = if let Some(wf) = workflow_id {
        let rows = statement
            .query_map(params![wf], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    } else {
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut grouped: BTreeMap<PatternKey, Vec<ExperienceRow>> = BTreeMap::new();
    for (role, model, effort, failure_class, stop_reason, outcome, wf) in raw_rows {
        let key = PatternKey {
            role: role.unwrap_or_default(),
            model: model.unwrap_or_default(),
            effort: effort.unwrap_or_default(),
        };
        grouped.entry(key).or_default().push(ExperienceRow {
            failure_class,
            stop_reason,
            outcome,
            workflow_id: wf,
        });
    }
    Ok(grouped)
}

/// Build a deterministic lesson body and evidence from a pattern's recent
/// experience. Returns `None` when there is no recurring failure to learn from.
///
/// Counts are kept in `BTreeMap`s so that, when two failure classes (or stop
/// reasons) tie on count, the tie-break is the lexicographically smaller key —
/// stable across runs. A `HashMap` would use a random `RandomState` seed and
/// pick an arbitrary winner, which would break the "reproducible and auditable"
/// invariant documented at the top of this module.
fn build_lesson_from_experience(
    pattern: &PatternKey,
    rows: &[ExperienceRow],
) -> Option<(String, Value)> {
    let recent: Vec<&ExperienceRow> = rows.iter().take(20).collect();
    // A recent success suppresses lesson creation — the pattern is working.
    if recent
        .first()
        .map(|r| r.outcome.as_str())
        == Some("success")
    {
        return None;
    }
    let mut class_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut stop_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut workflow_ids: BTreeSet<String> = BTreeSet::new();
    let mut failures = 0usize;
    let mut successes = 0usize;
    for row in &recent {
        if let Some(class) = row.failure_class.as_deref().filter(|s| !s.is_empty()) {
            *class_counts.entry(class.to_string()).or_default() += 1;
        }
        if let Some(reason) = row.stop_reason.as_deref().filter(|s| !s.is_empty()) {
            *stop_counts.entry(reason.to_string()).or_default() += 1;
        }
        workflow_ids.insert(row.workflow_id.clone());
        if row.outcome == "success" {
            successes += 1;
        } else {
            failures += 1;
        }
    }
    // Pick the dominant failure class deterministically: highest count wins,
    // and ties are broken by the lexicographically smallest key. BTreeMap
    // iterates in sorted key order, so we scan for the max count and keep the
    // first (smallest-key) entry that reaches it — `max_by` would instead
    // return the last tied entry, which is non-deterministic in intent.
    let max_class_count = class_counts.values().copied().max().unwrap_or(0);
    let (dominant_class, class_count) = class_counts
        .iter()
        .find(|(_, c)| **c == max_class_count)
        .filter(|(_, c)| **c >= REFINE_MIN_FAILURES)?;
    // Same deterministic tie-break for the dominant stop reason.
    let max_stop_count = stop_counts.values().copied().max().unwrap_or(0);
    let dominant_stop = stop_counts
        .iter()
        .find(|(_, c)| **c == max_stop_count)
        .map(|(r, _)| r.as_str())
        .unwrap_or("recurring failure");
    let body = lesson_body_for_class(dominant_class, dominant_stop);
    let evidence = json!({
        "failureClass": dominant_class,
        "failureClassCount": class_count,
        "dominantStopReason": dominant_stop,
        "recentFailures": failures,
        "recentSuccesses": successes,
        "sampledWorkflows": workflow_ids.iter().cloned().collect::<Vec<_>>(),
        "sourceRows": recent.len(),
    });
    let _ = &pattern.role; // pattern used by caller for title
    Some((body, evidence))
}

/// Deterministic lesson body for a failure class. Mirrors the runtime
/// `experience_guidance` taxonomy so refine-produced lessons are consistent
/// with the inline guidance the runtime already emits.
fn lesson_body_for_class(class: &str, stop_reason: &str) -> String {
    match class {
        "contract" => format!(
            "Return strictly valid structured JSON matching the required output schema. \
             Do not wrap output in markdown fences, omit required fields, or free-text the answer. \
             Recurring failure: contract/output mismatch ({}).",
            stop_reason
        ),
        "transient" => format!(
            "Transient provider/tool errors ({}) are not output failures. \
             Wait briefly and retry the same request; do not change the requested output over a temporary failure.",
            stop_reason
        ),
        "capability" => format!(
            "Use only the tools and skills granted on this node. \
             If the task truly requires an unavailable capability, report the gap clearly via needs_revision \
             instead of attempting it. Recurring failure: missing capability ({}).",
            stop_reason
        ),
        "specification" => format!(
            "Re-read the mission, output contract, and constraints before producing output. \
             If acceptance criteria are ambiguous, ask for clarification via needs_revision rather than guessing. \
             Recurring failure: specification drift ({}).",
            stop_reason
        ),
        "verification" => format!(
            "Provide explicit, checkable evidence for every claim. Do not self-attest completion \
             that runtime verifiers own. Recurring failure: host verification ({}).",
            stop_reason
        ),
        "plateau" => format!(
            "If the first approach does not succeed, deliberately vary the strategy rather than \
             repeating the same steps. Recurring failure: plateau on the same error ({}).",
            stop_reason
        ),
        other => format!(
            "Review the prompt, output contract, and constraints before producing output, then adjust the approach. \
             Recurring failure class '{}' ({}).",
            other, stop_reason
        ),
    }
}

/// Find the active lesson for a pattern, if any.
fn active_lesson_for_pattern(
    connection: &Connection,
    pattern: &PatternKey,
) -> Result<Option<HarnessLesson>, String> {
    let lessons = active_lessons_for_pattern(connection, &pattern.role, &pattern.model, &pattern.effort)?;
    Ok(lessons.into_iter().next())
}

/// Run a deliberate refinement pass over node experience. For each specialist
/// pattern with a recurring failure class, create or update a durable lesson
/// with evidence. Existing lessons are updated only when the dominant failure
/// class or stop reason changed, so stable lessons are not churned.
pub(crate) fn refine_harness_lessons(
    connection: &Connection,
    workflow_id: Option<&str>,
) -> Result<RefineResult, String> {
    let grouped = load_experience_for_refine(connection, workflow_id)?;
    let mut actions = Vec::new();
    for (pattern, rows) in &grouped {
        let Some((body, evidence)) = build_lesson_from_experience(pattern, rows) else {
            actions.push(RefineAction {
                role: pattern.role.clone(),
                model: pattern.model.clone(),
                effort: pattern.effort.clone(),
                action: "skipped".into(),
                lesson_id: None,
                reason: "no recurring failure or recent success".into(),
            });
            continue;
        };
        let dominant_class = evidence
            .get("failureClass")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let dominant_stop = evidence
            .get("dominantStopReason")
            .and_then(Value::as_str)
            .unwrap_or("recurring failure");
        let title = format!(
            "{} failure guidance for {}/{}/{}",
            dominant_class, pattern.role, pattern.model, pattern.effort
        );
        match active_lesson_for_pattern(connection, pattern)? {
            None => {
                let id = create_lesson(
                    connection,
                    &pattern.role,
                    &pattern.model,
                    &pattern.effort,
                    &title,
                    &body,
                    &evidence,
                    "refine",
                )?;
                actions.push(RefineAction {
                    role: pattern.role.clone(),
                    model: pattern.model.clone(),
                    effort: pattern.effort.clone(),
                    action: "created".into(),
                    lesson_id: Some(id),
                    reason: format!(
                        "new recurring '{}' failure ({} occurrences)",
                        dominant_class,
                        evidence
                            .get("failureClassCount")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                    ),
                });
            }
            Some(existing) => {
                let existing_class = existing
                    .evidence
                    .get("failureClass")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let existing_stop = existing
                    .evidence
                    .get("dominantStopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if existing_class == dominant_class && existing_stop == dominant_stop {
                    actions.push(RefineAction {
                        role: pattern.role.clone(),
                        model: pattern.model.clone(),
                        effort: pattern.effort.clone(),
                        action: "skipped".into(),
                        lesson_id: Some(existing.id),
                        reason: "failure signature unchanged".into(),
                    });
                    continue;
                }
                let next = update_lesson_with_title(
                    connection,
                    existing.id,
                    &title,
                    &body,
                    &evidence,
                    REASON_REFINE,
                )?;
                actions.push(RefineAction {
                    role: pattern.role.clone(),
                    model: pattern.model.clone(),
                    effort: pattern.effort.clone(),
                    action: "updated".into(),
                    lesson_id: Some(existing.id),
                    reason: format!(
                        "failure signature shifted '{}:{}' -> '{}:{}' (now v{})",
                        existing_class, existing_stop, dominant_class, dominant_stop, next
                    ),
                });
            }
        }
    }
    Ok(RefineResult { actions })
}

/// Hard-delete lessons whose evidence references only this workflow (used by
/// the workflow-delete transaction). Safe to call on a connection that does not
/// yet have the `harness_lessons` table (returns 0). Lessons are keyed by
/// pattern, not workflow, so cross-workflow lessons that still apply elsewhere
/// are preserved. Uses `hard_delete_lesson` (not the operator-facing soft
/// delete) because the workflow itself is being removed and there is nothing
/// left to audit against.
pub(crate) fn delete_lessons_for_workflow(
    connection: &Connection,
    workflow_id: &str,
) -> Result<usize, String> {
    let table_exists: bool = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_lessons'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !table_exists {
        return Ok(0);
    }
    let lessons = list_lessons(connection, None, None, None, true)?;
    let mut removed = 0usize;
    for lesson in lessons {
        let workflows: Vec<String> = lesson
            .evidence
            .get("sampledWorkflows")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        if workflows.iter().all(|w| w == workflow_id) && !workflows.is_empty() {
            hard_delete_lesson(connection, lesson.id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Prune lessons older than `days` (0 = no prune). Only inactive lessons are
/// pruned; active lessons are retained regardless of age. Safe to call on a
/// connection that does not yet have the `harness_lessons` table (returns 0).
///
/// Snapshots for the to-be-pruned lessons are deleted explicitly first because
/// SQLite has foreign keys disabled by default and this codebase does not
/// enable `PRAGMA foreign_keys = ON`. Relying on the declared `ON DELETE
/// CASCADE` would silently leave orphaned snapshot rows. The child delete uses
/// the same age/status predicate as the parent delete so the two stay in sync.
pub(crate) fn prune_lessons(connection: &Connection, days: u32) -> Result<usize, String> {
    if days == 0 {
        return Ok(0);
    }
    let table_exists: bool = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_lessons'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !table_exists {
        return Ok(0);
    }
    let age = format!("-{} days", days);
    // Delete child snapshots for lessons matching the prune predicate before
    // removing the parent rows. The subselect mirrors the parent WHERE clause
    // exactly so the two deletes cover the same set of lessons.
    connection
        .execute(
            "DELETE FROM harness_lesson_snapshots
             WHERE lesson_id IN (
                 SELECT id FROM harness_lessons
                 WHERE status!='active' AND updated_at < datetime('now', ?1)
             )",
            params![age],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute(
            "DELETE FROM harness_lessons WHERE status!='active' AND updated_at < datetime('now', ?1)",
            params![age],
        )
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands (thin wrappers; state ownership stays in the functions above)
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn list_harness_lessons(
    role: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    include_inactive: Option<bool>,
    database: tauri::State<'_, Database>,
) -> Result<Vec<Value>, String> {
    let connection = db_guard_for(&database);
    let lessons = list_lessons(
        &connection,
        role.as_deref(),
        model.as_deref(),
        effort.as_deref(),
        include_inactive.unwrap_or(false),
    )?;
    Ok(lessons.into_iter().map(lesson_to_json).collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each parameter individually.
pub(crate) fn create_harness_lesson(
    role: String,
    model: String,
    effort: String,
    title: String,
    body: String,
    evidence: Value,
    source: Option<String>,
    database: tauri::State<'_, Database>,
) -> Result<i64, String> {
    let connection = db_guard_for(&database);
    create_lesson(
        &connection,
        &role,
        &model,
        &effort,
        &title,
        &body,
        &evidence,
        &source.unwrap_or_else(|| "manual".into()),
    )
}

#[tauri::command]
pub(crate) fn update_harness_lesson(
    id: i64,
    body: String,
    evidence: Value,
    database: tauri::State<'_, Database>,
) -> Result<i64, String> {
    let connection = db_guard_for(&database);
    update_lesson(&connection, id, &body, &evidence, REASON_EDIT)
}

#[tauri::command]
pub(crate) fn rollback_harness_lesson(
    id: i64,
    to_version: i64,
    database: tauri::State<'_, Database>,
) -> Result<i64, String> {
    let connection = db_guard_for(&database);
    rollback_lesson(&connection, id, to_version)
}

#[tauri::command]
pub(crate) fn delete_harness_lesson(
    id: i64,
    database: tauri::State<'_, Database>,
) -> Result<(), String> {
    let connection = db_guard_for(&database);
    delete_lesson(&connection, id)
}

#[tauri::command]
pub(crate) fn list_harness_lesson_snapshots(
    lesson_id: i64,
    database: tauri::State<'_, Database>,
) -> Result<Vec<Value>, String> {
    let connection = db_guard_for(&database);
    let snapshots = list_snapshots(&connection, lesson_id)?;
    Ok(snapshots.into_iter().map(snapshot_to_json).collect())
}

#[tauri::command]
pub(crate) fn refine_harness_lessons_cmd(
    workflow_id: Option<String>,
    database: tauri::State<'_, Database>,
) -> Result<Value, String> {
    let connection = db_guard_for(&database);
    let result = refine_harness_lessons(&connection, workflow_id.as_deref())?;
    Ok(json!({
        "actions": result.actions.iter().map(|a| json!({
            "role": a.role,
            "model": a.model,
            "effort": a.effort,
            "action": a.action,
            "lessonId": a.lesson_id,
            "reason": a.reason,
        })).collect::<Vec<_>>(),
        "summary": {
            "created": result.actions.iter().filter(|a| a.action == "created").count(),
            "updated": result.actions.iter().filter(|a| a.action == "updated").count(),
            "skipped": result.actions.iter().filter(|a| a.action == "skipped").count(),
        }
    }))
}

fn lesson_to_json(lesson: HarnessLesson) -> Value {
    json!({
        "id": lesson.id,
        "role": lesson.role,
        "model": lesson.model,
        "effort": lesson.effort,
        "title": lesson.title,
        "body": lesson.body,
        "evidence": lesson.evidence,
        "status": lesson.status,
        "source": lesson.source,
        "currentVersion": lesson.current_version,
        "createdAt": lesson.created_at,
        "updatedAt": lesson.updated_at,
    })
}

fn snapshot_to_json(snap: LessonSnapshot) -> Value {
    json!({
        "id": snap.id,
        "lessonId": snap.lesson_id,
        "version": snap.version,
        "body": snap.body,
        "evidence": snap.evidence,
        "snapshotReason": snap.snapshot_reason,
        "createdAt": snap.created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        // node_experience table is needed for refine tests.
        connection
            .execute_batch(
                "CREATE TABLE node_experience (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    node_id TEXT NOT NULL,
                    workflow_id TEXT NOT NULL,
                    role TEXT,
                    model TEXT,
                    effort TEXT,
                    failure_class TEXT,
                    stop_reason TEXT,
                    outcome TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    latency_ms INTEGER,
                    observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );",
            )
            .unwrap();
        connection
    }

    fn seed_experience(
        connection: &Connection,
        role: &str,
        model: &str,
        effort: &str,
        failure_class: Option<&str>,
        stop_reason: Option<&str>,
        outcome: &str,
        workflow_id: &str,
    ) {
        connection
            .execute(
                "INSERT INTO node_experience(node_id,workflow_id,role,model,effort,failure_class,stop_reason,outcome)
                 VALUES('n1',?1,?2,?3,?4,?5,?6,?7)",
                params![workflow_id, role, model, effort, failure_class, stop_reason, outcome],
            )
            .unwrap();
    }

    /// Count all snapshot rows in the table (regardless of lesson). Used to
    /// detect orphaned snapshots that survive a parent delete when SQLite
    /// foreign-key CASCADE is not enforced (the default in this codebase).
    fn count_all_snapshots(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM harness_lesson_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// Count snapshot rows for a specific lesson id. Returns 0 when the lesson
    /// row no longer exists (no orphaned snapshots expected after a correct
    /// delete) — the count is over the snapshots table, not the lessons table.
    fn count_snapshots_for(connection: &Connection, lesson_id: i64) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM harness_lesson_snapshots WHERE lesson_id=?1",
                params![lesson_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn create_lesson_records_initial_snapshot() {
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "backend-engineer",
            "gpt-5.6",
            "medium",
            "Contract hygiene",
            "Always return valid JSON.",
            &json!({"failureClass": "contract"}),
            "manual",
        )
        .unwrap();
        let lesson = get_lesson(&connection, id).unwrap();
        assert_eq!(lesson.current_version, 1);
        assert_eq!(lesson.status, STATUS_ACTIVE);
        let snapshots = list_snapshots(&connection, id).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].version, 1);
        assert_eq!(snapshots[0].snapshot_reason, REASON_CREATE);
    }

    #[test]
    fn update_lesson_snapshots_prior_and_bumps_version() {
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "backend-engineer",
            "gpt-5.6",
            "medium",
            "Contract hygiene",
            "v1 body",
            &json!({"failureClass": "contract"}),
            "manual",
        )
        .unwrap();
        let next = update_lesson(
            &connection,
            id,
            "v2 body",
            &json!({"failureClass": "contract", "dominantStopReason": "max_retries"}),
            REASON_EDIT,
        )
        .unwrap();
        assert_eq!(next, 2);
        let lesson = get_lesson(&connection, id).unwrap();
        assert_eq!(lesson.current_version, 2);
        assert_eq!(lesson.body, "v2 body");
        let snapshots = list_snapshots(&connection, id).unwrap();
        // newest-first: v1 snapshot (reason=edit), then v1 create snapshot
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].version, 1);
        assert_eq!(snapshots[0].snapshot_reason, REASON_EDIT);
        assert_eq!(snapshots[1].version, 1);
        assert_eq!(snapshots[1].snapshot_reason, REASON_CREATE);
    }

    #[test]
    fn rollback_restores_prior_body_and_is_auditable() {
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "backend-engineer",
            "gpt-5.6",
            "medium",
            "Contract hygiene",
            "original body",
            &json!({"failureClass": "contract"}),
            "manual",
        )
        .unwrap();
        update_lesson(&connection, id, "bad refinement", &json!({"failureClass": "plateau"}), REASON_REFINE).unwrap();
        // current_version is now 2, body is "bad refinement"
        let restored = rollback_lesson(&connection, id, 1).unwrap();
        assert_eq!(restored, 3);
        let lesson = get_lesson(&connection, id).unwrap();
        assert_eq!(lesson.body, "original body");
        assert_eq!(lesson.current_version, 3);
        assert_eq!(lesson.status, STATUS_ACTIVE);
        // Snapshot history: v3 (rollback), v2 (rollback of bad), v1 (refine), v1 (create)
        let snapshots = list_snapshots(&connection, id).unwrap();
        assert_eq!(snapshots.len(), 4);
        assert_eq!(snapshots[0].version, 3);
        assert_eq!(snapshots[0].snapshot_reason, REASON_ROLLBACK);
        assert_eq!(snapshots[0].body, "original body");
    }

    #[test]
    fn rollback_rejects_out_of_range_version() {
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "backend-engineer",
            "gpt-5.6",
            "medium",
            "Contract hygiene",
            "body",
            &json!({}),
            "manual",
        )
        .unwrap();
        assert!(rollback_lesson(&connection, id, 0).is_err());
        assert!(rollback_lesson(&connection, id, 5).is_err());
        assert!(rollback_lesson(&connection, id, 1).is_err()); // already at v1
    }

    #[test]
    fn active_lessons_for_pattern_returns_only_active() {
        let connection = fresh_db();
        let id1 = create_lesson(&connection, "r", "m", "e", "a", "body-a", &json!({}), "manual").unwrap();
        // A second active lesson for the same pattern is rejected by the
        // uniqueness invariant.
        assert!(create_lesson(&connection, "r", "m", "e", "b", "body-b", &json!({}), "manual").is_err());
        // Soft-deactivate id1; now a new active lesson can be created.
        delete_lesson(&connection, id1).unwrap();
        let id2 = create_lesson(&connection, "r", "m", "e", "b", "body-b", &json!({}), "manual").unwrap();
        let active = active_lessons_for_pattern(&connection, "r", "m", "e").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, id2);
        assert_eq!(active[0].title, "b");
        // The soft-deleted lesson is still present when include_inactive=true.
        let all = list_lessons(&connection, Some("r"), Some("m"), Some("e"), true).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn lesson_guidance_concatenates_active_lessons() {
        let connection = fresh_db();
        // At most one active lesson per pattern, so guidance is a single
        // block. Use two distinct patterns to verify each gets its own
        // guidance and an empty pattern gets none.
        create_lesson(&connection, "r", "m", "e", "first", "body-one", &json!({}), "manual").unwrap();
        create_lesson(&connection, "r", "m", "e2", "second", "body-two", &json!({}), "manual").unwrap();
        let guidance_a = lesson_guidance(&connection, "r", "m", "e").unwrap();
        assert!(guidance_a.is_some());
        let text_a = guidance_a.unwrap();
        assert!(text_a.contains("body-one"));
        assert!(!text_a.contains("body-two"));
        assert!(text_a.contains("harness lessons"));
        let guidance_b = lesson_guidance(&connection, "r", "m", "e2").unwrap();
        assert!(guidance_b.is_some());
        assert!(guidance_b.unwrap().contains("body-two"));
        // No lessons for an empty pattern.
        assert!(lesson_guidance(&connection, "x", "y", "z").unwrap().is_none());
    }

    #[test]
    fn refine_creates_lesson_for_recurring_failure() {
        let connection = fresh_db();
        seed_experience(&connection, "backend-engineer", "gpt-5.6", "medium", Some("contract"), Some("max_retries"), "max_retries", "wf-a");
        seed_experience(&connection, "backend-engineer", "gpt-5.6", "medium", Some("contract"), Some("max_retries"), "max_retries", "wf-a");
        let result = refine_harness_lessons(&connection, Some("wf-a")).unwrap();
        assert_eq!(result.actions.iter().filter(|a| a.action == "created").count(), 1);
        let lessons = list_lessons(&connection, None, None, None, false).unwrap();
        assert_eq!(lessons.len(), 1);
        assert_eq!(lessons[0].source, "refine");
        assert!(lessons[0].body.contains("structured JSON"));
        let evidence = &lessons[0].evidence;
        assert_eq!(evidence["failureClass"], "contract");
    }

    #[test]
    fn refine_skips_when_recent_success() {
        let connection = fresh_db();
        seed_experience(&connection, "r", "m", "e", Some("contract"), Some("max_retries"), "max_retries", "wf");
        seed_experience(&connection, "r", "m", "e", None, None, "success", "wf");
        let result = refine_harness_lessons(&connection, Some("wf")).unwrap();
        assert!(result.actions.iter().all(|a| a.action == "skipped"));
        assert!(list_lessons(&connection, None, None, None, false).unwrap().is_empty());
    }

    #[test]
    fn refine_updates_lesson_when_signature_shifts() {
        let connection = fresh_db();
        seed_experience(&connection, "r", "m", "e", Some("contract"), Some("max_retries"), "max_retries", "wf");
        seed_experience(&connection, "r", "m", "e", Some("contract"), Some("max_retries"), "max_retries", "wf");
        refine_harness_lessons(&connection, Some("wf")).unwrap();
        // Now the failure pattern shifts to plateau.
        seed_experience(&connection, "r", "m", "e", Some("plateau"), Some("plateau"), "plateau", "wf");
        seed_experience(&connection, "r", "m", "e", Some("plateau"), Some("plateau"), "plateau", "wf");
        seed_experience(&connection, "r", "m", "e", Some("plateau"), Some("plateau"), "plateau", "wf");
        let result = refine_harness_lessons(&connection, Some("wf")).unwrap();
        assert_eq!(result.actions.iter().filter(|a| a.action == "updated").count(), 1);
        let lesson = active_lessons_for_pattern(&connection, "r", "m", "e").unwrap().into_iter().next().unwrap();
        assert_eq!(lesson.current_version, 2);
        assert!(lesson.body.contains("plateau"));
        // The title must follow the new failure signature so the inspector UI
        // and Byte/mediator digests do not show a stale label.
        assert!(
            lesson.title.contains("plateau"),
            "title should reflect the new 'plateau' signature; got '{}'",
            lesson.title
        );
        assert!(
            !lesson.title.contains("contract"),
            "title should not retain the old 'contract' signature; got '{}'",
            lesson.title
        );
    }

    #[test]
    fn refine_skips_when_signature_unchanged() {
        let connection = fresh_db();
        for _ in 0..2 {
            seed_experience(&connection, "r", "m", "e", Some("contract"), Some("max_retries"), "max_retries", "wf");
        }
        refine_harness_lessons(&connection, Some("wf")).unwrap();
        // Second refine with the same signature should skip.
        for _ in 0..2 {
            seed_experience(&connection, "r", "m", "e", Some("contract"), Some("max_retries"), "max_retries", "wf");
        }
        let result = refine_harness_lessons(&connection, Some("wf")).unwrap();
        assert!(result.actions.iter().all(|a| a.action == "skipped"));
        let lesson = active_lessons_for_pattern(&connection, "r", "m", "e").unwrap().into_iter().next().unwrap();
        assert_eq!(lesson.current_version, 1);
    }

    #[test]
    fn delete_lessons_for_workflow_preserves_cross_workflow_lessons() {
        let connection = fresh_db();
        // Lesson whose evidence only references wf-a.
        create_lesson(
            &connection,
            "r",
            "m",
            "e",
            "wf-a only",
            "body",
            &json!({"sampledWorkflows": ["wf-a"]}),
            "manual",
        )
        .unwrap();
        // Lesson referenced by two workflows. Use a distinct pattern so the
        // per-pattern active-lesson uniqueness invariant is not violated.
        create_lesson(
            &connection,
            "r",
            "m",
            "e2",
            "shared",
            "body",
            &json!({"sampledWorkflows": ["wf-a", "wf-b"]}),
            "manual",
        )
        .unwrap();
        let removed = delete_lessons_for_workflow(&connection, "wf-a").unwrap();
        assert_eq!(removed, 1);
        let remaining = list_lessons(&connection, None, None, None, true).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].title, "shared");
        // The hard-deleted lesson's snapshots must not be orphaned. SQLite
        // foreign keys are off by default in this codebase, so CASCADE does
        // not fire — hard_delete_lesson must reap child rows explicitly.
        let orphaned = count_all_snapshots(&connection);
        assert_eq!(
            orphaned, 1,
            "only the preserved 'shared' lesson's snapshot should remain; got {orphaned} orphaned/total"
        );
    }

    #[test]
    fn prune_removes_only_old_inactive_lessons() {
        let connection = fresh_db();
        let active_id = create_lesson(&connection, "r", "m", "e", "active", "body", &json!({}), "manual").unwrap();
        let inactive_id = create_lesson(&connection, "r", "m", "e2", "inactive", "body", &json!({}), "manual").unwrap();
        // Mark inactive as old.
        connection
            .execute(
                "UPDATE harness_lessons SET status='rolled_back', updated_at=datetime('now','-30 days') WHERE id=?1",
                params![inactive_id],
            )
            .unwrap();
        let pruned = prune_lessons(&connection, 7).unwrap();
        assert_eq!(pruned, 1);
        assert!(get_lesson(&connection, active_id).is_ok());
        assert!(get_lesson(&connection, inactive_id).is_err());
        // The pruned lesson's snapshots must not be orphaned. SQLite foreign
        // keys are off by default in this codebase, so CASCADE does not fire —
        // prune_lessons must reap child rows explicitly before the parent.
        let orphaned = count_snapshots_for(&connection, inactive_id);
        assert_eq!(orphaned, 0, "pruned lesson's snapshots should be reaped; got {orphaned}");
        // The active lesson's snapshot is retained.
        assert_eq!(count_snapshots_for(&connection, active_id), 1);
    }

    #[test]
    fn soft_delete_marks_superseded_and_prune_reaps_it() {
        let connection = fresh_db();
        let id = create_lesson(&connection, "r", "m", "e", "a", "body", &json!({}), "manual").unwrap();
        // Operator-facing delete is a soft-delete: row stays for audit.
        delete_lesson(&connection, id).unwrap();
        let lesson = get_lesson(&connection, id).unwrap();
        assert_eq!(lesson.status, STATUS_SUPERSEDED);
        // It no longer applies at run time.
        assert!(active_lessons_for_pattern(&connection, "r", "m", "e")
            .unwrap()
            .is_empty());
        // A new active lesson can now be created for the same pattern.
        create_lesson(&connection, "r", "m", "e", "b", "body-b", &json!({}), "manual").unwrap();
        // Mark the superseded row as old so prune reaps it.
        connection
            .execute(
                "UPDATE harness_lessons SET updated_at=datetime('now','-30 days') WHERE id=?1 AND status='superseded'",
                params![id],
            )
            .unwrap();
        let pruned = prune_lessons(&connection, 7).unwrap();
        assert_eq!(pruned, 1);
        // The superseded row is gone; the new active lesson remains.
        assert!(get_lesson(&connection, id).is_err());
        assert_eq!(active_lessons_for_pattern(&connection, "r", "m", "e").unwrap().len(), 1);
    }

    #[test]
    fn create_lesson_rejects_duplicate_active_for_same_pattern() {
        let connection = fresh_db();
        create_lesson(&connection, "r", "m", "e", "a", "body-a", &json!({}), "manual").unwrap();
        let err = create_lesson(&connection, "r", "m", "e", "b", "body-b", &json!({}), "manual")
            .unwrap_err();
        assert!(err.contains("active lesson already exists"), "got: {err}");
        // Distinct patterns are still allowed.
        create_lesson(&connection, "r", "m", "e2", "b", "body-b", &json!({}), "manual").unwrap();
    }

    #[test]
    fn refine_is_deterministic_on_tied_failure_classes() {
        // Two failure classes with equal counts (>= REFINE_MIN_FAILURES).
        // The dominant class must be the lexicographically smaller one
        // ("contract" < "plateau") every time, not an arbitrary HashMap winner.
        let connection = fresh_db();
        for _ in 0..2 {
            seed_experience(&connection, "r", "m", "e", Some("plateau"), Some("p"), "plateau", "wf");
        }
        for _ in 0..2 {
            seed_experience(&connection, "r", "m", "e", Some("contract"), Some("c"), "max_retries", "wf");
        }
        let result = refine_harness_lessons(&connection, Some("wf")).unwrap();
        assert_eq!(
            result.actions.iter().filter(|a| a.action == "created").count(),
            1
        );
        let lesson = active_lessons_for_pattern(&connection, "r", "m", "e")
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(lesson.evidence["failureClass"], "contract");
        // Run refine again with the same data — signature unchanged, skip.
        let result2 = refine_harness_lessons(&connection, Some("wf")).unwrap();
        assert!(result2.actions.iter().all(|a| a.action == "skipped"));
    }

    #[test]
    fn refine_actions_are_ordered_deterministically_by_pattern() {
        // Multiple patterns; the refine action order must follow BTreeMap key
        // order (role, model, effort), not random HashMap order.
        let connection = fresh_db();
        // Seed two patterns with recurring failures. Use distinct patterns so
        // the order in `result.actions` is observable.
        for _ in 0..2 {
            seed_experience(&connection, "zeta", "m", "e", Some("contract"), Some("c"), "max_retries", "wf");
        }
        for _ in 0..2 {
            seed_experience(&connection, "alpha", "m", "e", Some("contract"), Some("c"), "max_retries", "wf");
        }
        let result = refine_harness_lessons(&connection, Some("wf")).unwrap();
        let created: Vec<&str> = result
            .actions
            .iter()
            .filter(|a| a.action == "created")
            .map(|a| a.role.as_str())
            .collect();
        assert_eq!(created, vec!["alpha", "zeta"]);
    }

    #[test]
    fn hard_delete_lesson_reaps_child_snapshots() {
        // SQLite foreign keys are off by default in this codebase, so the
        // declared ON DELETE CASCADE does not fire. hard_delete_lesson must
        // delete child snapshot rows explicitly or they accumulate as orphans
        // with no cleanup path. This test pins that invariant directly.
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "r",
            "m",
            "e",
            "title",
            "body",
            &json!({"failureClass": "contract"}),
            "manual",
        )
        .unwrap();
        // Produce a few snapshot versions so there is something to orphan.
        update_lesson(&connection, id, "v2", &json!({"failureClass": "plateau"}), REASON_REFINE).unwrap();
        update_lesson(&connection, id, "v3", &json!({"failureClass": "verification"}), REASON_REFINE).unwrap();
        assert_eq!(count_snapshots_for(&connection, id), 3);
        // delete_lessons_for_workflow is the only caller of hard_delete_lesson;
        // exercise it via that path so the test covers the real call site.
        let removed = delete_lessons_for_workflow(&connection, "wf-not-referenced").unwrap();
        assert_eq!(removed, 0, "no lesson references this workflow; nothing should be removed");
        // Now delete via a workflow the lesson's evidence does reference.
        // Re-seed evidence so the lesson is wf-target-only.
        update_lesson_with_title(
            &connection,
            id,
            "title",
            "body",
            &json!({"sampledWorkflows": ["wf-target"]}),
            REASON_EDIT,
        )
        .unwrap();
        let removed = delete_lessons_for_workflow(&connection, "wf-target").unwrap();
        assert_eq!(removed, 1);
        // The lesson row is gone...
        assert!(get_lesson(&connection, id).is_err());
        // ...and its snapshots must not be orphaned.
        assert_eq!(
            count_snapshots_for(&connection, id),
            0,
            "hard_delete_lesson must reap child snapshots; orphans found"
        );
        assert_eq!(count_all_snapshots(&connection), 0);
    }

    #[test]
    fn update_lesson_with_title_updates_title_and_body() {
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "r",
            "m",
            "e",
            "old title",
            "old body",
            &json!({"failureClass": "contract"}),
            "manual",
        )
        .unwrap();
        let next = update_lesson_with_title(
            &connection,
            id,
            "new title",
            "new body",
            &json!({"failureClass": "plateau"}),
            REASON_REFINE,
        )
        .unwrap();
        assert_eq!(next, 2);
        let lesson = get_lesson(&connection, id).unwrap();
        assert_eq!(lesson.title, "new title");
        assert_eq!(lesson.body, "new body");
        assert_eq!(lesson.current_version, 2);
        // The prior version is snapshotted (edit reason) plus the create snapshot.
        let snapshots = list_snapshots(&connection, id).unwrap();
        assert_eq!(snapshots.len(), 2);
    }

    #[test]
    fn update_lesson_leaves_title_unchanged() {
        // The operator-facing update path must not touch the title — operators
        // edit body/evidence only via the Tauri command.
        let connection = fresh_db();
        let id = create_lesson(
            &connection,
            "r",
            "m",
            "e",
            "keep me",
            "old body",
            &json!({}),
            "manual",
        )
        .unwrap();
        update_lesson(&connection, id, "new body", &json!({"k": 1}), REASON_EDIT).unwrap();
        let lesson = get_lesson(&connection, id).unwrap();
        assert_eq!(lesson.title, "keep me");
        assert_eq!(lesson.body, "new body");
    }
}
