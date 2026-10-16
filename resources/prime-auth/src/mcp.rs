use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use pa_core::auth::AuthStorage;
use pa_core::mcp::{
    mcp_login, McpLoginUi, McpManager, McpManagerOptions, McpOAuthConfig, McpServerConfig,
    ReqwestOAuthHttp,
};
use pa_core::settings::SettingsManager;
use serde_json::json;

use crate::{BridgeUi, LoginResult, PromptFuture, LOGIN_CANCELLED};

impl McpLoginUi for BridgeUi {
    fn on_progress(&self, message: &str) {
        self.progress(message);
    }

    fn on_auth(&self, url: &str, instructions: &str) {
        self.auth(url, Some(instructions));
    }

    fn on_prompt(
        &self,
        message: &str,
        placeholder: &str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
        let reply = self.prompt(json!({
            "type": "manual_code",
            "message": message,
            "placeholder": placeholder
        }));
        Box::pin(async move { reply.await.ok_or_else(|| anyhow::anyhow!(LOGIN_CANCELLED)) })
    }

    fn on_manual_code_input(&self) -> Option<PromptFuture> {
        Some(self.manual_code())
    }
}

fn resolve_oauth_config(
    server: &str,
    cwd: &Path,
    agent_dir: &Path,
) -> Result<McpOAuthConfig, String> {
    let settings = SettingsManager::create(cwd, agent_dir);
    if !settings.errors().is_empty() {
        return Err("Engine MCP settings could not be loaded.".to_string());
    }
    let auth_storage = AuthStorage::create(agent_dir);
    if auth_storage.load_error().is_some() {
        return Err("Engine credentials could not be loaded.".to_string());
    }
    let configured_servers = settings.settings().mcp_servers.clone().unwrap_or_default();
    if let Some(config) = configured_servers.get(server) {
        serde_json::from_value::<McpServerConfig>(config.clone())
            .map_err(|_| "The MCP server configuration is invalid.".to_string())?;
    }
    let user_servers: HashMap<String, McpServerConfig> = configured_servers
        .into_iter()
        .filter_map(|(name, config)| {
            serde_json::from_value(config)
                .ok()
                .map(|parsed| (name, parsed))
        })
        .collect();
    let catalog_sources = settings
        .settings()
        .mcp_catalog_sources
        .clone()
        .unwrap_or_default();
    let manager = McpManager::new(McpManagerOptions {
        auth_storage,
        get_user_servers: Box::new(move || Some(user_servers.clone())),
        begin_login: None,
        agent_dir: Some(agent_dir.to_path_buf()),
        get_catalog_sources: Some(Box::new(move || catalog_sources.clone())),
        remote_source: None,
        probe_override: None,
    });
    manager
        .oauth_config(server)
        .ok_or_else(|| "This MCP connection does not support OAuth sign-in.".to_string())
}

pub(super) async fn login(
    bridge: &BridgeUi,
    server: &str,
    cwd: &Path,
    agent_dir: &Path,
) -> Result<LoginResult, String> {
    let server = server.to_string();
    let cwd = cwd.to_path_buf();
    let agent_dir = agent_dir.to_path_buf();
    // The native manager snapshots credentials with a blocking Tokio mutex.
    let config =
        tokio::task::spawn_blocking(move || resolve_oauth_config(&server, &cwd, &agent_dir))
            .await
            .map_err(|_| "Engine MCP settings could not be loaded.".to_string())??;
    let credential = mcp_login(&ReqwestOAuthHttp::new(), &config, bridge)
        .await
        .map_err(|error| error.to_string())?;
    Ok(LoginResult {
        credential,
        preserve_prime_team: false,
    })
}
