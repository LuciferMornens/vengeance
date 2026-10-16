use std::io::{self, Read};
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use pa_core::packages::{
    resource_config::{self, ResourceGroup, ResourceItem},
    BundledSkillsDir, MetadataSource, MissingSourceAction, PackageManager, PackageManagerOptions,
    ResourceOrigin, ResourceType, SourceScope,
};
use pa_core::settings::SettingsManager;
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
enum ResourceError {
    InvalidSettings,
    TooLarge,
    InvalidPaths,
    MissingItem,
    MissingEnabled,
    ResourceMissing,
    Temporary,
    WebsearchDisabled,
    SaveFailed,
}

impl ResourceError {
    fn message(&self) -> &'static str {
        match self {
            Self::InvalidSettings => {
                "Engine 2 settings could not be read. Check its global and project settings."
            }
            Self::TooLarge => "Resource request is too large.",
            Self::InvalidPaths => "Resource paths must be absolute.",
            Self::MissingItem => "Choose a resource to change.",
            Self::MissingEnabled => "Choose whether to enable the resource.",
            Self::ResourceMissing => {
                "This resource is no longer available. Refresh the resource list."
            }
            Self::Temporary => "Temporary resources cannot be saved here.",
            Self::WebsearchDisabled => {
                "Enable bundled web search in Engine 2 resource settings first."
            }
            Self::SaveFailed => "The resource setting could not be saved. Refresh and try again.",
        }
    }
}

impl std::fmt::Display for ResourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for ResourceError {}

pub fn error_message(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<ResourceError>().map_or(
        "The Engine 2 resource action could not complete.",
        ResourceError::message,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation: Operation,
    cwd: PathBuf,
    agent_dir: PathBuf,
    bundled_skills_dir: Option<PathBuf>,
    item: Option<ItemIdentity>,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    List,
    Toggle,
}

#[derive(Deserialize)]
struct ItemIdentity {
    path: PathBuf,
    #[serde(rename = "type")]
    resource_type: String,
    scope: String,
    origin: String,
    source: String,
}

fn type_name(resource_type: ResourceType) -> &'static str {
    match resource_type {
        ResourceType::Skills => "skills",
        ResourceType::Prompts => "prompts",
        ResourceType::Themes => "themes",
    }
}

fn scope_name(scope: SourceScope) -> &'static str {
    match scope {
        SourceScope::User => "user",
        SourceScope::Project => "project",
        SourceScope::Temporary => "temporary",
    }
}

fn origin_name(origin: ResourceOrigin) -> &'static str {
    match origin {
        ResourceOrigin::Package => "package",
        ResourceOrigin::TopLevel => "top-level",
    }
}

fn source_name(source: &MetadataSource) -> &str {
    match source {
        MetadataSource::Local => "local",
        MetadataSource::Auto => "auto",
        MetadataSource::Builtin => "builtin",
        MetadataSource::Package(source) => source,
    }
}

fn checked_settings(request: &Request) -> Result<SettingsManager> {
    let settings = SettingsManager::create(&request.cwd, &request.agent_dir);
    if !settings.errors().is_empty() {
        bail!(ResourceError::InvalidSettings);
    }
    Ok(settings)
}

fn resolve_groups(manager: &mut PackageManager) -> Result<Vec<ResourceGroup>> {
    let mut missing_source = |_: &str| MissingSourceAction::Skip;
    let resolved = manager.resolve_with_on_missing(Some(&mut missing_source))?;
    Ok(resource_config::build_groups(&resolved))
}

fn websearch_disabled(manager: &PackageManager, item: &ResourceItem) -> bool {
    item.metadata.source == MetadataSource::Builtin
        && item.resource_type == ResourceType::Skills
        && item
            .path
            .ends_with(PathBuf::from("websearch").join("SKILL.md"))
        && manager
            .settings()
            .settings()
            .bundled_skills
            .as_ref()
            .and_then(|settings| settings.websearch)
            == Some(false)
}

fn item_value(manager: &PackageManager, item: &ResourceItem) -> Value {
    let mut value = json!({
        "path": item.path,
        "type": type_name(item.resource_type),
        "displayName": item.display_name,
        "enabled": item.enabled,
        "scope": scope_name(item.metadata.scope),
        "origin": origin_name(item.metadata.origin),
        "source": source_name(&item.metadata.source),
        "baseDir": item.metadata.base_dir,
    });
    if websearch_disabled(manager, item) {
        value["description"] = json!("Disabled by the bundled web search setting.");
    }
    value
}

fn groups_value(manager: &PackageManager, groups: &[ResourceGroup]) -> Value {
    let values: Vec<Value> = groups
        .iter()
        .map(|group| {
            let label = match &group.source {
                MetadataSource::Builtin => "Built-in skills".to_string(),
                MetadataSource::Package(source) => source.clone(),
                _ if group.scope == SourceScope::Project => "Project resources".to_string(),
                _ => "User resources".to_string(),
            };
            let items: Vec<Value> = group
                .subgroups
                .iter()
                .flat_map(|subgroup| subgroup.items.iter())
                .map(|item| item_value(manager, item))
                .collect();
            json!({
                "key": group.key,
                "label": label,
                "scope": scope_name(group.scope),
                "origin": origin_name(group.origin),
                "source": source_name(&group.source),
                "items": items,
            })
        })
        .collect();
    let packages: Vec<Value> = manager
        .list_configured_packages()
        .iter()
        .map(|package| {
            json!({
                "source": package.source,
                "scope": package.scope.as_str(),
                "filtered": package.filtered,
                "installedPath": package.installed_path,
            })
        })
        .collect();
    json!({ "groups": values, "packages": packages })
}

fn matches_identity(item: &ResourceItem, identity: &ItemIdentity) -> bool {
    item.path == identity.path
        && type_name(item.resource_type) == identity.resource_type
        && scope_name(item.metadata.scope) == identity.scope
        && origin_name(item.metadata.origin) == identity.origin
        && source_name(&item.metadata.source) == identity.source
}

pub fn run() -> Result<Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!(ResourceError::TooLarge);
    }
    let request: Request = serde_json::from_slice(&bytes).context("Invalid resource request")?;
    if !request.cwd.is_absolute() || !request.agent_dir.is_absolute() {
        bail!(ResourceError::InvalidPaths);
    }
    let settings = checked_settings(&request)?;
    let mut manager = PackageManager::with_options(PackageManagerOptions {
        cwd: request.cwd.clone(),
        agent_dir: request.agent_dir.clone(),
        settings,
        bundled_skills_dir: request
            .bundled_skills_dir
            .clone()
            .map_or(BundledSkillsDir::Disabled, BundledSkillsDir::Directory),
        extra_builtin_skill_overrides: Vec::new(),
    });
    let groups = resolve_groups(&mut manager)?;
    if let Operation::Toggle = request.operation {
        let identity = request.item.as_ref().context(ResourceError::MissingItem)?;
        let enabled = request.enabled.context(ResourceError::MissingEnabled)?;
        let item = groups
            .iter()
            .flat_map(|group| group.subgroups.iter())
            .flat_map(|subgroup| subgroup.items.iter())
            .find(|item| matches_identity(item, identity))
            .context(ResourceError::ResourceMissing)?;
        if item.metadata.scope == SourceScope::Temporary {
            bail!(ResourceError::Temporary);
        }
        if enabled && websearch_disabled(&manager, item) {
            bail!(ResourceError::WebsearchDisabled);
        }
        let mut settings = checked_settings(&request)?;
        resource_config::toggle_resource(
            &mut settings,
            &request.cwd,
            &request.agent_dir,
            item,
            enabled,
        )?;
        if !settings.errors().is_empty() {
            bail!(ResourceError::SaveFailed);
        }
        manager.reload_settings()?;
        let refreshed = resolve_groups(&mut manager)?;
        return Ok(groups_value(&manager, &refreshed));
    }
    Ok(groups_value(&manager, &groups))
}
