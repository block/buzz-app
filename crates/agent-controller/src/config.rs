use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_AGENTS: usize = 2000;

// Only these explicit projections may cross IPC. Environment values and unknown
// legacy fields remain native-only even when they do not look like credentials.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSnapshot {
    pub agents: Vec<AgentView>,
    pub runtime_available: bool,
    pub runtime_message: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub pubkey: String,
    pub relay_url: String,
    pub name: String,
    pub system_prompt: String,
    pub workspace: String,
    pub harness: HarnessView,
    pub revision: u64,
    pub running_revision: Option<u64>,
    pub enabled: bool,
    pub status: ProcessStatus,
    pub error: Option<String>,
    pub diagnostics: Vec<String>,
    pub profile_pending: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessView {
    pub command: String,
    pub args: Vec<String>,
    pub model: String,
    pub provider: String,
    pub environment_keys: Vec<String>,
    pub databricks: Option<crate::connection::DatabricksSettings>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEdit {
    pub name: String,
    pub system_prompt: String,
    pub workspace: String,
    pub harness: HarnessEdit,
    /// Absence preserves; null deletes; a value replaces. Never a read API.
    pub environment: BTreeMap<String, Option<String>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessEdit {
    pub command: String,
    pub args: Vec<String>,
    pub model: String,
    pub provider: String,
    #[serde(default)]
    pub databricks: Option<crate::connection::DatabricksSettings>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Agent {
    pub id: String,
    pub pubkey: String,
    pub relay_url: String,
    pub name: String,
    pub system_prompt: String,
    pub workspace: String,
    pub harness: HarnessEdit,
    pub environment: BTreeMap<String, String>,
    pub revision: u64,
    pub enabled: bool,
    /// Credential reference only. Secret key resides in the native credential store.
    pub credential_id: String,
    pub auth_tag: Option<String>,
    /// Original source records/config; edits never rewrite or discard these fields.
    pub imported: Value,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl Agent {
    pub fn view(&self) -> AgentView {
        AgentView {
            id: self.id.clone(),
            pubkey: self.pubkey.clone(),
            relay_url: self.relay_url.clone(),
            name: self.name.clone(),
            system_prompt: self.system_prompt.clone(),
            workspace: self.workspace.clone(),
            harness: HarnessView {
                command: self.harness.command.clone(),
                args: self.harness.args.clone(),
                model: self.harness.model.clone(),
                provider: self.harness.provider.clone(),
                environment_keys: self.environment.keys().cloned().collect(),
                databricks: self.harness.databricks.clone(),
            },
            revision: self.revision,
            running_revision: None,
            enabled: self.enabled,
            status: ProcessStatus::Stopped,
            error: None,
            diagnostics: Vec::new(),
            profile_pending: self.extra.get("profilePending") == Some(&Value::Bool(true)),
        }
    }
    pub fn apply(&mut self, edit: AgentEdit) -> Result<()> {
        self.name = edit.name;
        self.system_prompt = edit.system_prompt;
        self.workspace = edit.workspace;
        self.harness = edit.harness;
        for (key, value) in edit.environment {
            validate_env_key(&key)?;
            if let Some(value) = value {
                text(&value, 32 * 1024, "Environment value")?;
                self.environment.insert(key, value);
            } else {
                self.environment.remove(&key);
            }
        }
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("Agent revision exhausted")?;
        self.validate()
    }
    pub fn validate(&self) -> Result<()> {
        if !canonical_key(&self.pubkey) || self.id != agent_id(&self.pubkey, &self.relay_url) {
            return Err("Invalid agent identity".into());
        }
        if canonical_relay(&self.relay_url)? != self.relay_url {
            return Err("Agent community must be canonical".into());
        }
        if self.revision == 0 || self.revision > 9_007_199_254_740_991 {
            return Err("Invalid agent revision".into());
        }
        if self.name.trim().is_empty() {
            return Err("Agent name is required".into());
        }
        text(&self.name, 256, "Agent name")?;
        text(&self.system_prompt, 128 * 1024, "System prompt")?;
        text(&self.workspace, 4096, "Workspace")?;
        if !Path::new(&self.workspace).is_absolute() {
            return Err("Choose an absolute workspace path".into());
        }
        text(&self.harness.command, 4096, "Harness command")?;
        if self.harness.command.trim().is_empty() {
            return Err("Harness command is required".into());
        }
        if self.harness.args.len() > 128 {
            return Err("Too many harness arguments".into());
        }
        for arg in &self.harness.args {
            text(arg, 8192, "Harness argument")?;
            // Existing ACP uses clap's comma-delimited --agent-args transport.
            if arg.contains(',') || arg.is_empty() {
                return Err("ACP arguments must be nonempty and cannot contain commas".into());
            }
        }
        text(&self.harness.model, 512, "Model")?;
        text(&self.harness.provider, 128, "Provider")?;
        if let Some(settings) = &self.harness.databricks {
            settings.validate()?;
        }
        validate_environment(&self.environment)
    }
}
pub(crate) fn canonical_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn canonical_relay(value: &str) -> Result<String> {
    let invalid =
        || "Choose a secure community origin without credentials, path or query".to_string();
    let mut url = url::Url::parse(value.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    url.set_scheme("wss").map_err(|_| invalid())?;
    let host = url
        .host_str()
        .ok_or_else(invalid)?
        .trim_end_matches('.')
        .to_owned();
    url.set_host(Some(&host)).map_err(|_| invalid())?;
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
pub(crate) fn agent_id(pubkey: &str, relay: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{pubkey}-{:x}", Sha256::digest(relay.as_bytes()))
}
fn text(value: &str, limit: usize, label: &str) -> Result<()> {
    if value.len() > limit || value.contains('\0') {
        Err(format!("{label} is too long or contains a NUL byte"))
    } else {
        Ok(())
    }
}
pub(crate) fn validate_environment(environment: &BTreeMap<String, String>) -> Result<()> {
    if environment.len() > 128 {
        return Err("Too many environment entries".into());
    }
    for (key, value) in environment {
        validate_env_key(key)?;
        text(value, 32 * 1024, "Environment value")?;
    }
    Ok(())
}
fn validate_env_key(key: &str) -> Result<()> {
    let upper = key.to_ascii_uppercase();
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
        || upper.starts_with("BUZZ_ACP_")
        || upper.starts_with("BUZZ_MANAGED_")
        || upper.starts_with("BUZZ_APP_")
        || upper.starts_with("GIT_CONFIG_")
        || matches!(
            upper.as_str(),
            "BUZZ_PRIVATE_KEY"
                | "NOSTR_PRIVATE_KEY"
                | "BUZZ_AUTH_TAG"
                | "BUZZ_RELAY_URL"
                | "BUZZ_API_TOKEN"
                | "BUZZ_AGENT_CONFIG_DIR"
                | "PI_ACP_PI_COMMAND"
        )
    {
        // Do not interpolate arbitrary user text into diagnostics.
        Err("Invalid or host-reserved environment key".into())
    } else {
        Ok(())
    }
}
