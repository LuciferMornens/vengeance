use std::collections::{HashMap, HashSet};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};
use pa_daemon::lease::{acquire_runtime_session_lease, canonical_session_path};
use pa_daemon::rlm_ledger::{RlmLedgerDeleteReason, RlmLedgerEdge, RlmSpawnLedger};
use pa_daemon::session_store::read_session_header_bounded;
use pa_types::session::SessionHeader;
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_SESSION_DIRECTORIES: usize = 256;
const MAX_LINEAGE_SESSIONS: usize = 8192;
const ARTIFACT_DIRECTORY: &str = "session-artifacts";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    agent_dir: PathBuf,
    session_dirs: Vec<PathBuf>,
}

struct SessionPaths {
    roots: Vec<PathBuf>,
    artifacts: Option<PathBuf>,
}

impl SessionPaths {
    fn new(agent_dir: &Path, roots: &[PathBuf]) -> Self {
        Self {
            roots: roots
                .iter()
                .filter_map(|path| std::fs::canonicalize(path).ok())
                .collect(),
            artifacts: std::fs::canonicalize(agent_dir.join(ARTIFACT_DIRECTORY)).ok(),
        }
    }

    fn supported(&self, path: &Path) -> Option<PathBuf> {
        let canonical = std::fs::canonicalize(path).ok()?;
        if !canonical.is_file()
            || !canonical
                .extension()?
                .to_string_lossy()
                .eq_ignore_ascii_case("jsonl")
        {
            return None;
        }
        self.supported_location(&canonical)
    }

    fn supported_location(&self, path: &Path) -> Option<PathBuf> {
        let canonical = canonical_session_path(path);
        if self
            .roots
            .iter()
            .any(|root| canonical.parent() == Some(root.as_path()))
        {
            return Some(canonical);
        }
        let relative = canonical.strip_prefix(self.artifacts.as_ref()?).ok()?;
        let components: Vec<_> = relative.components().collect();
        match components.as_slice() {
            [Component::Normal(_), Component::Normal(child), Component::Normal(_)]
                if child.to_string_lossy().starts_with("sub-") =>
            {
                Some(canonical)
            }
            _ => None,
        }
    }
}

fn session_identifier_valid(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier != "."
        && identifier != ".."
        && !identifier.contains(['/', '\\', ':'])
}

fn child_row(
    paths: &SessionPaths,
    edge: RlmLedgerEdge,
    parent_headers: &mut HashMap<PathBuf, Option<SessionHeader>>,
) -> Option<Value> {
    if edge.child_id.is_empty() {
        return None;
    }
    let path = paths.supported(Path::new(&edge.child))?;
    let header = read_session_header_bounded(&path)?;
    if !session_identifier_valid(&header.id) || path.file_stem()?.to_string_lossy() != header.id {
        return None;
    }
    let parent = paths.supported(Path::new(&edge.parent));
    let parent_id = parent.as_ref().and_then(|path| {
        parent_headers
            .entry(path.clone())
            .or_insert_with(|| read_session_header_bounded(path))
            .as_ref()
            .map(|header| header.id.clone())
    });
    let parent_path = parent.or_else(|| paths.supported_location(Path::new(&edge.parent)));
    Some(json!({
        "path": path,
        "name": edge.name,
        "lineage": {
            "parentSessionPath": parent_path,
            "parentSessionId": parent_id,
            "depth": edge.depth,
            "childId": edge.child_id,
            "runtimeKind": "subagent"
        }
    }))
}

fn list(request: Request) -> Result<Value> {
    if !request.agent_dir.is_absolute()
        || request.session_dirs.iter().any(|path| !path.is_absolute())
    {
        bail!("Invalid Engine 2 session directories");
    }
    let paths = SessionPaths::new(&request.agent_dir, &request.session_dirs);
    let mut sessions = HashMap::new();
    let mut excluded_paths = HashSet::new();
    let mut parent_headers = HashMap::new();
    let mut visited_ledgers = HashSet::new();
    let mut incomplete = request.session_dirs.len() > MAX_SESSION_DIRECTORIES;
    for directory in request.session_dirs.iter().take(MAX_SESSION_DIRECTORIES) {
        let ledger = RlmSpawnLedger::read_only(&request.agent_dir, directory, |_| {});
        if !visited_ledgers.insert(ledger.ledger_path().to_path_buf()) {
            continue;
        }
        let edges = match ledger.edges_with_resolved_paths(true) {
            Ok(edges) => edges,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        for edge in edges {
            if edge.deleted.is_some() {
                if let Some(path) = paths.supported(Path::new(&edge.child)) {
                    excluded_paths.insert(path);
                }
                continue;
            }
            if sessions.len() >= MAX_LINEAGE_SESSIONS {
                incomplete = true;
                continue;
            }
            if let Some(row) = child_row(&paths, edge, &mut parent_headers) {
                let path = row["path"].as_str().unwrap_or_default().to_string();
                sessions.insert(path, row);
            }
        }
    }
    let mut sessions: Vec<_> = sessions.into_values().collect();
    sessions.sort_by(|first, second| first["path"].as_str().cmp(&second["path"].as_str()));
    Ok(json!({
        "sessions": sessions,
        "excludedPaths": excluded_paths,
        "warning": incomplete.then_some(
            "Some saved child sessions could not be listed within Engine 2's discovery limits."
        )
    }))
}

pub fn run() -> Result<Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!("Engine 2 session discovery request is too large");
    }
    list(serde_json::from_slice(&bytes)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRequest {
    agent_dir: PathBuf,
    session_dirs: Vec<PathBuf>,
    path: PathBuf,
    parent_path: PathBuf,
    session_id: String,
    child_id: String,
    recovery_path: PathBuf,
}

fn delete(request: DeleteRequest) -> Result<Value> {
    if !request.agent_dir.is_absolute()
        || !request.path.is_absolute()
        || !request.parent_path.is_absolute()
        || !request.recovery_path.is_absolute()
        || request.child_id.is_empty()
        || request.session_dirs.len() > MAX_SESSION_DIRECTORIES
        || request.session_dirs.iter().any(|path| !path.is_absolute())
    {
        bail!("Invalid Engine 2 child deletion request");
    }
    let paths = SessionPaths::new(&request.agent_dir, &request.session_dirs);
    let path = paths
        .supported(&request.path)
        .ok_or_else(|| anyhow::anyhow!("The child session path is unsupported"))?;
    let parent = canonical_session_path(&request.parent_path);
    if path == parent
        || paths.supported_location(&parent).is_none()
        || request.recovery_path.exists()
    {
        bail!("Invalid Engine 2 deletion recovery location");
    }
    let _parent_lease = acquire_runtime_session_lease(&parent, &request.agent_dir)?;
    let _child_lease = acquire_runtime_session_lease(&path, &request.agent_dir)?;
    let header = read_session_header_bounded(&path)
        .ok_or_else(|| anyhow::anyhow!("The child session header is unreadable"))?;
    if header.id != request.session_id {
        bail!("The child session identity changed");
    }
    let mut matches = Vec::new();
    let mut visited_ledgers = HashSet::new();
    for directory in &request.session_dirs {
        let ledger = RlmSpawnLedger::read_only(&request.agent_dir, directory, |_| {});
        if !visited_ledgers.insert(ledger.ledger_path().to_path_buf()) {
            continue;
        }
        let matching = ledger
            .edges_with_resolved_paths(false)?
            .into_iter()
            .filter(|edge| {
                edge.child_id == request.child_id
                    && canonical_session_path(Path::new(&edge.child)) == path
                    && canonical_session_path(Path::new(&edge.parent)) == parent
            })
            .count();
        if matching == 0 {
            continue;
        }
        let recorded: Vec<_> = ledger
            .edges(false)?
            .into_iter()
            .filter(|edge| edge.child_id == request.child_id)
            .collect();
        if matching != 1 || recorded.len() != 1 {
            bail!("The native child identity is ambiguous");
        }
        matches.push((ledger, recorded[0].clone()));
    }
    if matches.len() != 1 {
        bail!("The native child identity could not be verified");
    }
    let (ledger, edge) = matches.pop().expect("one verified ledger edge");
    let usage = pa_daemon::session_usage::read_own_usage_summary(&path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut recovery = options.open(&request.recovery_path)?;
    io::copy(&mut std::fs::File::open(&path)?, &mut recovery)?;
    recovery.sync_all()?;
    drop(recovery);
    std::fs::remove_file(&path)?;
    match usage.as_ref() {
        Some(usage) => ledger.append_delete_with_usage(
            &edge.child_id,
            &edge.child,
            RlmLedgerDeleteReason::User,
            usage,
        )?,
        None => ledger.append_delete(&edge.child_id, &edge.child, RlmLedgerDeleteReason::User)?,
    }
    Ok(json!({ "path": request.recovery_path }))
}

pub fn run_delete() -> Result<Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!("Engine 2 session deletion request is too large");
    }
    delete(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_daemon::rlm_ledger::RlmSpawnInput;

    struct Fixture {
        root: PathBuf,
        sessions: PathBuf,
        parent: PathBuf,
        child: PathBuf,
    }

    impl Fixture {
        fn create() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("vengeance-lineage-{}-{unique}", std::process::id()));
            let sessions = root.join("sessions");
            let parent = sessions.join("parent.jsonl");
            let child = root.join("session-artifacts/parent/sub-child/child.jsonl");
            let fixture = Self {
                root,
                sessions,
                parent,
                child,
            };
            fixture.write_session(&fixture.parent, "parent");
            fixture.write_session(&fixture.child, "child");
            fixture
                .ledger()
                .append_spawn(&RlmSpawnInput {
                    child_id: "sub-child".into(),
                    parent: fixture.parent.to_string_lossy().into(),
                    child: fixture.child.to_string_lossy().into(),
                    depth: 1,
                    name: "Saved child".into(),
                })
                .unwrap();
            fixture
        }

        fn write_session(&self, path: &Path, identifier: &str) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                path,
                format!(
                    "{}\n",
                    json!({
                        "type": "session", "version": 3, "id": identifier,
                        "timestamp": "2026-10-16T00:00:00Z", "cwd": self.root
                    })
                ),
            )
            .unwrap();
        }

        fn ledger(&self) -> RlmSpawnLedger {
            RlmSpawnLedger::new(&self.root, &self.sessions, |_| {})
        }

        fn request(&self) -> Request {
            Request {
                agent_dir: self.root.clone(),
                session_dirs: vec![self.sessions.clone()],
            }
        }

        fn delete_request(&self) -> DeleteRequest {
            DeleteRequest {
                agent_dir: self.root.clone(),
                session_dirs: vec![self.sessions.clone()],
                path: self.child.clone(),
                parent_path: self.parent.clone(),
                session_id: "child".into(),
                child_id: "sub-child".into(),
                recovery_path: self.root.join("recovered.jsonl"),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    struct SnapshotEntry {
        path: PathBuf,
        bytes: u64,
        digest: Option<u64>,
        modified: Option<std::time::SystemTime>,
    }

    fn account_snapshot(root: &Path) -> Vec<SnapshotEntry> {
        use std::hash::Hasher;
        const SNAPSHOT_BUFFER_BYTES: usize = 64 * 1024;
        let mut pending = vec![root.to_path_buf()];
        let mut files = Vec::new();
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let metadata = entry.metadata().unwrap();
                let digest = if metadata.is_dir() {
                    pending.push(entry.path());
                    None
                } else {
                    let mut file = std::fs::File::open(entry.path()).unwrap();
                    let mut digest = std::collections::hash_map::DefaultHasher::new();
                    let mut buffer = [0; SNAPSHOT_BUFFER_BYTES];
                    loop {
                        let count = file.read(&mut buffer).unwrap();
                        if count == 0 {
                            break;
                        }
                        digest.write(&buffer[..count]);
                    }
                    Some(digest.finish())
                };
                files.push(SnapshotEntry {
                    path: entry.path(),
                    bytes: metadata.len(),
                    digest,
                    modified: if metadata.is_file() {
                        metadata.modified().ok()
                    } else {
                        None
                    },
                });
            }
        }
        files.sort_by(|first, second| first.path.cmp(&second.path));
        files
    }

    #[test]
    fn listing_reads_only_headers_and_keeps_orphan_ledger_identity() {
        let fixture = Fixture::create();
        use std::io::{Seek, SeekFrom, Write};
        let mut child = std::fs::OpenOptions::new()
            .write(true)
            .open(&fixture.child)
            .unwrap();
        child.seek(SeekFrom::End(0)).unwrap();
        child.write_all(&[u8::MAX; 1024]).unwrap();
        let large_history_bytes = 32 * 1024 * 1024;
        child.set_len(large_history_bytes).unwrap();
        drop(child);
        std::fs::remove_file(&fixture.parent).unwrap();
        let before = std::fs::read(fixture.ledger().ledger_path()).unwrap();
        let account_before = account_snapshot(&fixture.root);
        let result = list(fixture.request()).unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(result["sessions"][0]["lineage"]["childId"], "sub-child");
        assert_eq!(result["sessions"][0]["lineage"]["depth"], 1);
        assert!(result["sessions"][0]["lineage"]["parentSessionPath"].is_string());
        assert_eq!(
            std::fs::read(fixture.ledger().ledger_path()).unwrap(),
            before
        );
        assert!(!fixture.child.with_extension("info-cache.json").exists());
        assert_eq!(account_snapshot(&fixture.root), account_before);
    }

    #[test]
    fn repeated_listing_of_many_large_children_does_not_create_native_caches() {
        let fixture = Fixture::create();
        let additional_children = 32;
        let history_bytes = 2 * 1024 * 1024;
        for index in 0..additional_children {
            let identifier = format!("child-{index}");
            let child_id = format!("sub-{index}");
            let path = fixture
                .root
                .join(ARTIFACT_DIRECTORY)
                .join("parent")
                .join(&child_id)
                .join(format!("{identifier}.jsonl"));
            fixture.write_session(&path, &identifier);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(history_bytes)
                .unwrap();
            fixture
                .ledger()
                .append_spawn(&RlmSpawnInput {
                    child_id,
                    parent: fixture.parent.to_string_lossy().into(),
                    child: path.to_string_lossy().into(),
                    depth: 1,
                    name: identifier,
                })
                .unwrap();
        }
        let account_before = account_snapshot(&fixture.root);
        let listing_passes = 2;
        for _ in 0..listing_passes {
            let result = list(fixture.request()).unwrap();
            assert_eq!(
                result["sessions"].as_array().unwrap().len(),
                additional_children + 1
            );
        }
        assert_eq!(account_snapshot(&fixture.root), account_before);
    }

    #[test]
    fn listing_does_not_seed_a_missing_ledger_from_legacy_registry() {
        let fixture = Fixture::create();
        std::fs::remove_file(fixture.ledger().ledger_path()).unwrap();
        let legacy = fixture
            .root
            .join("session-artifacts/parent/rlm-subagents.jsonl");
        std::fs::write(
            &legacy,
            serde_json::to_vec(&json!({
                "childId": "sub-child", "sessionFile": fixture.child,
                "rlmDepth": 1, "status": "completed"
            }))
            .unwrap(),
        )
        .unwrap();
        let account_before = account_snapshot(&fixture.root);
        assert!(list(fixture.request()).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(account_snapshot(&fixture.root), account_before);
    }

    #[test]
    fn listing_excludes_tombstones_by_path_and_rejects_unsupported_artifacts() {
        let fixture = Fixture::create();
        let external = fixture.root.join("arbitrary/other.jsonl");
        fixture.write_session(&external, "other");
        fixture
            .ledger()
            .append_spawn(&RlmSpawnInput {
                child_id: "sub-other".into(),
                parent: fixture.parent.to_string_lossy().into(),
                child: external.to_string_lossy().into(),
                depth: 1,
                name: "Unsupported".into(),
            })
            .unwrap();
        fixture
            .ledger()
            .append_delete(
                "sub-child",
                &fixture.child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
        fixture.write_session(&fixture.sessions.join("imported-copy.jsonl"), "child");
        let result = list(fixture.request()).unwrap();
        assert!(result["sessions"].as_array().unwrap().is_empty());
        assert_eq!(result["excludedPaths"].as_array().unwrap().len(), 1);
        assert!(result.get("excludedSessionIds").is_none());
    }

    #[test]
    fn deletion_refuses_a_live_parent_and_then_tombstones_with_recovery() {
        let fixture = Fixture::create();
        let lease = acquire_runtime_session_lease(&fixture.parent, &fixture.root).unwrap();
        assert!(delete(fixture.delete_request()).is_err());
        assert!(fixture.child.exists());
        assert!(!fixture.root.join("recovered.jsonl").exists());
        drop(lease);
        let result = delete(fixture.delete_request()).unwrap();
        assert!(!fixture.child.exists());
        assert_eq!(result["path"], json!(fixture.root.join("recovered.jsonl")));
        assert!(fixture.root.join("recovered.jsonl").is_file());
        assert!(fixture.ledger().edges(false).unwrap().is_empty());
    }

    #[test]
    fn orphan_deletion_uses_the_missing_parent_lease_identity_without_recreating_history() {
        let fixture = Fixture::create();
        std::fs::remove_file(&fixture.parent).unwrap();
        delete(fixture.delete_request()).unwrap();
        assert!(!fixture.parent.exists());
        assert!(!fixture.child.exists());
        assert!(fixture.root.join("recovered.jsonl").is_file());
        assert!(fixture.ledger().edges(false).unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn deletion_keeps_recovery_when_the_native_tombstone_cannot_be_written() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::create();
        const SHARE_READ: u32 = 1;
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ)
            .open(fixture.ledger().ledger_path())
            .unwrap();
        assert!(delete(fixture.delete_request()).is_err());
        assert!(fixture.root.join("recovered.jsonl").is_file());
    }
}
