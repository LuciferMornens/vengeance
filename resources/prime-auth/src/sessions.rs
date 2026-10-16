use std::collections::HashMap;
use std::io::{self, Read};
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use pa_core::session::manager::SessionManager;
use pa_daemon::session_store::SessionFile;
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_HISTORY_BYTES: u64 = 256 * 1024 * 1024;
const HISTORY_CUSTOM_TYPE: &str = "vengeance-engine-history";

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Request {
    Fork {
        path: PathBuf,
        cwd: PathBuf,
        #[serde(rename = "sessionDir")]
        session_dir: PathBuf,
    },
    Branch {
        path: PathBuf,
        #[serde(rename = "entryId")]
        entry_id: String,
        #[serde(rename = "sessionDir")]
        session_dir: PathBuf,
    },
    Handoff {
        #[serde(rename = "inputPath")]
        input_path: PathBuf,
        #[serde(rename = "sessionDir")]
        session_dir: PathBuf,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoffHistory {
    version: u32,
    cwd: String,
    name: Option<String>,
    source_engine: String,
    source_session_path: Option<String>,
    entries: Vec<HandoffEntry>,
}

#[derive(Deserialize)]
struct HandoffEntry {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    fields: Value,
}

fn write_handoff(input_path: PathBuf, session_dir: PathBuf) -> Result<PathBuf> {
    let metadata = std::fs::metadata(&input_path)?;
    if !metadata.is_file() || metadata.len() > MAX_HISTORY_BYTES {
        bail!("Engine transfer history must be a bounded regular file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(input_path)?
        .take(MAX_HISTORY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_HISTORY_BYTES {
        bail!("Engine transfer history is too large");
    }
    let history: HandoffHistory = serde_json::from_slice(&bytes)?;
    if history.version != 1 || !matches!(history.source_engine.as_str(), "pi" | "prime") {
        bail!("Unsupported engine transfer history");
    }
    let mut destination =
        SessionFile::create(&history.cwd, history.source_session_path.as_deref(), 0);
    destination.append_entry(
        "custom",
        json!({
            "customType": HISTORY_CUSTOM_TYPE,
            "data": {
                "sourceEngine": history.source_engine,
                "sourceSessionPath": history.source_session_path,
            },
        }),
    );
    let mut identifiers = HashMap::new();
    for entry in history.entries {
        if identifiers.contains_key(&entry.id) || !entry.fields.is_object() {
            bail!("Invalid engine transfer entry");
        }
        let mut fields = entry.fields;
        match entry.kind.as_str() {
            "message" => {
                let _: pa_types::session::AgentMessage =
                    serde_json::from_value(fields["message"].clone())
                        .context("Unsupported message in engine transfer")?;
            }
            "compaction" => {
                let first_kept = fields["firstKeptEntryId"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Missing compaction boundary"))?;
                let mapped = if first_kept == entry.id {
                    // A state-only anchor retains no earlier messages at this boundary.
                    destination.append_entry(
                        "custom",
                        json!({ "customType": HISTORY_CUSTOM_TYPE, "data": null }),
                    )
                } else {
                    identifiers
                        .get(first_kept)
                        .cloned()
                        .ok_or_else(|| anyhow!("Invalid compaction boundary"))?
                };
                fields["firstKeptEntryId"] = Value::String(mapped);
                let _: pa_types::session::CompactionEntry = serde_json::from_value(fields.clone())?;
            }
            "branch_summary" => {
                fields["fromId"] = destination
                    .leaf_id()
                    .map(|identifier| Value::String(identifier.to_string()))
                    .unwrap_or_else(|| Value::String("root".to_string()));
            }
            "custom_message" => {
                let _: pa_types::session::CustomMessageEntry =
                    serde_json::from_value(fields.clone())?;
            }
            "custom" => {}
            _ => bail!("Unsupported engine transfer entry type"),
        }
        let identifier = destination.append_entry(&entry.kind, fields);
        identifiers.insert(entry.id, identifier);
    }
    if let Some(name) = history.name {
        destination.append_session_info(&name);
    }
    std::fs::create_dir_all(&session_dir)?;
    let path = session_dir.join(pa_daemon::session_store::session_file_name(
        destination.session_id(),
    ));
    // Reserve the name before the native writer's atomic replacement.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    destination.set_path(path.clone());
    if let Err(error) = destination.rewrite() {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    let saved_count = SessionFile::open(&path).map(|saved| saved.entries().len());
    if !matches!(saved_count, Ok(count) if count == destination.entries().len()) {
        let _ = std::fs::remove_file(&path);
        bail!("The native engine did not save the complete transfer history");
    }
    Ok(path)
}

pub fn run() -> Result<PathBuf> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!("Session request is too large");
    }
    let request: Request = serde_json::from_slice(&bytes).context("Invalid session request")?;
    match request {
        Request::Fork {
            path,
            cwd,
            session_dir,
        } => {
            let forked = SessionManager::fork_from(&path, &cwd, &session_dir)
                .map_err(|error| anyhow!(error))?;
            forked
                .get_session_file()
                .map(std::path::Path::to_path_buf)
                .ok_or_else(|| anyhow!("Engine 2 did not create a forked session"))
        }
        Request::Branch {
            path,
            entry_id,
            session_dir,
        } => {
            if !path.is_file() {
                bail!("The source session is not a regular file");
            }
            // A read-only native store leaves a resident worker's append lease untouched.
            let source = SessionFile::open(&path)?;
            std::fs::create_dir_all(&session_dir)?;
            let forked = source.create_branched_file(&entry_id, &session_dir)?;
            Ok(forked.path)
        }
        Request::Handoff {
            input_path,
            session_dir,
        } => write_handoff(input_path, session_dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vengeance-native-handoff-{}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn handoff_creates_native_history_with_images_and_compaction_anchors() {
        let directory = TestDirectory::create();
        let input = directory.0.join("input.json");
        let session_dir = directory.0.join("sessions");
        let history = json!({
            "version": 1,
            "cwd": directory.0,
            "name": "Transferred history",
            "sourceEngine": "pi",
            "entries": [
                { "id": "user", "type": "message", "fields": {
                    "message": { "role": "user", "content": "Earlier conversation", "timestamp": 1 }
                }},
                { "id": "picture", "type": "message", "fields": {
                    "message": { "role": "user", "content": [
                        { "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" }
                    ], "timestamp": 2 }
                }},
                { "id": "compact", "type": "compaction", "fields": {
                    "summary": "Existing summary", "firstKeptEntryId": "picture", "tokensBefore": 30
                }}
            ]
        });
        std::fs::write(&input, serde_json::to_vec(&history).unwrap()).unwrap();
        let path = write_handoff(input, session_dir).unwrap();
        let saved = SessionFile::open(&path).unwrap();
        let image_entry = saved
            .entries()
            .iter()
            .find(|entry| entry.fields["message"]["content"].is_array())
            .unwrap();
        let compact = saved
            .entries()
            .iter()
            .find(|entry| entry.type_ == "compaction")
            .unwrap();
        assert_eq!(compact.fields["firstKeptEntryId"], image_entry.id);
        assert_eq!(
            image_entry.fields["message"]["content"][0]["data"],
            "aW1hZ2U="
        );
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("Earlier conversation"));
    }

    #[test]
    fn handoff_rejects_unsupported_messages_before_creating_a_destination() {
        let directory = TestDirectory::create();
        let input = directory.0.join("input.json");
        let session_dir = directory.0.join("sessions");
        let history = json!({
            "version": 1,
            "cwd": directory.0,
            "sourceEngine": "pi",
            "entries": [{ "id": "invalid", "type": "message", "fields": {
                "message": { "role": "system", "content": "Foreign system prompt" }
            }}]
        });
        std::fs::write(&input, serde_json::to_vec(&history).unwrap()).unwrap();
        assert!(write_handoff(input, session_dir.clone()).is_err());
        assert!(!session_dir.exists());
    }
}
