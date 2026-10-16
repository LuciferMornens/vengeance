mod lineage;
mod mcp;
mod prime_inference;
mod resources;
mod restart;
mod sessions;
mod traces;

use std::collections::HashMap;
use std::future::Future;
use std::io::{self, BufRead, Write};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use pa_ai::oauth::{
    login_anthropic, login_github_copilot, login_openai_codex, login_xai, CodexLoginUi,
    OAuthLoginUi, OAuthPrompt, ReqwestCodexHttp, ReqwestProviderHttp, DEFAULT_ORIGINATOR,
    LOGIN_CANCELLED,
};
use pa_core::auth::AuthCredential;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

const PROTOCOL_VERSION: u32 = 1;
const UPSTREAM_REVISION: &str = "763094e1b6a7c17450ee8399b06cda1853847ca5";
const MAX_INPUT_BYTES: usize = 64 * 1024;
const INPUT_QUEUE_CAPACITY: usize = 8;
const PROVIDERS: [&str; 6] = [
    "anthropic",
    "github-copilot",
    "openai-codex",
    "xai",
    "prime-inference",
    "prime-agent-traces",
];
const MANUAL_CODE_MESSAGE: &str =
    "Complete sign-in in your browser, or paste the authorization code or redirect URL.";

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum LoginMethod {
    #[default]
    Oauth,
    ApiKey,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Input {
    Start {
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(default)]
        method: LoginMethod,
        #[serde(rename = "primeCliConfigPath")]
        prime_cli_config_path: Option<std::path::PathBuf>,
        cwd: Option<std::path::PathBuf>,
        #[serde(rename = "agentDir")]
        agent_dir: Option<std::path::PathBuf>,
    },
    Reply {
        #[serde(rename = "promptId")]
        prompt_id: String,
        value: Option<String>,
    },
    Cancel,
}

struct LoginResult {
    credential: AuthCredential,
    preserve_prime_team: bool,
}

type PromptFuture = Pin<Box<dyn Future<Output = Option<String>> + Send>>;

#[derive(Clone)]
struct BridgeUi {
    state: Arc<BridgeState>,
}

struct BridgeState {
    cancelled: AtomicBool,
    cancellation: Notify,
    next_prompt: AtomicU64,
    prompts: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
}

struct PendingPrompt {
    bridge: BridgeUi,
    prompt_id: String,
}

impl Drop for PendingPrompt {
    fn drop(&mut self) {
        let removed = self
            .bridge
            .state
            .prompts
            .lock()
            .expect("prompt state lock")
            .remove(&self.prompt_id)
            .is_some();
        if removed {
            self.bridge.emit(json!({
                "type": "prompt_cancelled",
                "promptId": self.prompt_id
            }));
        }
    }
}

impl BridgeUi {
    fn new() -> Self {
        Self {
            state: Arc::new(BridgeState {
                cancelled: AtomicBool::new(false),
                cancellation: Notify::new(),
                next_prompt: AtomicU64::new(0),
                prompts: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn emit(&self, event: Value) {
        if write_event(&event).is_err() {
            self.cancel();
        }
    }

    fn cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::SeqCst);
        self.state.cancellation.notify_one();
        self.state
            .prompts
            .lock()
            .expect("prompt state lock")
            .clear();
    }

    fn prompt(&self, prompt: Value) -> PromptFuture {
        if self.cancelled() {
            return Box::pin(async { None });
        }
        let prompt_number = self.state.next_prompt.fetch_add(1, Ordering::SeqCst);
        let prompt_id = format!("auth-{prompt_number}");
        let (sender, receiver) = oneshot::channel();
        self.state
            .prompts
            .lock()
            .expect("prompt state lock")
            .insert(prompt_id.clone(), sender);
        self.emit(json!({ "type": "prompt", "promptId": prompt_id, "prompt": prompt }));
        let pending = PendingPrompt {
            bridge: self.clone(),
            prompt_id,
        };
        Box::pin(async move {
            let _pending = pending;
            receiver.await.ok().flatten()
        })
    }

    fn reply(&self, prompt_id: &str, value: Option<String>) {
        let sender = self
            .state
            .prompts
            .lock()
            .expect("prompt state lock")
            .remove(prompt_id);
        if let Some(sender) = sender {
            let _ = sender.send(value);
        }
    }

    fn auth(&self, url: &str, instructions: Option<&str>) {
        // Prime's device flows expose their code through this exact UI callback format.
        let device_code = instructions.and_then(|value| value.strip_prefix("Enter code: "));
        let notice = match device_code {
            Some(code) => json!({
                "type": "device_code",
                "userCode": code,
                "verificationUri": url
            }),
            None => json!({ "type": "auth_url", "url": url, "instructions": instructions }),
        };
        self.emit(json!({ "type": "notice", "notice": notice }));
    }

    fn progress(&self, message: &str) {
        self.emit(json!({
            "type": "notice",
            "notice": { "type": "progress", "message": message }
        }));
    }

    fn manual_code(&self) -> PromptFuture {
        self.prompt(json!({
            "type": "manual_code",
            "message": MANUAL_CODE_MESSAGE,
            "placeholder": "http://localhost/callback?code=…"
        }))
    }
}

impl OAuthLoginUi for BridgeUi {
    fn on_auth(&self, url: &str, instructions: Option<&str>) {
        self.auth(url, instructions);
    }

    fn on_prompt(&self, prompt: &OAuthPrompt) -> PromptFuture {
        self.prompt(json!({
            "type": "text",
            "message": prompt.message,
            "placeholder": prompt.placeholder
        }))
    }

    fn on_progress(&self, message: &str) {
        self.progress(message);
    }

    fn on_manual_code_input(&self) -> Option<PromptFuture> {
        Some(self.manual_code())
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled()
    }
}

impl CodexLoginUi for BridgeUi {
    fn on_auth(&self, url: &str, instructions: &str) {
        self.auth(url, Some(instructions));
    }

    fn on_manual_code_input(&self) -> Option<PromptFuture> {
        Some(self.manual_code())
    }

    fn on_prompt(&self, message: &str) -> PromptFuture {
        self.prompt(json!({ "type": "manual_code", "message": message }))
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled()
    }
}

fn oauth_credential(
    access: String,
    refresh: String,
    expires: i64,
    account_id: Option<String>,
    enterprise_url: Option<String>,
) -> LoginResult {
    LoginResult {
        credential: AuthCredential::Oauth {
            access,
            refresh: Some(refresh),
            expires,
            account_id,
            enterprise_url,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
        },
        preserve_prime_team: false,
    }
}

async fn login(
    provider_id: &str,
    method: LoginMethod,
    prime_cli_config_path: Option<&std::path::Path>,
    cwd: Option<&std::path::Path>,
    agent_dir: Option<&std::path::Path>,
    bridge: &BridgeUi,
) -> Result<LoginResult, String> {
    if let Some(server) = provider_id.strip_prefix("mcp:") {
        let cwd = cwd.ok_or_else(|| "Choose a workspace for MCP sign-in".to_string())?;
        let agent_dir = agent_dir.ok_or_else(|| "An account directory is required".to_string())?;
        return mcp::login(bridge, server, cwd, agent_dir).await;
    }
    let http = ReqwestProviderHttp::new();
    match provider_id {
        "anthropic" => {
            let credentials = login_anthropic(&http, bridge).await?;
            Ok(oauth_credential(
                credentials.access,
                credentials.refresh,
                credentials.expires,
                None,
                None,
            ))
        }
        "github-copilot" => {
            let credentials = login_github_copilot(&http, bridge).await?;
            Ok(oauth_credential(
                credentials.access,
                credentials.refresh,
                credentials.expires,
                None,
                credentials.enterprise_url,
            ))
        }
        "openai-codex" => {
            let credentials =
                login_openai_codex(&ReqwestCodexHttp::new(), bridge, DEFAULT_ORIGINATOR).await?;
            Ok(oauth_credential(
                credentials.access,
                credentials.refresh,
                credentials.expires,
                Some(credentials.account_id),
                None,
            ))
        }
        "xai" => {
            let credentials = login_xai(&http, bridge).await?;
            Ok(oauth_credential(
                credentials.access,
                credentials.refresh,
                credentials.expires,
                None,
                None,
            ))
        }
        "prime-inference" => prime_inference::login(bridge, prime_cli_config_path, method).await,
        "prime-agent-traces" => {
            traces::login(
                bridge,
                prime_cli_config_path,
                matches!(method, LoginMethod::ApiKey),
            )
            .await
        }
        _ => Err("Unsupported provider".to_string()),
    }
}

fn write_event(event: &Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, event)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn read_input() -> mpsc::Receiver<Input> {
    let (sender, receiver) = mpsc::channel(INPUT_QUEUE_CAPACITY);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();
        loop {
            let mut line = Vec::new();
            let mut limited = std::io::Read::take(&mut reader, (MAX_INPUT_BYTES + 1) as u64);
            let Ok(length) = limited.read_until(b'\n', &mut line) else {
                break;
            };
            if length == 0 || length > MAX_INPUT_BYTES {
                break;
            }
            let Ok(input) = serde_json::from_slice::<Input>(&line) else {
                break;
            };
            if sender.blocking_send(input).is_err() {
                return;
            }
        }
        let _ = sender.blocking_send(Input::Cancel);
    });
    receiver
}

async fn handle_input(mut input: mpsc::Receiver<Input>, bridge: BridgeUi) {
    while let Some(command) = input.recv().await {
        match command {
            Input::Reply { prompt_id, value } => bridge.reply(&prompt_id, value),
            Input::Cancel | Input::Start { .. } => {
                bridge.cancel();
                return;
            }
        }
    }
    bridge.cancel();
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // Provider failures may carry response bodies; neither panics nor errors expose those bodies.
    std::panic::set_hook(Box::new(|_| {}));
    if std::env::args().any(|value| value == "--session-delete") {
        let result = match tokio::task::spawn_blocking(lineage::run_delete).await {
            Ok(Ok(result)) => json!({ "ok": true, "result": result }),
            Ok(Err(error)) => json!({ "ok": false, "error": error.to_string() }),
            Err(_) => {
                json!({ "ok": false, "error": "Engine 2 child deletion could not complete." })
            }
        };
        let _ = write_event(&result);
        return;
    }
    if std::env::args().any(|value| value == "--session-lineage") {
        let result = match tokio::task::spawn_blocking(lineage::run).await {
            Ok(Ok(result)) => json!({ "ok": true, "result": result }),
            _ => json!({ "ok": false, "error": "Engine 2 session discovery could not complete." }),
        };
        let _ = write_event(&result);
        return;
    }
    if std::env::args().any(|value| value == "--restart-config") {
        let result = match tokio::task::spawn_blocking(restart::run).await {
            Ok(Ok(result)) => json!({ "ok": true, "result": result }),
            Ok(Err(error)) => {
                json!({ "ok": false, "error": restart::error_message(&error) })
            }
            Err(_) => json!({
                "ok": false,
                "error": "The Engine 2 restart configuration action could not complete."
            }),
        };
        let _ = write_event(&result);
        return;
    }
    if std::env::args().any(|value| value == "--resources") {
        let result = match tokio::task::spawn_blocking(resources::run).await {
            Ok(Ok(result)) => json!({ "ok": true, "result": result }),
            Ok(Err(error)) => {
                json!({ "ok": false, "error": resources::error_message(&error) })
            }
            Err(_) => {
                json!({ "ok": false, "error": "The Engine 2 resource action could not complete." })
            }
        };
        let _ = write_event(&result);
        return;
    }
    if std::env::args().any(|value| value == "--traces") {
        let result = match traces::run().await {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(_) => {
                json!({ "ok": false, "error": "The Engine trace action could not complete." })
            }
        };
        let _ = write_event(&result);
        return;
    }
    if std::env::args().any(|value| value == "--session") {
        let result = match sessions::run() {
            Ok(path) => json!({ "ok": true, "path": path }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        };
        let _ = write_event(&result);
        return;
    }
    let metadata = json!({
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "revision": UPSTREAM_REVISION,
        "providers": PROVIDERS,
        "mcp": true,
        "resources": true,
        "restartConfig": true,
        "restartCapture": true,
        "sessions": true,
        "sessionLineage": true,
        "sessionDelete": true,
        "traces": true
    });
    if write_event(&metadata).is_err() || std::env::args().any(|value| value == "--version") {
        return;
    }
    let mut input = read_input();
    let Some(Input::Start {
        provider_id,
        method,
        prime_cli_config_path,
        cwd,
        agent_dir,
    }) = input.recv().await
    else {
        return;
    };
    let bridge = BridgeUi::new();
    let reader = tokio::spawn(handle_input(input, bridge.clone()));
    let outcome = tokio::select! {
        result = login(
            &provider_id,
            method,
            prime_cli_config_path.as_deref(),
            cwd.as_deref(),
            agent_dir.as_deref(),
            &bridge
        ) => result,
        _ = bridge.state.cancellation.notified() => Err(LOGIN_CANCELLED.to_string()),
    };
    reader.abort();
    let cancelled = bridge.cancelled();
    bridge.cancel();
    let event = match outcome {
        Ok(result) if !cancelled => json!({
            "type": "done",
            "ok": true,
            "credential": result.credential,
            "preservePrimeTeam": result.preserve_prime_team
        }),
        Ok(_) => json!({ "type": "done", "ok": false, "cancelled": true }),
        Err(error) => json!({
            "type": "done",
            "ok": false,
            "cancelled": cancelled || error == LOGIN_CANCELLED,
            "error": "Sign-in could not be completed. Please retry the provider’s sign-in."
        }),
    };
    let _ = write_event(&event);
}
