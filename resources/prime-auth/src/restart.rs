use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use pa_daemon::descriptor::{
    descriptor_dir, validate_descriptor, write_file_atomic, WorkerDescriptor,
};
use pa_daemon::lease::{get_process_start_id, is_process_alive};
use pa_types::daemon::{DurableDaemonCreateCommand, UpdateRoster, UPDATE_ROSTER_FORMAT_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const BACKUP_VERSION: u32 = 2;
const SUPERVISOR_CONFIG_FIELDS: &[&str] = &[
    "cwd",
    "sessionDir",
    "script",
    "provider",
    "model",
    "apiKey",
    "thinking",
    "rlmDepth",
    "rlmMaxDepth",
    "parentSessionPath",
    "models",
    "decisionChild",
    "childScript",
    "spawnedByRequestId",
    "systemPrompt",
    "appendSystemPrompt",
    "skills",
    "promptTemplates",
    "autonomous",
    "executionMode",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation: Operation,
    agent_dir: PathBuf,
    socket_path: PathBuf,
    native_agent_id: String,
    session_path: PathBuf,
    roster_path: PathBuf,
    backup_dir: PathBuf,
    #[serde(default)]
    config_patch: Map<String, Value>,
    #[serde(default)]
    resident_selections: BTreeMap<String, ResidentSelection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResidentSelection {
    session_path: PathBuf,
    provider: String,
    model: String,
    thinking: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Inspect,
    Workers,
    Capture,
    Patch,
    Rollback,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    version: u32,
    agent_dir: PathBuf,
    socket_path: PathBuf,
    native_agent_id: String,
    session_path: PathBuf,
    descriptor_path: PathBuf,
    roster_path: PathBuf,
    worker_id: String,
    workers: Vec<WorkerBackup>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBackup {
    path: PathBuf,
    file_name: String,
    journals: Vec<JournalBackup>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalBackup {
    path: PathBuf,
    file_name: Option<String>,
}

#[derive(Clone)]
struct WorkerFile {
    path: PathBuf,
    descriptor: WorkerDescriptor,
    text: String,
}

struct RestartFiles {
    descriptor_path: PathBuf,
    descriptor: WorkerDescriptor,
    descriptor_text: String,
    roster: UpdateRoster,
    roster_text: String,
    session_index: usize,
    worker_pids: Vec<u64>,
    workers: Vec<WorkerFile>,
}

pub fn error_message(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        let message = cause.to_string();
        if message.starts_with("unsupported worker descriptor version")
            || message == "The restart snapshot is incompatible or belongs to another daemon"
        {
            return "This engine's saved restart format is incompatible. Update the engine and retry.";
        }
        if message == "The durable worker descriptor was not uniquely identified"
            || message == "The restart snapshot does not uniquely identify this session"
        {
            return "The engine could not identify this saved session for restart. Reopen it and retry.";
        }
        if message.contains("belongs to another")
            || message.contains("identity does not match")
            || message.contains("changed after")
        {
            return "The saved engine state changed during restart. Refresh the session and retry.";
        }
        if message.starts_with("Unsupported restart configuration field or value")
            || message == "The native create configuration is invalid"
        {
            return "The requested launch configuration is not supported by this engine.";
        }
        if message == "Restart backup directory is already in use" {
            return "This restart backup is already in use. Start a fresh restart attempt.";
        }
        if message == "Restart patch failed and its backup could not be restored" {
            return "The engine configuration could not be restored. Its restart backup is available.";
        }
    }
    "The engine restart configuration could not be read or saved. Its session data was not edited."
}

pub fn run() -> Result<Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!("Restart configuration request is too large");
    }
    let request: Request = serde_json::from_slice(&bytes).context("Invalid restart request")?;
    if request.native_agent_id.is_empty()
        || !request.agent_dir.is_absolute()
        || !request.session_path.is_absolute()
        || !request.roster_path.is_absolute()
        || !request.backup_dir.is_absolute()
    {
        bail!("Restart requires an identified session and absolute state paths");
    }
    if matches!(request.operation, Operation::Rollback) {
        return rollback(&request);
    }
    if matches!(request.operation, Operation::Workers) {
        return Ok(json!({ "workerPids": worker_pids(&read_workers(&request)?)? }));
    }
    validate_patch(&request.config_patch)?;
    if matches!(request.operation, Operation::Patch)
        && request.backup_dir.join("manifest.json").exists()
    {
        rollback(&request)?;
    }
    let files = load_files(&request)?;
    validate_resident_selections(&request, &files)?;
    prepare_resident_updates(&request, &files)?;
    let result = json!({
        "descriptorPath": files.descriptor_path,
        "rosterPath": request.roster_path,
        "backupDir": request.backup_dir,
        "workerId": files.descriptor.worker_id,
        "updateId": files.roster.update_id,
        "workerPids": files.worker_pids,
    });
    if matches!(request.operation, Operation::Capture) {
        capture(&request, &files)?;
    } else if matches!(request.operation, Operation::Patch) {
        if !request.backup_dir.join("manifest.json").exists() {
            capture(&request, &files)?;
        }
        patch(&request, files)?;
    }
    Ok(result)
}

fn same_path(first: &Path, second: &Path) -> bool {
    let first = fs::canonicalize(first).unwrap_or_else(|_| first.to_path_buf());
    let second = fs::canonicalize(second).unwrap_or_else(|_| second.to_path_buf());
    if cfg!(windows) {
        first
            .to_string_lossy()
            .eq_ignore_ascii_case(&second.to_string_lossy())
    } else {
        first == second
    }
}

fn validate_identity(request: &Request, descriptor: &WorkerDescriptor) -> Result<()> {
    validate_descriptor(descriptor, &request.socket_path)?;
    if descriptor.root_active_session_id != request.native_agent_id
        || !descriptor
            .session_file
            .as_deref()
            .is_some_and(|path| same_path(Path::new(path), &request.session_path))
    {
        bail!("The durable worker belongs to another session");
    }
    Ok(())
}

fn validate_roster(request: &Request, roster: &UpdateRoster) -> Result<usize> {
    if roster.format_version != UPDATE_ROSTER_FORMAT_VERSION
        || !same_path(Path::new(&roster.socket_path), &request.socket_path)
        || roster.update_id.0.is_empty()
    {
        bail!("The restart snapshot is incompatible or belongs to another daemon");
    }
    let matching: Vec<_> = roster
        .sessions
        .iter()
        .enumerate()
        .filter(|(_, session)| session.active_session_id == request.native_agent_id)
        .collect();
    if matching.len() != 1
        || !same_path(
            Path::new(&matching[0].1.session_file),
            &request.session_path,
        )
    {
        bail!("The restart snapshot does not uniquely identify this session");
    }
    Ok(matching[0].0)
}

fn read_workers(request: &Request) -> Result<Vec<WorkerFile>> {
    let directory = descriptor_dir(&request.agent_dir, &request.socket_path);
    let mut descriptors = Vec::new();
    let mut worker_ids = std::collections::BTreeSet::new();
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(descriptors),
        Err(error) => return Err(error.into()),
    };
    // A skipped descriptor could hide a live worker and make a failed-start rollback unsafe.
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path)?;
        let descriptor: WorkerDescriptor = serde_json::from_str(&text)
            .context("A worker descriptor could not be inspected safely")?;
        validate_descriptor(&descriptor, &request.socket_path)?;
        if path.file_stem().and_then(|name| name.to_str()) != Some(&descriptor.worker_id)
            || !worker_ids.insert(descriptor.worker_id.clone())
        {
            bail!("The durable worker path or identity is not unique");
        }
        descriptors.push(WorkerFile {
            path,
            descriptor,
            text,
        });
    }
    Ok(descriptors)
}

fn worker_owner_alive(descriptor: &WorkerDescriptor) -> Result<bool> {
    let pid = u32::try_from(descriptor.pid).context("The worker process identity is invalid")?;
    if !is_process_alive(pid)? {
        return Ok(false);
    }
    let expected = descriptor
        .process_start_id
        .as_deref()
        .context("The worker process start identity is unavailable")?;
    let current = get_process_start_id(pid)
        .context("The worker process start identity could not be verified")?;
    let (kind, recorded) = expected
        .split_once(':')
        .context("The worker process start identity is invalid")?;
    if !current.starts_with(&format!("{kind}:"))
        || recorded.is_empty()
        || !matches!(kind, "win" | "proc" | "ps")
        || (matches!(kind, "win" | "proc")
            && !recorded.bytes().all(|character| character.is_ascii_digit()))
    {
        bail!("The worker process start identity cannot be compared safely");
    }
    Ok(expected == current)
}

fn worker_pids(workers: &[WorkerFile]) -> Result<Vec<u64>> {
    let mut pids = Vec::new();
    for worker in workers {
        if worker_owner_alive(&worker.descriptor)? {
            pids.push(worker.descriptor.pid);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

fn load_files(request: &Request) -> Result<RestartFiles> {
    let workers = read_workers(request)?;
    let mut matching: Vec<_> = workers
        .iter()
        .filter(|worker| worker.descriptor.root_active_session_id == request.native_agent_id)
        .collect();
    if matching.len() != 1 {
        bail!("The durable worker descriptor was not uniquely identified");
    }
    let worker = matching.pop().context("Missing worker descriptor")?;
    let descriptor_path = worker.path.clone();
    let descriptor_text = worker.text.clone();
    let descriptor = worker.descriptor.clone();
    validate_identity(request, &descriptor)?;
    let roster_text = fs::read_to_string(&request.roster_path)?;
    let roster: UpdateRoster = serde_json::from_str(&roster_text)?;
    let session_index = validate_roster(request, &roster)?;
    if !roster.workers.iter().any(|worker| {
        worker.worker_id == descriptor.worker_id
            && worker
                .sessions
                .contains(&roster.sessions[session_index].session_id)
    }) {
        bail!("The restart snapshot does not match this worker's durable identity");
    }
    Ok(RestartFiles {
        descriptor_path,
        descriptor,
        descriptor_text,
        roster,
        roster_text,
        session_index,
        worker_pids: worker_pids(&workers)?,
        workers,
    })
}

fn validate_patch(patch: &Map<String, Value>) -> Result<()> {
    for (key, value) in patch {
        let valid = match key.as_str() {
            "provider" | "model" | "thinking" | "systemPrompt" | "executionMode" => {
                value.is_null() || value.is_string()
            }
            "appendSystemPrompt" | "skills" | "promptTemplates" | "models" => {
                value.is_null()
                    || value
                        .as_array()
                        .is_some_and(|items| items.iter().all(Value::is_string))
            }
            "autonomous" => value.is_null() || value.is_object(),
            _ => false,
        };
        if !valid {
            bail!("Unsupported restart configuration field or value: {key}");
        }
    }
    Ok(())
}

fn patch_create(create: &mut DurableDaemonCreateCommand, patch: &Map<String, Value>) -> Result<()> {
    if let Some(config) = create.rest.get_mut("config") {
        let config = config
            .as_object_mut()
            .context("The native create configuration is invalid")?;
        apply_fields(config, patch);
    }
    apply_fields(&mut create.rest, patch);
    Ok(())
}

fn apply_fields(target: &mut Map<String, Value>, patch: &Map<String, Value>) {
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn supervisor_config(create: &DurableDaemonCreateCommand) -> Map<String, Value> {
    let mut config = create
        .rest
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in SUPERVISOR_CONFIG_FIELDS {
        if let Some(value) = create.rest.get(*key) {
            config.insert((*key).to_string(), value.clone());
        }
    }
    config
}

fn validate_resident_selections(request: &Request, files: &RestartFiles) -> Result<()> {
    if request.resident_selections.len() != files.roster.sessions.len() {
        bail!("The live selections do not identify every restart resident");
    }
    let mut identities = std::collections::BTreeSet::new();
    for session in &files.roster.sessions {
        if !identities.insert(&session.active_session_id) {
            bail!("The restart snapshot contains duplicate resident identities");
        }
        let selection = request
            .resident_selections
            .get(&session.active_session_id)
            .context("A restart resident has no captured live selection")?;
        let workers: Vec<_> = files
            .workers
            .iter()
            .filter(|worker| worker.descriptor.root_active_session_id == session.active_session_id)
            .collect();
        if workers.len() != 1
            || !workers[0]
                .descriptor
                .session_file
                .as_deref()
                .is_some_and(|path| same_path(Path::new(path), Path::new(&session.session_file)))
            || !selection.session_path.is_absolute()
            || !same_path(&selection.session_path, Path::new(&session.session_file))
            || selection.provider.trim().is_empty()
            || selection.model.trim().is_empty()
            || !matches!(
                selection.thinking.as_str(),
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
            || !files.roster.workers.iter().any(|worker| {
                worker.worker_id == workers[0].descriptor.worker_id
                    && worker.sessions.contains(&session.session_id)
            })
        {
            bail!("A captured live selection does not match its restart resident");
        }
    }
    for worker in &files.workers {
        if !identities.contains(&worker.descriptor.root_active_session_id)
            && (worker
                .descriptor
                .stop_requested_at
                .as_deref()
                .is_none_or(|timestamp| timestamp.trim().is_empty())
                || worker_owner_alive(&worker.descriptor)?)
        {
            bail!("A worker outside the restart snapshot has not completed its stop");
        }
    }
    Ok(())
}

fn patch_create_value(create: &mut Value, patch: &Map<String, Value>) -> Result<()> {
    let mut typed: DurableDaemonCreateCommand = serde_json::from_value(create.clone())?;
    patch_create(&mut typed, patch)?;
    let raw = create
        .as_object_mut()
        .context("Missing native create configuration")?;
    apply_fields(raw, patch);
    // Workers replay flat fields; supervisor fallback creation consumes nested config.
    raw.insert(
        "config".to_string(),
        Value::Object(supervisor_config(&typed)),
    );
    Ok(())
}

fn prepare_resident_updates(
    request: &Request,
    files: &RestartFiles,
) -> Result<(Vec<(PathBuf, String)>, String)> {
    let mut roster_value: Value = serde_json::from_str(&files.roster_text)?;
    let mut updates = Vec::new();
    for (index, session) in files.roster.sessions.iter().enumerate() {
        let selection = request
            .resident_selections
            .get(&session.active_session_id)
            .context("A restart resident has no captured live selection")?;
        let mut patch = Map::from_iter([
            ("provider".to_string(), json!(selection.provider)),
            ("model".to_string(), json!(selection.model)),
            ("thinking".to_string(), json!(selection.thinking)),
        ]);
        if index == files.session_index {
            patch.extend(request.config_patch.clone());
        }
        let worker = files
            .workers
            .iter()
            .find(|worker| worker.descriptor.root_active_session_id == session.active_session_id)
            .context("Missing resident worker descriptor")?;
        let mut descriptor_value: Value = serde_json::from_str(&worker.text)?;
        // Edit raw envelopes so future queue, journal, and configuration fields survive.
        patch_create_value(&mut descriptor_value["createCommand"], &patch)?;
        patch_create_value(
            &mut roster_value["sessions"][index]["runtime_config"]["create"],
            &patch,
        )?;
        updates.push((
            worker.path.clone(),
            serde_json::to_string_pretty(&descriptor_value)?,
        ));
    }
    Ok((updates, serde_json::to_string_pretty(&roster_value)?))
}

fn patch(request: &Request, files: RestartFiles) -> Result<()> {
    let (updates, roster_next) = prepare_resident_updates(request, &files)?;
    let updated = (|| {
        for (path, text) in &updates {
            write_file_atomic(path, text)?;
        }
        write_file_atomic(&request.roster_path, &roster_next)
    })();
    if let Err(error) = updated {
        rollback(request).context("Restart patch failed and its backup could not be restored")?;
        return Err(error);
    }
    Ok(())
}

fn capture(request: &Request, files: &RestartFiles) -> Result<()> {
    fs::create_dir_all(&request.backup_dir)?;
    let backup_root = fs::canonicalize(&request.backup_dir)?;
    let descriptor_root =
        fs::canonicalize(descriptor_dir(&request.agent_dir, &request.socket_path))?;
    if backup_root.starts_with(&descriptor_root)
        || same_path(
            &request.backup_dir.join("roster.json"),
            &request.roster_path,
        )
    {
        bail!("Restart backups must be outside the native worker directory");
    }
    if fs::read_dir(&request.backup_dir)?.next().is_some() {
        bail!("Restart backup directory is already in use");
    }
    let mut workers = Vec::new();
    for (index, worker) in files.workers.iter().enumerate() {
        let file_name = format!("worker-{index}.json");
        write_file_atomic(&request.backup_dir.join(&file_name), &worker.text)?;
        let mut journals = Vec::new();
        for (journal_index, path) in journal_paths(&worker.descriptor).iter().enumerate() {
            match fs::metadata(path) {
                Ok(metadata) if metadata.is_file() => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    journals.push(JournalBackup {
                        path: path.clone(),
                        file_name: None,
                    });
                    continue;
                }
                _ => bail!("A worker recovery journal could not be captured safely"),
            }
            let file_name = format!("worker-{index}-journal-{journal_index}.backup");
            copy_atomic(path, &request.backup_dir.join(&file_name))?;
            journals.push(JournalBackup {
                path: path.clone(),
                file_name: Some(file_name),
            });
        }
        workers.push(WorkerBackup {
            path: worker.path.clone(),
            file_name,
            journals,
        });
    }
    let manifest = BackupManifest {
        version: BACKUP_VERSION,
        agent_dir: request.agent_dir.clone(),
        socket_path: request.socket_path.clone(),
        native_agent_id: request.native_agent_id.clone(),
        session_path: request.session_path.clone(),
        descriptor_path: files.descriptor_path.clone(),
        roster_path: request.roster_path.clone(),
        worker_id: files.descriptor.worker_id.clone(),
        workers,
    };
    write_file_atomic(
        &request.backup_dir.join("descriptor.json"),
        &files.descriptor_text,
    )?;
    write_file_atomic(&request.backup_dir.join("roster.json"), &files.roster_text)?;
    write_file_atomic(
        &request.backup_dir.join("manifest.json"),
        &serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}

fn journal_paths(descriptor: &WorkerDescriptor) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from(&descriptor.recovery_journal_path)];
    if let Some(path) = &descriptor.orphan_process_journal_path {
        paths.push(PathBuf::from(path));
    }
    paths
}

fn copy_atomic(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .context("Missing backup destination directory")?;
    fs::create_dir_all(parent)?;
    let temporary = destination.with_extension(format!("restart-{}.tmp", std::process::id()));
    let copied = (|| -> Result<()> {
        fs::copy(source, &temporary)?;
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)?
            .sync_all()?;
        pa_core::platform::perms::restrict_file(&temporary)?;
        pa_core::platform::rename_onto(&temporary, destination)?;
        Ok(())
    })();
    if copied.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copied
}

fn rollback(request: &Request) -> Result<Value> {
    let manifest: BackupManifest = serde_json::from_str(&fs::read_to_string(
        request.backup_dir.join("manifest.json"),
    )?)?;
    if manifest.version != BACKUP_VERSION
        || !same_path(&manifest.agent_dir, &request.agent_dir)
        || !same_path(&manifest.socket_path, &request.socket_path)
        || manifest.native_agent_id != request.native_agent_id
        || !same_path(&manifest.session_path, &request.session_path)
        || !same_path(&manifest.roster_path, &request.roster_path)
        || !manifest.descriptor_path.parent().is_some_and(|parent| {
            same_path(
                parent,
                &descriptor_dir(&request.agent_dir, &request.socket_path),
            )
        })
    {
        bail!("Restart backup identity does not match the requested session");
    }
    let descriptor_text = fs::read_to_string(request.backup_dir.join("descriptor.json"))?;
    let descriptor: WorkerDescriptor = serde_json::from_str(&descriptor_text)?;
    validate_identity(request, &descriptor)?;
    if descriptor.worker_id != manifest.worker_id {
        bail!("Restart backup belongs to another worker");
    }
    if manifest.descriptor_path.exists() {
        let current: WorkerDescriptor =
            serde_json::from_str(&fs::read_to_string(&manifest.descriptor_path)?)?;
        validate_identity(request, &current)?;
        if current.worker_id != descriptor.worker_id {
            bail!("The worker changed after this restart backup was created");
        }
    }
    let roster_text = fs::read_to_string(request.backup_dir.join("roster.json"))?;
    let roster: UpdateRoster = serde_json::from_str(&roster_text)?;
    validate_roster(request, &roster)?;
    if manifest.roster_path.exists() {
        let current: UpdateRoster =
            serde_json::from_str(&fs::read_to_string(&manifest.roster_path)?)?;
        validate_roster(request, &current)?;
        if current.update_id != roster.update_id {
            bail!("The restart snapshot changed after this backup was created");
        }
    }
    let directory = descriptor_dir(&request.agent_dir, &request.socket_path);
    let mut restored = Vec::new();
    for worker in &manifest.workers {
        if !worker
            .path
            .parent()
            .is_some_and(|parent| same_path(parent, &directory))
            || Path::new(&worker.file_name).components().count() != 1
        {
            bail!("Restart backup contains an invalid worker path");
        }
        let text = fs::read_to_string(request.backup_dir.join(&worker.file_name))?;
        let descriptor: WorkerDescriptor = serde_json::from_str(&text)?;
        validate_descriptor(&descriptor, &request.socket_path)?;
        if worker.path.file_stem().and_then(|name| name.to_str()) != Some(&descriptor.worker_id) {
            bail!("Restart backup belongs to another worker");
        }
        for journal in &worker.journals {
            if !journal_paths(&descriptor)
                .iter()
                .any(|path| same_path(path, &journal.path))
            {
                bail!("Restart backup contains an invalid recovery journal");
            }
            if let Some(file_name) = &journal.file_name {
                if Path::new(file_name).components().count() != 1
                    || !request.backup_dir.join(file_name).is_file()
                {
                    bail!("Restart backup contains an invalid recovery journal");
                }
            }
        }
        restored.push(WorkerFile {
            path: worker.path.clone(),
            descriptor,
            text,
        });
    }
    if !restored.iter().any(|worker| {
        same_path(&worker.path, &manifest.descriptor_path) && worker.text == descriptor_text
    }) {
        bail!("Restart backup is missing the selected worker");
    }
    for current in read_workers(request)? {
        let captured = restored
            .iter()
            .find(|worker| same_path(&worker.path, &current.path))
            .context("An unexpected worker appeared after this restart backup was created")?;
        if captured.descriptor.worker_id != current.descriptor.worker_id
            || captured.descriptor.root_active_session_id
                != current.descriptor.root_active_session_id
            || captured.descriptor.session_file != current.descriptor.session_file
        {
            bail!("The worker changed after this restart backup was created");
        }
    }
    // Native terminal cleanup can remove both descriptors and queues; replay their exact snapshots.
    for worker in &manifest.workers {
        for journal in &worker.journals {
            if let Some(file_name) = &journal.file_name {
                copy_atomic(&request.backup_dir.join(file_name), &journal.path)?;
            } else {
                match fs::remove_file(&journal.path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    for worker in restored {
        write_file_atomic(&worker.path, &worker.text)?;
    }
    write_file_atomic(&manifest.roster_path, &roster_text)?;
    Ok(json!({ "restored": true }))
}
