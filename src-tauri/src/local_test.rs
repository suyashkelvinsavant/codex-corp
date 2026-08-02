//! Native local-test lifecycle for verified Release Bundle outputs.
//!
//! The renderer never executes a model-provided command. This module derives a
//! launch plan from the persisted run workspace, shows that plan to the operator,
//! and only spawns it after an explicit in-app decision. Child processes are
//! tracked separately from Codex worker processes so stopping a workflow cannot
//! accidentally kill the app under test.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Runtime};

use crate::platform_process::background_command;
use crate::verifier::command::ProcessTreeGuard;
use crate::Database;

const MAX_PACKAGE_JSON_BYTES: u64 = 1_000_000;
const MAX_MANIFEST_BYTES: u64 = 64_000;
const MAX_FEEDBACK_BYTES: usize = 4_000;
const MAX_FEEDBACK_ITEMS: usize = 8;
const MAX_ARGS: usize = 32;
const MAX_ARG_LENGTH: usize = 2_000;
const STATIC_PREVIEW_PORT: u16 = 4_173;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalLaunchPlan {
    pub(crate) kind: String,
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: String,
    pub(crate) entrypoint: String,
    pub(crate) display_command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) script: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalTestSession {
    pub(crate) id: String,
    pub(crate) workflow_id: String,
    pub(crate) run_id: String,
    pub(crate) workspace_path: String,
    pub(crate) status: String,
    pub(crate) plan: LocalLaunchPlan,
    pub(crate) feedback: Vec<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detected_url: Option<String>,
}

struct LocalTestProcess {
    child: Child,
    process_tree: ProcessTreeGuard,
}

impl LocalTestProcess {
    fn terminate(&mut self) {
        let Self {
            child,
            process_tree,
        } = self;
        process_tree.terminate(child);
    }
}

#[derive(Clone, Default)]
pub(crate) struct LocalTestProcessRegistry(
    Arc<Mutex<HashMap<String, Arc<Mutex<LocalTestProcess>>>>>,
);

impl LocalTestProcessRegistry {
    fn contains(&self, session_id: &str) -> bool {
        self.0
            .lock()
            .map(|processes| processes.contains_key(session_id))
            .unwrap_or(false)
    }

    fn insert(
        &self,
        session_id: String,
        process: Arc<Mutex<LocalTestProcess>>,
    ) -> Result<(), String> {
        let mut processes = self
            .0
            .lock()
            .map_err(|_| "local test process registry lock poisoned".to_string())?;
        if processes.contains_key(&session_id) {
            return Err("a local test process is already running for this session".into());
        }
        processes.insert(session_id, process);
        Ok(())
    }

    fn remove(&self, session_id: &str) -> Option<Arc<Mutex<LocalTestProcess>>> {
        self.0.lock().ok()?.remove(session_id)
    }
}

impl Drop for LocalTestProcessRegistry {
    fn drop(&mut self) {
        if Arc::strong_count(&self.0) != 1 {
            return;
        }
        if let Ok(mut processes) = self.0.lock() {
            for process in processes.values() {
                if let Ok(mut process) = process.lock() {
                    process.terminate();
                    let _ = process.child.wait();
                }
            }
            processes.clear();
        }
    }
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_test_sessions (
                id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                status TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                feedback_json TEXT NOT NULL DEFAULT '[]',
                pid INTEGER,
                last_error TEXT,
                detected_url TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_local_test_sessions_run_id
                ON local_test_sessions(run_id);
            CREATE INDEX IF NOT EXISTS idx_local_test_sessions_workflow_updated
                ON local_test_sessions(workflow_id, updated_at DESC);",
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn prepare_local_test(
    workflow_id: String,
    run_id: String,
    database: tauri::State<'_, Database>,
) -> Result<LocalTestSession, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    if let Some(existing) = load_session_for_run(&connection, &run_id)? {
        if existing.workflow_id != workflow_id {
            return Err("local test run does not belong to this workflow".into());
        }
        return Ok(existing);
    }

    let (status, stored_workflow_id, workspace_path, nodes_json): (
        String,
        String,
        Option<String>,
        String,
    ) = connection
        .query_row(
            "SELECT status,workflow_id,workspace_path,COALESCE(nodes_json,'') FROM runs WHERE id=?1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )
        .map_err(|_| "run was not found".to_string())?;
    if stored_workflow_id != workflow_id {
        return Err("local test run does not belong to this workflow".into());
    }
    if status != "completed" {
        return Err("local testing is available only after a completed Release Bundle run".into());
    }
    verify_delivery_output(&connection, &run_id, &nodes_json)?;
    let workspace = canonical_workspace(workspace_path.as_deref())?;
    let plan = discover_launch_plan(&workspace)?;
    validate_launch_plan(&plan, &workspace)?;
    let detected_url = detected_url_for_plan(&plan);

    let now = now_iso();
    let session = LocalTestSession {
        id: format!(
            "local-test-{}-{}",
            std::process::id(),
            now.replace([':', '-', '.', 'T', 'Z'], "")
        ),
        workflow_id,
        run_id,
        workspace_path: workspace.to_string_lossy().into_owned(),
        status: "launch_pending".into(),
        plan,
        feedback: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        pid: None,
        last_error: None,
        detected_url,
    };
    save_session(&connection, &session)?;
    Ok(session)
}

#[tauri::command]
pub(crate) fn get_local_test(
    workflow_id: String,
    database: tauri::State<'_, Database>,
    processes: tauri::State<'_, LocalTestProcessRegistry>,
) -> Result<Option<LocalTestSession>, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let Some(mut session) = load_latest_session(&connection, &workflow_id)? else {
        return Ok(None);
    };
    if session.status == "running" && !processes.contains(&session.id) {
        session.status = "exited".into();
        session.pid = None;
        session.last_error =
            Some("The local test process was not restored after Codex Corp restarted.".into());
        session.updated_at = now_iso();
        save_session(&connection, &session)?;
    }
    Ok(Some(session))
}

#[tauri::command]
pub(crate) fn approve_local_test_launch(
    session_id: String,
    approved: bool,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
    processes: tauri::State<'_, LocalTestProcessRegistry>,
) -> Result<LocalTestSession, String> {
    approve_local_test_launch_with_app(
        session_id,
        approved,
        &app,
        database.inner(),
        processes.inner(),
    )
}

fn approve_local_test_launch_with_app<R: Runtime>(
    session_id: String,
    approved: bool,
    app: &tauri::AppHandle<R>,
    database: &Database,
    processes: &LocalTestProcessRegistry,
) -> Result<LocalTestSession, String> {
    let mut session = {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        load_session(&connection, &session_id)?.ok_or("local test session was not found")?
    };
    if session.status != "launch_pending" {
        return Ok(session);
    }
    if !approved {
        session.status = "declined".into();
        session.updated_at = now_iso();
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        save_session(&connection, &session)?;
        emit_event(app, &session);
        return Ok(session);
    }

    let workspace = canonical_workspace(Some(&session.workspace_path))?;
    let fresh_plan = discover_launch_plan(&workspace)?;
    if fresh_plan != session.plan {
        session.status = "launch_failed".into();
        session.last_error = Some(
            "The project launch metadata changed after approval was requested. Re-run the workflow to review the new launch plan.".into(),
        );
        session.updated_at = now_iso();
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        save_session(&connection, &session)?;
        emit_event(app, &session);
        return Ok(session);
    }
    validate_launch_plan(&fresh_plan, &workspace)?;
    session.status = "launching".into();
    session.last_error = None;
    session.updated_at = now_iso();
    {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        save_session(&connection, &session)?;
    }
    emit_event(app, &session);

    let child = match spawn_local_process(&fresh_plan) {
        Ok(child) => Arc::new(Mutex::new(LocalTestProcess {
            process_tree: ProcessTreeGuard::attach(&child),
            child,
        })),
        Err(error) => {
            session.status = "launch_failed".into();
            session.last_error = Some(error);
            session.updated_at = now_iso();
            let connection = database
                .0
                .lock()
                .map_err(|_| "database lock poisoned".to_string())?;
            save_session(&connection, &session)?;
            emit_event(app, &session);
            return Ok(session);
        }
    };
    let pid = child
        .lock()
        .map_err(|_| "local test process lock poisoned".to_string())?
        .child
        .id();
    processes.insert(session.id.clone(), child.clone())?;
    session.status = "running".into();
    session.pid = Some(pid);
    session.updated_at = now_iso();
    {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        save_session(&connection, &session)?;
    }
    emit_event(app, &session);
    monitor_local_process(
        session.id.clone(),
        child,
        processes.clone(),
        database.clone(),
        app.clone(),
    );
    Ok(session)
}

#[tauri::command]
pub(crate) fn submit_local_test_feedback(
    session_id: String,
    approved: bool,
    feedback: String,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
    processes: tauri::State<'_, LocalTestProcessRegistry>,
) -> Result<LocalTestSession, String> {
    submit_local_test_feedback_with_app(
        session_id,
        approved,
        feedback,
        &app,
        database.inner(),
        processes.inner(),
    )
}

fn submit_local_test_feedback_with_app<R: Runtime>(
    session_id: String,
    approved: bool,
    feedback: String,
    app: &tauri::AppHandle<R>,
    database: &Database,
    processes: &LocalTestProcessRegistry,
) -> Result<LocalTestSession, String> {
    let mut session = {
        let connection = database
            .0
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        load_session(&connection, &session_id)?.ok_or("local test session was not found")?
    };
    if session.status != "running" && session.status != "exited" {
        return Err("the local test must be running before it can be reviewed".into());
    }
    let feedback = normalize_feedback(&feedback);
    if !approved && feedback.is_empty() {
        return Err("concrete feedback is required when requesting changes".into());
    }
    if !feedback.is_empty() {
        append_feedback(&mut session.feedback, feedback);
    }
    session.status = if approved {
        "approved".into()
    } else {
        "changes_requested".into()
    };
    session.pid = None;
    session.updated_at = now_iso();
    // The operator has finished inspecting the app. Approval is a terminal
    // review decision, so clean up the launched process tree in both the
    // approval and change-request paths before returning control to the
    // workflow runtime.
    terminate_process(processes, &session.id);
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    save_session(&connection, &session)?;
    drop(connection);
    emit_event(app, &session);
    Ok(session)
}

#[tauri::command]
pub(crate) fn stop_local_test(
    session_id: String,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
    processes: tauri::State<'_, LocalTestProcessRegistry>,
) -> Result<LocalTestSession, String> {
    terminate_process(processes.inner(), &session_id);
    let connection = database
        .0
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let mut session =
        load_session(&connection, &session_id)?.ok_or("local test session was not found")?;
    if matches!(session.status.as_str(), "running" | "launching") {
        session.status = "stopped".into();
        session.pid = None;
        session.updated_at = now_iso();
        save_session(&connection, &session)?;
    }
    drop(connection);
    emit_event(&app, &session);
    Ok(session)
}

fn verify_delivery_output(
    connection: &Connection,
    run_id: &str,
    nodes_json: &str,
) -> Result<(), String> {
    let nodes: Vec<Value> = serde_json::from_str(nodes_json)
        .map_err(|_| "completed run has no readable graph snapshot".to_string())?;
    let output_id = nodes
        .iter()
        .find(|node| {
            node.get("data")
                .and_then(|data| data.get("kind"))
                .and_then(Value::as_str)
                == Some("output")
        })
        .and_then(|node| node.get("id"))
        .and_then(Value::as_str)
        .ok_or("completed run has no Release Bundle node")?;
    let (status, output_json): (String, Option<String>) = connection
        .query_row(
            "SELECT status,output_json FROM node_executions WHERE run_id=?1 AND node_id=?2",
            params![run_id, output_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Release Bundle output was not persisted".to_string())?;
    if status != "success" {
        return Err("Release Bundle did not complete successfully".into());
    }
    let output: Value = serde_json::from_str(
        output_json
            .as_deref()
            .ok_or("Release Bundle output is empty")?,
    )
    .map_err(|_| "Release Bundle output is unreadable".to_string())?;
    let bundle = output.get("data").and_then(|data| data.as_object());
    if bundle
        .and_then(|data| data.get("schemaVersion"))
        .and_then(Value::as_str)
        != Some("codex-corp.delivery.v3")
        || bundle
            .and_then(|data| data.get("status"))
            .and_then(Value::as_str)
            != Some("success")
    {
        return Err("Release Bundle is not a verified live delivery bundle".into());
    }
    Ok(())
}

fn canonical_workspace(raw: Option<&str>) -> Result<PathBuf, String> {
    let raw = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("the completed run has no selected app workspace")?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("the selected app workspace must be an absolute path".into());
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("could not resolve the selected app workspace: {error}"))?;
    if !canonical.is_dir() {
        return Err("the selected app workspace is not a folder".into());
    }
    Ok(canonical)
}

fn discover_launch_plan(workspace: &Path) -> Result<LocalLaunchPlan, String> {
    let manifest = workspace.join("codex-corp.launch.json");
    if is_regular_file(&manifest) {
        return discover_manifest_plan(workspace, &manifest);
    }

    let package = workspace.join("package.json");
    if is_regular_file(&package) {
        if fs::metadata(&package)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_PACKAGE_JSON_BYTES
        {
            return Err("package.json is too large to inspect for local testing".into());
        }
        let raw = fs::read_to_string(&package)
            .map_err(|error| format!("could not read package.json: {error}"))?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("package.json is not valid JSON: {error}"))?;
        if let Some(scripts) = value.get("scripts").and_then(Value::as_object) {
            for name in ["dev", "start", "preview", "serve"] {
                let Some(script) = scripts
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|script| !script.is_empty())
                else {
                    continue;
                };
                if script.len() > MAX_ARG_LENGTH {
                    return Err(format!(
                        "package script {name} is too long to launch safely"
                    ));
                }
                let runtime = choose_package_manager(workspace);
                let program = resolve_runtime(&runtime)?;
                let args = vec!["run".into(), name.into()];
                return Ok(LocalLaunchPlan {
                    kind: "package-script".into(),
                    display_command: display_command(&program, &args),
                    program: program.to_string_lossy().into_owned(),
                    args,
                    cwd: workspace.to_string_lossy().into_owned(),
                    entrypoint: format!("package.json#scripts.{name}"),
                    script: Some(script.into()),
                });
            }
        }
    }

    if is_regular_file(&workspace.join("Cargo.toml")) {
        let program = resolve_runtime("cargo")?;
        let args = vec!["run".into()];
        return Ok(LocalLaunchPlan {
            kind: "cargo".into(),
            display_command: display_command(&program, &args),
            program: program.to_string_lossy().into_owned(),
            args,
            cwd: workspace.to_string_lossy().into_owned(),
            entrypoint: "Cargo.toml".into(),
            script: None,
        });
    }

    let static_root = if is_regular_file(&workspace.join("index.html")) {
        Some((workspace.to_path_buf(), "index.html".to_string()))
    } else if is_regular_file(&workspace.join("dist").join("index.html")) {
        Some((workspace.join("dist"), "dist/index.html".to_string()))
    } else {
        None
    };
    if let Some((root, entrypoint)) = static_root {
        let program = resolve_runtime("python")?;
        let root_string = root.to_string_lossy().into_owned();
        let args = vec![
            "-m".into(),
            "http.server".into(),
            STATIC_PREVIEW_PORT.to_string(),
            "--bind".into(),
            "127.0.0.1".into(),
            "--directory".into(),
            root_string,
        ];
        return Ok(LocalLaunchPlan {
            kind: "static".into(),
            display_command: display_command(&program, &args),
            program: program.to_string_lossy().into_owned(),
            args,
            cwd: workspace.to_string_lossy().into_owned(),
            entrypoint,
            script: None,
        });
    }

    Err("No supported local launch target was found. Add a package.json dev/start script, Cargo.toml, index.html, or codex-corp.launch.json.".into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchManifest {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
}

fn discover_manifest_plan(
    workspace: &Path,
    manifest_path: &Path,
) -> Result<LocalLaunchPlan, String> {
    let size = fs::metadata(manifest_path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_MANIFEST_BYTES {
        return Err("codex-corp.launch.json is too large to inspect safely".into());
    }
    let raw = fs::read_to_string(manifest_path)
        .map_err(|error| format!("could not read codex-corp.launch.json: {error}"))?;
    let manifest: LaunchManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("codex-corp.launch.json is invalid: {error}"))?;
    let program_path = resolve_workspace_path(workspace, &manifest.program)?;
    let cwd = manifest
        .cwd
        .as_deref()
        .map(|path| resolve_workspace_path(workspace, path))
        .transpose()?
        .unwrap_or_else(|| workspace.to_path_buf());
    if !program_path.is_file() {
        return Err("codex-corp.launch.json program is not a file".into());
    }
    let program = fs::canonicalize(&program_path)
        .map_err(|error| format!("could not resolve launch program: {error}"))?;
    let cwd = fs::canonicalize(&cwd)
        .map_err(|error| format!("could not resolve launch working directory: {error}"))?;
    if is_shell_program(&program) {
        return Err("shell interpreters are not allowed in codex-corp.launch.json".into());
    }
    if !is_path_inside(&program, workspace) || !is_path_inside(&cwd, workspace) {
        return Err("manifest launch paths must remain inside the selected workspace".into());
    }
    let args = manifest.args;
    validate_args(&args)?;
    Ok(LocalLaunchPlan {
        kind: "manifest".into(),
        display_command: display_command(&program, &args),
        program: program.to_string_lossy().into_owned(),
        args,
        cwd: cwd.to_string_lossy().into_owned(),
        entrypoint: "codex-corp.launch.json".into(),
        script: None,
    })
}

fn resolve_workspace_path(workspace: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() || has_control_characters(raw) {
        return Err("launch manifest contains an invalid path".into());
    }
    let path = PathBuf::from(raw);
    let candidate = if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    };
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("launch manifest path cannot be resolved: {error}"))?;
    if !is_path_inside(&canonical, workspace) {
        return Err("launch manifest path escapes the selected workspace".into());
    }
    Ok(canonical)
}

fn validate_launch_plan(plan: &LocalLaunchPlan, workspace: &Path) -> Result<(), String> {
    if plan.program.trim().is_empty() || plan.cwd.trim().is_empty() {
        return Err("launch plan requires a program and working directory".into());
    }
    if has_control_characters(&plan.program) || has_control_characters(&plan.cwd) {
        return Err("launch plan contains control characters".into());
    }
    validate_args(&plan.args)?;
    if let Some(script) = &plan.script {
        if script.trim().is_empty()
            || script.len() > MAX_ARG_LENGTH
            || has_control_characters(script)
        {
            return Err("launch package script is malformed".into());
        }
    }
    let program = PathBuf::from(&plan.program);
    let cwd = PathBuf::from(&plan.cwd);
    if !cwd.is_absolute() || !program.is_absolute() {
        return Err("launch plan paths must be absolute".into());
    }
    if is_shell_program(&program) {
        return Err("shell interpreters are not allowed as local launch programs".into());
    }
    let program_name = file_name_lower(&program);
    let known_runtime = matches!(
        program_name.as_str(),
        "npm"
            | "npm.cmd"
            | "pnpm"
            | "pnpm.cmd"
            | "yarn"
            | "yarn.cmd"
            | "bun"
            | "bun.exe"
            | "python"
            | "python.exe"
            | "cargo"
            | "cargo.exe"
    );
    if !known_runtime && !is_path_inside(&program, workspace) {
        return Err("launch executable must remain inside the selected workspace".into());
    }
    if !is_path_inside(&cwd, workspace) {
        return Err("launch working directory must remain inside the selected workspace".into());
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_ARGS {
        return Err("launch plan has too many arguments".into());
    }
    if args
        .iter()
        .any(|arg| arg.len() > MAX_ARG_LENGTH || has_control_characters(arg))
    {
        return Err("launch plan contains control characters or an oversized argument".into());
    }
    Ok(())
}

fn choose_package_manager(workspace: &Path) -> String {
    if workspace.join("pnpm-lock.yaml").is_file() {
        "pnpm".into()
    } else if workspace.join("yarn.lock").is_file() {
        "yarn".into()
    } else if workspace.join("bun.lock").is_file() || workspace.join("bun.lockb").is_file() {
        "bun".into()
    } else {
        "npm".into()
    }
}

fn resolve_runtime(name: &str) -> Result<PathBuf, String> {
    let executable_names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.cmd"), format!("{name}.exe"), name.into()]
    } else {
        vec![name.into()]
    };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.extend(executable_names.iter().map(|entry| directory.join(entry)));
        }
    }
    if cfg!(windows) {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let node = PathBuf::from(program_files).join("nodejs");
            candidates.extend(executable_names.iter().map(|entry| node.join(entry)));
        }
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let npm = PathBuf::from(app_data).join("npm");
            candidates.extend(executable_names.iter().map(|entry| npm.join(entry)));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("required local test runtime was not found: {name}"))
}

fn spawn_local_process(plan: &LocalLaunchPlan) -> Result<Child, String> {
    let mut command = background_command(&plan.program);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start the local test process: {error}"))?;
    drain_pipe(child.stdout.take());
    drain_pipe(child.stderr.take());
    Ok(child)
}

fn drain_pipe<T: Read + Send + 'static>(pipe: Option<T>) {
    let Some(pipe) = pipe else { return };
    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines() {
            if line.is_err() {
                break;
            }
        }
    });
}

fn monitor_local_process<R: Runtime>(
    session_id: String,
    child: Arc<Mutex<LocalTestProcess>>,
    processes: LocalTestProcessRegistry,
    database: Database,
    app: tauri::AppHandle<R>,
) {
    thread::spawn(move || loop {
        let exit = child
            .lock()
            .ok()
            .and_then(|mut process| process.child.try_wait().ok().flatten());
        if let Some(exit) = exit {
            processes.remove(&session_id);
            if let Ok(connection) = database.0.lock() {
                if let Ok(Some(mut session)) = load_session(&connection, &session_id) {
                    if matches!(session.status.as_str(), "running" | "launching") {
                        session.status = "exited".into();
                        session.pid = None;
                        if !exit.success() {
                            session.last_error = Some(format!(
                                "The local test process exited with {}.",
                                exit.code()
                                    .map(|code| code.to_string())
                                    .unwrap_or_else(|| "a signal".into())
                            ));
                        }
                        session.updated_at = now_iso();
                        let _ = save_session(&connection, &session);
                        emit_event(&app, &session);
                    }
                }
            }
            break;
        }
        thread::sleep(Duration::from_millis(250));
    });
}

fn terminate_process(processes: &LocalTestProcessRegistry, session_id: &str) {
    let Some(child) = processes.remove(session_id) else {
        return;
    };
    let child_result = child.lock();
    if let Ok(mut process) = child_result {
        process.terminate();
        let _ = process.child.wait();
    }
}

fn emit_event<R: Runtime>(app: &tauri::AppHandle<R>, session: &LocalTestSession) {
    let _ = app.emit("local-test-event", session);
}

fn save_session(connection: &Connection, session: &LocalTestSession) -> Result<(), String> {
    let plan = serde_json::to_string(&session.plan).map_err(|error| error.to_string())?;
    let feedback = serde_json::to_string(&session.feedback).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO local_test_sessions(id,workflow_id,run_id,workspace_path,status,plan_json,feedback_json,pid,last_error,detected_url,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status,plan_json=excluded.plan_json,feedback_json=excluded.feedback_json,pid=excluded.pid,last_error=excluded.last_error,detected_url=excluded.detected_url,updated_at=excluded.updated_at",
            params![
                session.id,
                session.workflow_id,
                session.run_id,
                session.workspace_path,
                session.status,
                plan,
                feedback,
                session.pid,
                session.last_error,
                session.detected_url,
                session.created_at,
                session.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn load_session(connection: &Connection, id: &str) -> Result<Option<LocalTestSession>, String> {
    connection
        .query_row(
            "SELECT id,workflow_id,run_id,workspace_path,status,plan_json,feedback_json, pid,last_error,detected_url,created_at,updated_at FROM local_test_sessions WHERE id=?1",
            params![id],
            session_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn load_session_for_run(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<LocalTestSession>, String> {
    connection
        .query_row(
            "SELECT id,workflow_id,run_id,workspace_path,status,plan_json,feedback_json, pid,last_error,detected_url,created_at,updated_at FROM local_test_sessions WHERE run_id=?1",
            params![run_id],
            session_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn load_latest_session(
    connection: &Connection,
    workflow_id: &str,
) -> Result<Option<LocalTestSession>, String> {
    connection
        .query_row(
            "SELECT id,workflow_id,run_id,workspace_path,status,plan_json,feedback_json, pid,last_error,detected_url,created_at,updated_at FROM local_test_sessions WHERE workflow_id=?1 ORDER BY updated_at DESC,id DESC LIMIT 1",
            params![workflow_id],
            session_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalTestSession> {
    let plan_json: String = row.get(5)?;
    let feedback_json: String = row.get(6)?;
    Ok(LocalTestSession {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        run_id: row.get(2)?,
        workspace_path: row.get(3)?,
        status: row.get(4)?,
        plan: serde_json::from_str(&plan_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        feedback: serde_json::from_str(&feedback_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        pid: row.get(7)?,
        last_error: row.get(8)?,
        detected_url: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn append_feedback(feedback: &mut Vec<String>, value: String) {
    feedback.retain(|item| item != &value);
    feedback.push(value);
    if feedback.len() > MAX_FEEDBACK_ITEMS {
        let remove = feedback.len() - MAX_FEEDBACK_ITEMS;
        feedback.drain(0..remove);
    }
}

fn normalize_feedback(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut bounded = String::new();
    for character in normalized.chars() {
        if bounded.len() + character.len_utf8() > MAX_FEEDBACK_BYTES {
            break;
        }
        bounded.push(character);
    }
    bounded
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(|character| character.is_control())
}

fn file_name_lower(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_shell_program(path: &Path) -> bool {
    matches!(
        file_name_lower(path).as_str(),
        "cmd"
            | "cmd.exe"
            | "command.com"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
            | "sh"
            | "bash"
            | "zsh"
            | "wsl"
            | "wsl.exe"
            | "start"
            | "start.exe"
    )
}

fn is_path_inside(candidate: &Path, parent: &Path) -> bool {
    let candidate = match fs::canonicalize(candidate) {
        Ok(path) => path,
        Err(_) => candidate.to_path_buf(),
    };
    let parent = match fs::canonicalize(parent) {
        Ok(path) => path,
        Err(_) => parent.to_path_buf(),
    };
    candidate == parent || candidate.starts_with(&parent)
}

fn display_command(program: &Path, args: &[String]) -> String {
    std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().map(|arg| {
            if arg.chars().any(char::is_whitespace) {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ")
}

fn detected_url_for_plan(plan: &LocalLaunchPlan) -> Option<String> {
    (plan.kind == "static").then(|| format!("http://127.0.0.1:{STATIC_PREVIEW_PORT}"))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::Manager;

    fn temp_workspace() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("codex-local-test-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&path).expect("workspace");
        path
    }

    fn plan(program: &str, cwd: &str, args: &[&str]) -> LocalLaunchPlan {
        LocalLaunchPlan {
            kind: "manifest".into(),
            program: program.into(),
            args: args.iter().map(|value| (*value).into()).collect(),
            cwd: cwd.into(),
            entrypoint: "codex-corp.launch.json".into(),
            display_command: program.into(),
            script: None,
        }
    }

    #[test]
    fn package_scripts_have_deterministic_safe_priority() {
        let workspace = temp_workspace();
        fs::write(
            workspace.join("package.json"),
            r#"{"scripts":{"serve":"server","preview":"preview","dev":"dev"}}"#,
        )
        .expect("package fixture");
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(workspace.join("package.json")).unwrap(),
            )
            .unwrap()["scripts"]["dev"],
            "dev"
        );
        let launch = discover_launch_plan(&workspace).expect("package launch plan");
        assert_eq!(launch.entrypoint, "package.json#scripts.dev");
        assert_eq!(launch.script.as_deref(), Some("dev"));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn static_launch_plans_expose_the_local_preview_url() {
        let static_plan = LocalLaunchPlan {
            kind: "static".into(),
            program: "python".into(),
            args: Vec::new(),
            cwd: "/workspace".into(),
            entrypoint: "index.html".into(),
            display_command: "python -m http.server".into(),
            script: None,
        };
        let package_plan = LocalLaunchPlan {
            kind: "package-script".into(),
            ..static_plan.clone()
        };
        assert_eq!(
            detected_url_for_plan(&static_plan).as_deref(),
            Some("http://127.0.0.1:4173")
        );
        assert_eq!(detected_url_for_plan(&package_plan), None);
    }

    #[test]
    fn verified_bundle_runs_locally_and_persists_operator_feedback() {
        let workspace = temp_workspace();
        fs::write(
            workspace.join("index.html"),
            "<!doctype html><title>Local test fixture</title>",
        )
        .expect("static fixture");
        let endpoint = ("127.0.0.1", STATIC_PREVIEW_PORT);
        if TcpStream::connect(endpoint).is_ok() {
            panic!("local test fixture port {STATIC_PREVIEW_PORT} is already occupied");
        }
        assert!(
            resolve_runtime("python").is_ok(),
            "Python is required for the static local-test fixture"
        );

        let connection = Connection::open_in_memory().expect("database");
        crate::initialize_database(&connection).expect("database schema");
        let nodes_json = serde_json::json!([
            {"id": "bundle", "data": {"kind": "output", "label": "Release Bundle"}}
        ])
        .to_string();
        let output_json = serde_json::json!({
            "data": {"schemaVersion": "codex-corp.delivery.v3", "status": "success"}
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO runs(id,workflow_id,status,events_json,nodes_json,workspace_path) VALUES(?1,?2,'completed','[]',?3,?4)",
                params![
                    "run-e2e",
                    "workflow-e2e",
                    nodes_json,
                    workspace.to_string_lossy().to_string()
                ],
            )
            .expect("completed run");
        connection
            .execute(
                "INSERT INTO node_executions(id,run_id,node_id,status,output_json) VALUES(?1,?2,?3,'success',?4)",
                params!["run-e2e:bundle", "run-e2e", "bundle", output_json],
            )
            .expect("delivery execution");

        let database = Database(Arc::new(Mutex::new(connection)));
        let app = tauri::test::mock_builder()
            .manage(database)
            .manage(LocalTestProcessRegistry::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app");

        let prepared = prepare_local_test(
            "workflow-e2e".into(),
            "run-e2e".into(),
            app.state::<Database>(),
        )
        .expect("prepare local test");
        assert_eq!(prepared.status, "launch_pending");
        assert_eq!(
            prepared.detected_url.as_deref(),
            Some("http://127.0.0.1:4173")
        );

        let running = approve_local_test_launch_with_app(
            prepared.id.clone(),
            true,
            app.handle(),
            app.state::<Database>().inner(),
            app.state::<LocalTestProcessRegistry>().inner(),
        )
        .expect("approve local launch");
        assert_eq!(running.status, "running");
        assert!(running.pid.is_some());

        let mut response = String::new();
        for _ in 0..80 {
            if let Ok(mut stream) = TcpStream::connect(endpoint) {
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .expect("read timeout");
                stream
                    .write_all(b"GET /index.html HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
                    .expect("HTTP request");
                let mut bytes = Vec::new();
                let _ = stream.read_to_end(&mut bytes);
                response = String::from_utf8_lossy(&bytes).into_owned();
                if response.contains("200 OK") {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(75));
        }
        assert!(
            response.contains("200 OK"),
            "local fixture response: {response}"
        );

        let changed = submit_local_test_feedback_with_app(
            prepared.id.clone(),
            false,
            "The local page needs a visible save confirmation.".into(),
            app.handle(),
            app.state::<Database>().inner(),
            app.state::<LocalTestProcessRegistry>().inner(),
        )
        .expect("submit operator feedback");
        assert_eq!(changed.status, "changes_requested");
        assert_eq!(changed.feedback.len(), 1);
        for _ in 0..40 {
            if !app
                .state::<LocalTestProcessRegistry>()
                .contains(&prepared.id)
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!app
            .state::<LocalTestProcessRegistry>()
            .contains(&prepared.id));

        let database = app.state::<Database>();
        let connection = database.0.lock().expect("database lock");
        let (status, feedback): (String, String) = connection
            .query_row(
                "SELECT status,feedback_json FROM local_test_sessions WHERE id=?1",
                params![prepared.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("persisted local test state");
        assert_eq!(status, "changes_requested");
        assert!(feedback.contains("visible save confirmation"));
        drop(connection);
        drop(app);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn package_script_launch_runs_the_real_script_and_stops_its_heartbeat() {
        let workspace = temp_workspace();
        let script = r#"node -e "const fs=require('fs'); setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),50)""#;
        fs::write(
            workspace.join("package.json"),
            serde_json::json!({"scripts": {"dev": script}}).to_string(),
        )
        .expect("package fixture");
        assert!(
            resolve_runtime("npm").is_ok(),
            "npm is required for the package-script local-test fixture"
        );

        let connection = Connection::open_in_memory().expect("database");
        crate::initialize_database(&connection).expect("database schema");
        let nodes_json = serde_json::json!([
            {"id": "bundle", "data": {"kind": "output", "label": "Release Bundle"}}
        ])
        .to_string();
        let output_json = serde_json::json!({
            "data": {"schemaVersion": "codex-corp.delivery.v3", "status": "success"}
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO runs(id,workflow_id,status,events_json,nodes_json,workspace_path) VALUES(?1,?2,'completed','[]',?3,?4)",
                params![
                    "run-package-e2e",
                    "workflow-package-e2e",
                    nodes_json,
                    workspace.to_string_lossy().to_string()
                ],
            )
            .expect("completed run");
        connection
            .execute(
                "INSERT INTO node_executions(id,run_id,node_id,status,output_json) VALUES(?1,?2,?3,'success',?4)",
                params![
                    "run-package-e2e:bundle",
                    "run-package-e2e",
                    "bundle",
                    output_json
                ],
            )
            .expect("delivery execution");

        let app = tauri::test::mock_builder()
            .manage(Database(Arc::new(Mutex::new(connection))))
            .manage(LocalTestProcessRegistry::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app");
        let prepared = prepare_local_test(
            "workflow-package-e2e".into(),
            "run-package-e2e".into(),
            app.state::<Database>(),
        )
        .expect("prepare package local test");
        assert_eq!(prepared.plan.kind, "package-script");
        assert_eq!(prepared.plan.script.as_deref(), Some(script));

        let running = approve_local_test_launch_with_app(
            prepared.id.clone(),
            true,
            app.handle(),
            app.state::<Database>().inner(),
            app.state::<LocalTestProcessRegistry>().inner(),
        )
        .expect("approve package launch");
        assert_eq!(running.status, "running");

        let heartbeat = workspace.join("heartbeat.txt");
        for _ in 0..100 {
            if heartbeat.is_file() {
                break;
            }
            thread::sleep(Duration::from_millis(75));
        }
        assert!(heartbeat.is_file(), "package script never started");
        thread::sleep(Duration::from_millis(200));
        let before_stop = fs::metadata(&heartbeat).expect("heartbeat metadata").len();

        let approved = submit_local_test_feedback_with_app(
            prepared.id.clone(),
            true,
            String::new(),
            app.handle(),
            app.state::<Database>().inner(),
            app.state::<LocalTestProcessRegistry>().inner(),
        )
        .expect("approve package local test");
        assert_eq!(approved.status, "approved");
        for _ in 0..60 {
            if !app
                .state::<LocalTestProcessRegistry>()
                .contains(&prepared.id)
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!app
            .state::<LocalTestProcessRegistry>()
            .contains(&prepared.id));
        thread::sleep(Duration::from_millis(300));
        let after_stop = fs::metadata(&heartbeat)
            .expect("stopped heartbeat metadata")
            .len();
        assert_eq!(
            after_stop, before_stop,
            "package child process kept running"
        );
        drop(app);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn launch_validation_rejects_shells_and_control_characters() {
        let workspace = Path::new(if cfg!(windows) {
            r"C:\workspace"
        } else {
            "/workspace"
        });
        assert!(validate_launch_plan(
            &plan("cmd.exe", &workspace.to_string_lossy(), &[]),
            workspace
        )
        .is_err());
        assert!(validate_launch_plan(
            &plan("game.exe", &workspace.to_string_lossy(), &["bad\0arg"]),
            workspace
        )
        .is_err());
    }

    #[test]
    fn launch_validation_rejects_malformed_package_script_details() {
        let workspace = Path::new(if cfg!(windows) {
            r"C:\workspace"
        } else {
            "/workspace"
        });
        let mut launch = plan("npm.cmd", &workspace.to_string_lossy(), &[]);
        launch.script = Some("x".repeat(MAX_ARG_LENGTH + 1));
        assert!(validate_launch_plan(&launch, workspace).is_err());
    }

    #[test]
    fn launch_validation_rejects_absolute_executables_outside_workspace() {
        let workspace = Path::new(if cfg!(windows) {
            r"C:\workspace"
        } else {
            "/workspace"
        });
        let outside = if cfg!(windows) {
            r"C:\Windows\System32\calc.exe"
        } else {
            "/usr/bin/other"
        };
        assert!(
            validate_launch_plan(&plan(outside, &workspace.to_string_lossy(), &[]), workspace)
                .is_err()
        );
    }

    #[test]
    fn manifest_path_traversal_is_rejected() {
        let workspace = temp_workspace();
        let outside = workspace.parent().unwrap().join("outside-test.exe");
        fs::write(&outside, "not an executable").expect("outside fixture");
        fs::write(
            workspace.join("codex-corp.launch.json"),
            format!(
                r#"{{"program":"{}"}}"#,
                outside.to_string_lossy().replace('\\', "/")
            ),
        )
        .expect("manifest fixture");
        assert!(
            discover_manifest_plan(&workspace, &workspace.join("codex-corp.launch.json")).is_err()
        );
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn feedback_is_bounded_and_deduplicated() {
        let mut feedback = Vec::new();
        for index in 0..10 {
            append_feedback(&mut feedback, format!("feedback {index}"));
        }
        append_feedback(&mut feedback, "feedback 9".into());
        assert_eq!(feedback.len(), MAX_FEEDBACK_ITEMS);
        assert_eq!(feedback.last().map(String::as_str), Some("feedback 9"));
        assert!(normalize_feedback(&"a ".repeat(3_000)).len() <= MAX_FEEDBACK_BYTES);
    }
}
