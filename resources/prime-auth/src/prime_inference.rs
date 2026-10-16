use std::path::Path;

use pa_core::auth::{
    check_prime_inference_access, fetch_prime_teams, login_prime_inference,
    resolve_prime_inference_auth_config, AuthCredential, PrimeAuthInfo,
    PrimeInferenceLoginCallbacks, PrimeInferenceLoginOptions, PrimeTeamAssignment,
    ReqwestPrimeHttp, DEFAULT_REQUEST_TIMEOUT_MS,
};
use serde_json::json;

use crate::{BridgeUi, LoginMethod, LoginResult, LOGIN_CANCELLED};

const PERSONAL_ACCOUNT: &str = "personal";
const KEEP_SELECTION: &str = "keep";

pub(super) async fn login(
    bridge: &BridgeUi,
    prime_cli_config_path: Option<&Path>,
    method: LoginMethod,
) -> Result<LoginResult, String> {
    let config = resolve_prime_inference_auth_config();
    let (api_key, mut team_assignment) = {
        let options = PrimeInferenceLoginOptions::new(prime_cli_config_path);
        let (auth_started, mut auth_events) = tokio::sync::mpsc::unbounded_channel();
        let on_auth = |information: &PrimeAuthInfo| {
            bridge.auth(&information.url, Some(&information.instructions));
            let _ = auth_started.send(());
        };
        let on_progress = |message: &str| {
            // The native reuse failure line can contain a server response body.
            let safe_message = match message {
                "Checking existing Prime CLI credentials..." => "Checking saved account access…",
                "Checking Prime Inference access..." => "Checking Prime Inference access…",
                _ => "Starting browser sign-in…",
            };
            bridge.progress(safe_message);
        };
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &on_auth,
            on_progress: Some(&on_progress),
        };
        let native_login = login_prime_inference(&ReqwestPrimeHttp, &config, &options, &callbacks);
        tokio::pin!(native_login);
        let mut browser_running = matches!(method, LoginMethod::Oauth);
        let mut manual: Option<crate::PromptFuture> = if browser_running {
            None
        } else {
            Some(bridge.prompt(json!({
                "type": "secret",
                "message": "Enter your Prime Inference API key."
            })))
        };
        loop {
            tokio::select! {
                result = &mut native_login, if browser_running => {
                    match result {
                        Ok(result) => break (result.api_key, result.prime_team),
                        Err(_) => {
                            browser_running = false;
                            bridge.progress(
                                "Browser sign-in is unavailable. You can enter an API key.",
                            );
                            if manual.is_none() {
                                manual = Some(bridge.prompt(json!({
                                    "type": "secret",
                                    "message": "Enter a Prime API key to continue."
                                })));
                            }
                        }
                    }
                }
                Some(()) = auth_events.recv(), if manual.is_none() => {
                    manual = Some(bridge.prompt(json!({
                        "type": "secret",
                        "message": "Complete sign-in in your browser, or enter a Prime API key."
                    })));
                }
                answer = async {
                    manual.as_mut().expect("the key prompt is active").as_mut().await
                }, if manual.is_some() => {
                    let api_key = answer.ok_or_else(|| LOGIN_CANCELLED.to_string())?;
                    if api_key.trim().is_empty() {
                        manual = Some(bridge.prompt(json!({
                            "type": "secret",
                            "message": "Enter a non-empty Prime API key."
                        })));
                        continue;
                    }
                    bridge.progress("Checking Prime Inference access…");
                    check_prime_inference_access(
                        &ReqwestPrimeHttp,
                        &config.base_url,
                        api_key.trim(),
                        DEFAULT_REQUEST_TIMEOUT_MS,
                    ).await.map_err(|_| "The key could not be verified".to_string())?;
                    break (api_key.trim().to_string(), PrimeTeamAssignment::PreserveWhenKeyMatches);
                }
            }
        }
    };
    if bridge.cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let pinned_team = std::env::var("PRIME_TEAM_ID").is_ok_and(|value| !value.trim().is_empty());
    if pinned_team {
        bridge.progress("Using the team configured by PRIME_TEAM_ID.");
    } else {
        bridge.progress("Loading Prime teams…");
        match fetch_prime_teams(
            &ReqwestPrimeHttp,
            &config.base_url,
            &api_key,
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
        {
            Ok(teams) if teams.is_empty() => {
                team_assignment = PrimeTeamAssignment::PersonalAccount;
            }
            Ok(teams) => {
                let mut choices = vec![json!({
                    "id": PERSONAL_ACCOUNT,
                    "label": "Personal account"
                })];
                choices.extend(teams.iter().map(|team| {
                    json!({
                        "id": format!("team:{}", team.team_id),
                        "label": team.name,
                        "description": team.role
                    })
                }));
                choices.push(json!({
                    "id": KEEP_SELECTION,
                    "label": "Keep saved account selection"
                }));
                let choice = bridge
                    .prompt(json!({
                        "type": "select",
                        "message": "Choose the account for Prime Inference.",
                        "options": choices
                    }))
                    .await
                    .ok_or_else(|| LOGIN_CANCELLED.to_string())?;
                if choice == PERSONAL_ACCOUNT {
                    team_assignment = PrimeTeamAssignment::PersonalAccount;
                } else if choice != KEEP_SELECTION {
                    let team_id = choice.strip_prefix("team:").unwrap_or_default();
                    let selected = teams
                        .into_iter()
                        .find(|team| team.team_id == team_id)
                        .ok_or_else(|| "Invalid account selection".to_string())?;
                    team_assignment = PrimeTeamAssignment::Team(selected);
                }
            }
            Err(_) => {
                bridge
                    .progress("Teams could not be loaded. The saved account selection will apply.");
            }
        }
    }
    let preserve_prime_team =
        matches!(team_assignment, PrimeTeamAssignment::PreserveWhenKeyMatches);
    let prime_team = match team_assignment {
        PrimeTeamAssignment::Team(team) => Some(team),
        PrimeTeamAssignment::PersonalAccount | PrimeTeamAssignment::PreserveWhenKeyMatches => None,
    };
    Ok(LoginResult {
        credential: AuthCredential::ApiKey {
            key: api_key,
            prime_team,
        },
        preserve_prime_team,
    })
}
