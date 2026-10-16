use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use pa_core::agent_traces::{
    agent_traces_log_path, preview_trace_file, resolve_traces_base_url, trace_credential,
    upload_all_traces, upload_trace_file, ReqwestTraceHttp, TracePreviewResult,
    TraceUploadAllOptions, TraceUploadAllProgress, TraceUploadOptions, TraceUploadResult,
    DEFAULT_REQUEST_TIMEOUT_MS,
};
use pa_core::auth::{
    check_prime_agent_traces_access, login_prime_agent_traces, AuthCredential,
    PrimeAgentTracesCallbacks, PrimeAgentTracesLoginOptions, PrimeAuthInfo, ReqwestPrimeHttp,
};
use pa_core::settings::SettingsManager;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{write_event, BridgeUi, LoginResult, PromptFuture, LOGIN_CANCELLED};

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Action {
    Status,
    On,
    Off,
    Preview,
    PreviewContent,
    Upload,
    UploadCurrent,
    UploadAll,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    action: Action,
    cwd: PathBuf,
    agent_dir: PathBuf,
    session_file: Option<PathBuf>,
    session_dir: Option<PathBuf>,
}

fn request() -> Result<Request> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!("Trace request is too large");
    }
    serde_json::from_slice(&bytes).context("Invalid trace request")
}

fn status(request: &Request) -> Result<Value> {
    let mut settings = SettingsManager::create(&request.cwd, &request.agent_dir);
    if !settings.errors().is_empty() {
        bail!("Engine trace settings could not be loaded");
    }
    let credential = trace_credential(&request.agent_dir).map(|credential| credential.label);
    if matches!(request.action, Action::On) && credential.is_none() {
        return Ok(json!({
            "status": "missing_credentials",
            "enabled": settings.get_agent_traces_enabled(),
            "credentialLabel": null
        }));
    }
    match request.action {
        Action::On => settings.set_agent_traces_enabled(true)?,
        Action::Off => settings.set_agent_traces_enabled(false)?,
        _ => {}
    }
    Ok(json!({
        "status": "ready",
        "enabled": settings.get_agent_traces_enabled(),
        "credentialLabel": credential,
        "logPath": agent_traces_log_path(&request.agent_dir)
    }))
}

fn upload_result(result: TraceUploadResult) -> Value {
    match result {
        TraceUploadResult::Uploaded { bytes_stored, .. } => json!({
            "status": "uploaded",
            "uploaded": 1,
            "bytesStored": bytes_stored
        }),
        TraceUploadResult::Disabled => json!({ "status": "disabled" }),
        TraceUploadResult::Unchanged => json!({ "status": "unchanged" }),
        TraceUploadResult::MissingCredentials => json!({ "status": "missing_credentials" }),
        TraceUploadResult::NoSessionFile => json!({ "status": "no_session_file" }),
        TraceUploadResult::EmptySession => json!({ "status": "empty_session" }),
        TraceUploadResult::InvalidSession { .. } => json!({
            "status": "invalid_session",
            "message": "The session does not contain a valid native trace."
        }),
        TraceUploadResult::TooLarge { size, max_bytes } => json!({
            "status": "too_large",
            "size": size,
            "maxBytes": max_bytes
        }),
        TraceUploadResult::Failed { status_code, .. } => json!({
            "status": "failed",
            "statusCode": status_code,
            "message": "The trace could not be uploaded. Check the Engine trace log."
        }),
    }
}

async fn preview(session_file: Option<&Path>) -> Value {
    match preview_trace_file(session_file, None, None).await {
        TracePreviewResult::Ready(data) => json!({
            "status": "ready",
            "preview": {
                "sessionFile": data.session_file,
                "sessionId": data.session_id,
                "traceId": data.trace_id,
                "parentSessionId": data.parent_session_id,
                "size": data.size,
                "maxBytes": data.max_bytes,
                "uploadable": data.uploadable,
                "endpoint": data.endpoint,
                "gitRepo": data.git_repo,
                "gitCommit": data.git_commit,
                "contentPreview": data.content_preview,
                "truncated": data.truncated
            }
        }),
        TracePreviewResult::NoSessionFile => json!({ "status": "no_session_file" }),
        TracePreviewResult::EmptySession => json!({ "status": "empty_session" }),
        TracePreviewResult::InvalidSession { .. } => json!({
            "status": "invalid_session",
            "message": "The session does not contain a valid native trace."
        }),
        TracePreviewResult::Failed { .. } => json!({
            "status": "failed",
            "message": "The session trace could not be read."
        }),
    }
}

pub(super) async fn run() -> Result<Value> {
    let request = request()?;
    if matches!(
        request.action,
        Action::Upload | Action::UploadCurrent | Action::UploadAll
    ) {
        let agent_dir = request.agent_dir.clone();
        let has_credential =
            tokio::task::spawn_blocking(move || trace_credential(&agent_dir).is_some()).await?;
        if !has_credential {
            return Ok(json!({ "status": "missing_credentials" }));
        }
    }
    match request.action {
        Action::Status | Action::Off => {
            tokio::task::spawn_blocking(move || status(&request)).await?
        }
        Action::On => {
            let settings_request = request.clone();
            let mut settings =
                tokio::task::spawn_blocking(move || status(&settings_request)).await??;
            if settings["status"] == "missing_credentials" {
                return Ok(settings);
            }
            let uploaded = upload(&request).await;
            if let Some(fields) = uploaded.as_object() {
                for (key, value) in fields {
                    settings[key] = value.clone();
                }
            }
            Ok(settings)
        }
        Action::Preview | Action::PreviewContent => {
            Ok(preview(request.session_file.as_deref()).await)
        }
        Action::Upload | Action::UploadCurrent => Ok(upload(&request).await),
        Action::UploadAll => {
            let (sender, mut receiver) =
                tokio::sync::mpsc::unbounded_channel::<TraceUploadAllProgress>();
            let forwarder = tokio::spawn(async move {
                while let Some(progress) = receiver.recv().await {
                    let _ = write_event(&json!({
                        "type": "progress",
                        "completed": progress.completed,
                        "total": progress.total
                    }));
                }
            });
            let result = upload_all_traces(&TraceUploadAllOptions {
                session_dir: request.session_dir.as_deref(),
                cwd: &request.cwd,
                agent_dir: &request.agent_dir,
                require_enabled: false,
                reload_config: false,
                base_url: None,
                http: &ReqwestTraceHttp,
                request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
                cancel: None,
                on_upload_delay: None,
                concurrency: None,
                progress: Some(sender),
            })
            .await;
            forwarder.abort();
            Ok(json!({
                "status": if result.failed > 0 { "failed" } else { "uploaded" },
                "total": result.total,
                "uploaded": result.uploaded,
                "failed": result.failed,
                "skipped": result.skipped,
                "bytesStored": result.bytes_stored,
                "logPath": agent_traces_log_path(&request.agent_dir)
            }))
        }
    }
}

async fn upload(request: &Request) -> Value {
    let result = upload_trace_file(&TraceUploadOptions {
        session_file: request.session_file.as_deref(),
        cwd: &request.cwd,
        agent_dir: &request.agent_dir,
        require_enabled: false,
        reload_config: false,
        base_url: None,
        http: &ReqwestTraceHttp,
        request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
        cancel: None,
        on_upload_delay: None,
    })
    .await;
    let mut result = upload_result(result);
    result["logPath"] = json!(agent_traces_log_path(&request.agent_dir));
    result
}

fn key_prompt(bridge: &BridgeUi, message: &str) -> PromptFuture {
    bridge.prompt(json!({ "type": "secret", "message": message }))
}

pub(super) async fn login(
    bridge: &BridgeUi,
    prime_cli_config_path: Option<&Path>,
    direct_key: bool,
) -> Result<LoginResult, String> {
    let options = PrimeAgentTracesLoginOptions::new(prime_cli_config_path);
    let (auth_started, mut auth_events) = tokio::sync::mpsc::unbounded_channel();
    let on_auth = |information: &PrimeAuthInfo| {
        bridge.auth(&information.url, Some(&information.instructions));
        let _ = auth_started.send(());
    };
    // Native progress may include remote failure text; only fixed UI text crosses the bridge.
    let on_progress = |_: &str| bridge.progress("Checking trace account access…");
    let callbacks = PrimeAgentTracesCallbacks {
        on_auth: &on_auth,
        on_progress: Some(&on_progress),
    };
    let native_login = login_prime_agent_traces(&ReqwestPrimeHttp, &options, &callbacks);
    tokio::pin!(native_login);
    let mut browser_running = !direct_key;
    let mut manual = direct_key.then(|| key_prompt(bridge, "Enter your Prime trace API key."));
    let api_key = loop {
        tokio::select! {
            result = &mut native_login, if browser_running => {
                match result {
                    Ok((api_key, _)) => break api_key,
                    Err(_) => {
                        browser_running = false;
                        bridge.progress("Browser sign-in is unavailable. You can enter an API key.");
                        if manual.is_none() {
                            manual = Some(key_prompt(bridge, "Enter a Prime API key to continue."));
                        }
                    }
                }
            }
            Some(()) = auth_events.recv(), if manual.is_none() => {
                manual = Some(key_prompt(
                    bridge,
                    "Complete sign-in in your browser, or enter a Prime API key.",
                ));
            }
            answer = async {
                manual.as_mut().expect("the key prompt is active").as_mut().await
            }, if manual.is_some() => {
                let api_key = answer.ok_or_else(|| LOGIN_CANCELLED.to_string())?;
                if api_key.trim().is_empty() {
                    manual = Some(key_prompt(bridge, "Enter a non-empty Prime API key."));
                    continue;
                }
                bridge.progress("Checking trace account access…");
                check_prime_agent_traces_access(
                    &ReqwestPrimeHttp,
                    &resolve_traces_base_url(None),
                    api_key.trim(),
                    DEFAULT_REQUEST_TIMEOUT_MS,
                ).await.map_err(|_| "The key could not be verified for trace access".to_string())?;
                break api_key.trim().to_string();
            }
        }
    };
    if bridge.cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    Ok(LoginResult {
        credential: AuthCredential::ApiKey {
            key: api_key,
            prime_team: None,
        },
        preserve_prime_team: false,
    })
}
