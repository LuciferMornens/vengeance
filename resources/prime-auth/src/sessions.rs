use std::io::{self, Read};
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use pa_core::session::manager::SessionManager;
use pa_daemon::session_store::SessionFile;
use serde::Deserialize;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

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
    }
}
