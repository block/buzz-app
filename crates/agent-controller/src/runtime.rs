use crate::bundle::RuntimeBundle;
use crate::config::Agent;
use crate::process::Process;
use crate::{AgentEdit, ControlSnapshot, Credentials, ProcessStatus, Result, Store};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

impl RuntimeBundle {
    fn command(&self, agent: &Agent, key: &crate::Secret) -> Result<Command> {
        agent.validate()?;
        if key.pubkey() != agent.pubkey {
            return Err("Credential does not match the saved agent".into());
        }
        if !Path::new(&agent.workspace).is_dir() {
            return Err("Agent workspace does not exist".into());
        }
        let worker = if agent.harness.command == "buzz-agent" {
            self.executable("buzz-agent")?
        } else {
            let path = PathBuf::from(&agent.harness.command);
            if !path.is_absolute() {
                return Err("Choose the installed harness's absolute executable path".into());
            }
            executable(&path)?;
            path
        };
        let record = &agent.imported["record"];
        if record["backend"]["type"]
            .as_str()
            .is_some_and(|s| s != "local")
            || record["team_id"].as_str().is_some_and(|s| !s.is_empty())
            || record["persona_team_dir"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            || agent.harness.provider == "relay-mesh"
            || !record["relay_mesh"].is_null()
        {
            return Err("This imported agent requires a remote/team/mesh integration not supported by the local controller".into());
        }
        let respond_to = record["respond_to"].as_str().unwrap_or("owner-only");
        if !matches!(respond_to, "owner-only" | "allowlist" | "anyone") {
            return Err("Invalid imported response policy".into());
        }
        if agent.auth_tag.is_none() {
            return Err("This identity has no saved owner attestation; native owner binding is required before starting".into());
        }
        crate::secret::validate_attestation(
            agent.auth_tag.as_deref().unwrap_or(""),
            &agent.pubkey,
        )?;
        let mut command = Command::new(self.executable("buzz-acp")?);
        // Never inherit the current managed agent's key, owner, relay, replay floor,
        // process marker, git injection or provider credentials into the new agent.
        command
            .env_clear()
            .current_dir(&agent.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for name in [
            "HOME",
            "TMPDIR",
            "USER",
            "LOGNAME",
            "LANG",
            "SSH_AUTH_SOCK",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let path = std::env::join_paths([
            self.directory.as_path(),
            Path::new("/usr/bin"),
            Path::new("/bin"),
            Path::new("/usr/sbin"),
            Path::new("/sbin"),
        ])
        .map_err(|_| "Invalid runtime tools path")?;
        command.envs(&agent.environment);
        command.env("PATH", path);
        let key_hex = key.hex();
        command
            .env("BUZZ_PRIVATE_KEY", &*key_hex)
            .env("NOSTR_PRIVATE_KEY", &*key_hex)
            .env("BUZZ_RELAY_URL", &agent.relay_url)
            .env("BUZZ_AUTH_TAG", agent.auth_tag.as_deref().unwrap_or(""))
            .env("BUZZ_ACP_AGENT_COMMAND", worker)
            .env("BUZZ_ACP_AGENT_ARGS", agent.harness.args.join(","))
            .env("BUZZ_ACP_SYSTEM_PROMPT", &agent.system_prompt)
            .env("BUZZ_ACP_DISPLAY_NAME", &agent.name)
            .env("BUZZ_ACP_LAZY_POOL", "true")
            .env("BUZZ_ACP_IDLE_POOL_SLEEP", "900")
            .env("BUZZ_ACP_SUBSCRIBE", "mentions")
            .env("BUZZ_ACP_RESPOND_TO", respond_to)
            .env("BUZZ_ACP_DEDUP", "queue")
            .env("BUZZ_ACP_MULTIPLE_EVENT_HANDLING", "steer")
            .env("BUZZ_ACP_MCP_COMMAND", self.executable("buzz-dev-mcp")?)
            .env("BUZZ_ACP_RELAY_OBSERVER", "false");
        let worker_name = Path::new(&agent.harness.command)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        // Explicit per-agent environment overrides selectors, matching the editor's
        // Environment overrides contract. A blank selector must not erase it.
        let mapping = match worker_name {
            "buzz-agent" => Some(("BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER")),
            "goose" => Some(("GOOSE_MODEL", "GOOSE_PROVIDER")),
            _ if !agent.harness.provider.is_empty() => return Err("Set provider configuration through this external harness's environment; a provider selector mapping is not available".into()),
            _ => None,
        };
        let mut model = (!agent.harness.model.is_empty()).then_some(agent.harness.model.as_str());
        if let Some((model_key, provider_key)) = mapping {
            model = agent
                .environment
                .get(model_key)
                .map(String::as_str)
                .or(model);
            let provider = agent
                .environment
                .get(provider_key)
                .map(String::as_str)
                .or_else(|| {
                    (!agent.harness.provider.is_empty()).then_some(agent.harness.provider.as_str())
                });
            if let Some(value) = model {
                command.env(model_key, value);
            }
            if let Some(value) = provider {
                command.env(provider_key, value);
            }
        }
        if let Some(value) = model {
            command.env("BUZZ_ACP_MODEL", value);
        }
        if respond_to == "allowlist" {
            let values = record["respond_to_allowlist"]
                .as_array()
                .ok_or("Missing imported response allowlist")?;
            let mut keys = Vec::new();
            for value in values {
                let key = value
                    .as_str()
                    .filter(|k| crate::config::canonical_key(k))
                    .ok_or("Invalid imported response allowlist")?;
                keys.push(key);
            }
            if keys.is_empty() {
                return Err("Imported response allowlist is empty".into());
            }
            command.env("BUZZ_ACP_RESPOND_TO_ALLOWLIST", keys.join(","));
        }
        for (field, env) in [
            ("idle_timeout_seconds", "BUZZ_ACP_IDLE_TIMEOUT"),
            ("max_turn_duration_seconds", "BUZZ_ACP_MAX_TURN_DURATION"),
            ("parallelism", "BUZZ_ACP_AGENTS"),
        ] {
            if !record[field].is_null() {
                let n = record[field]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 86400)
                    .ok_or("Invalid imported execution limit")?;
                command.env(env, n.to_string());
            }
        }
        if let Some(effort) = record["effort_level"].as_str() {
            command.env("BUZZ_ACP_EFFORT_LEVEL", effort);
        }
        Ok(command)
    }
}
fn effective_databricks(agent: &Agent) -> Result<Option<crate::connection::DatabricksSettings>> {
    let buzz_agent = Path::new(&agent.harness.command)
        .file_name()
        .and_then(|s| s.to_str())
        == Some("buzz-agent");
    if !buzz_agent {
        return Ok(None);
    }
    if !agent.harness.args.is_empty() {
        return Err(
            "Buzz Agent runs in ACP mode without arguments; use Connect for sign-in".into(),
        );
    }
    let provider = agent
        .environment
        .get("BUZZ_AGENT_PROVIDER")
        .unwrap_or(&agent.harness.provider);
    if !matches!(
        provider.as_str(),
        "databricks_v2" | "databricks-v2" | "databricks"
    ) {
        return Ok(None);
    }
    if agent.environment.contains_key("DATABRICKS_TOKEN") {
        return Err("Remove DATABRICKS_TOKEN to use this app's persistent OAuth connection".into());
    }
    let mut settings = agent.harness.databricks.clone().unwrap_or_default();
    if let Some(host) = agent.environment.get("DATABRICKS_HOST") {
        settings.host = host.clone();
    }
    if let Some(filter) = agent.environment.get("DATABRICKS_MODEL_FILTER") {
        settings.filter = filter.clone();
    }
    settings.host = crate::connection::origin(&settings.host)?;
    settings.validate()?;
    Ok(Some(settings))
}
pub(crate) fn executable(path: &Path) -> Result<()> {
    let metadata = path
        .metadata()
        .map_err(|_| "Required runtime executable is missing")?;
    if !metadata.is_file() {
        return Err("Required runtime executable is not a file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("Runtime file is not executable".into());
        }
    }
    Ok(())
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Start,
    Stop,
    Restart,
}
struct Running {
    process: Process,
    revision: u64,
    databricks_host: Option<String>,
    temporary: Option<tempfile::TempDir>,
    _ownership: crate::ownership::Ownership,
}
impl Drop for Running {
    fn drop(&mut self) {
        if self.process.stop().is_err() {
            // Never delete temporary signing material out from under an unconfirmed
            // descendant. Retain the private directory for explicit recovery.
            if let Some(directory) = self.temporary.take() {
                let _ = directory.keep();
            }
        }
    }
}
/// Deliberately not serializable: only the native connection owner consumes it.
pub struct ModelContext {
    pub host: Option<String>,
    pub filter: Option<String>,
    pub model_overridden: bool,
}
/// Native-only Goose catalog context; environment values never enter a snapshot.
pub struct GooseModelContext {
    pub command: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub model_overridden: bool,
}
pub struct Controller {
    pub(crate) store: Store,
    credentials: Arc<dyn Credentials>,
    bundle: Result<RuntimeBundle>,
    running: BTreeMap<String, Running>,
    errors: BTreeMap<String, String>,
    ownership_root: PathBuf,
}
impl Controller {
    pub fn new(
        store: Store,
        credentials: Arc<dyn Credentials>,
        bundle: Result<RuntimeBundle>,
        ownership_root: PathBuf,
    ) -> Self {
        Self {
            store,
            credentials,
            bundle,
            running: BTreeMap::new(),
            errors: BTreeMap::new(),
            ownership_root,
        }
    }
    pub fn snapshot(&mut self) -> Result<ControlSnapshot> {
        let mut snapshot = self.store.snapshot()?;
        snapshot.runtime_available = self.bundle.is_ok();
        snapshot.runtime_message = self.bundle.as_ref().err().cloned();
        for agent in &mut snapshot.agents {
            if let Some(run) = self.running.get_mut(&agent.id) {
                match run.process.alive() {
                    Ok(true) => {
                        agent.status = ProcessStatus::Running;
                        agent.running_revision = Some(run.revision);
                    }
                    Ok(false) => {
                        self.running.remove(&agent.id);
                        self.errors.insert(
                            agent.id.clone(),
                            "Agent listener exited; restart to retry".into(),
                        );
                    }
                    Err(error) => {
                        self.errors.insert(agent.id.clone(), error);
                    }
                }
            }
            if let Some(error) = self.errors.get(&agent.id) {
                agent.status = ProcessStatus::Failed;
                agent.error = Some(error.clone());
            }
        }
        Ok(snapshot)
    }
    /// Native-only catalog configuration. Never serialize environment values or
    /// lend runtime credentials to model discovery. Resolve an unsaved edit on a
    /// clone using the same validation and precedence as Save/runtime.
    pub fn model_context(&self, id: &str, revision: u64, edit: AgentEdit) -> Result<ModelContext> {
        let agent = self.edited_model_agent(id, revision, edit)?;
        model_context(&agent.harness, &agent.environment)
    }
    pub fn goose_model_context(
        &self,
        id: &str,
        revision: u64,
        edit: AgentEdit,
    ) -> Result<GooseModelContext> {
        let agent = self.edited_model_agent(id, revision, edit)?;
        goose_model_context(&agent.harness, &agent.environment)
    }
    fn edited_model_agent(&self, id: &str, revision: u64, edit: AgentEdit) -> Result<Agent> {
        let mut agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.revision != revision {
            return Err(
                "Saved settings changed; discard or reconcile the draft before connecting".into(),
            );
        }
        agent.apply(edit)?;
        Ok(agent)
    }
    pub fn draft_goose_model_context(edit: AgentEdit) -> Result<GooseModelContext> {
        let environment = edit
            .environment
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect();
        goose_model_context(&edit.harness, &environment)
    }
    pub fn draft_model_context(edit: AgentEdit) -> Result<ModelContext> {
        let environment = edit
            .environment
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect();
        model_context(&edit.harness, &environment)
    }
    pub fn requires_legacy_handover(&self, id: &str) -> Result<bool> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        Ok(
            agent.extra.get("nativeCreated") != Some(&serde_json::Value::Bool(true))
                || !agent.imported.is_null(),
        )
    }
    pub fn prepare_import(
        &self,
        imports: &mut crate::Imports,
        token: &str,
        ids: &[String],
    ) -> Result<crate::PreparedImport> {
        imports.prepare(token, ids, &self.store)
    }
    pub fn commit_import(&mut self, prepared: crate::CredentialedImport) -> Result<()> {
        prepared.commit(&mut self.store)
    }
    pub fn save(&mut self, id: &str, revision: u64, edit: AgentEdit) -> Result<ControlSnapshot> {
        self.store.save(id, revision, edit)?;
        self.snapshot()
    }
    pub fn action(&mut self, id: &str, action: Action) -> Result<ControlSnapshot> {
        // Start/restart still require a saved identity; Stop must not depend on it.
        if !matches!(action, Action::Stop) && !self.store.agents()?.iter().any(|a| a.id == id) {
            return Err("Agent no longer exists".into());
        }
        let result = match action {
            Action::Stop => {
                // Stop the process even if durable disable fails; report failure
                // instead of claiming it will remain stopped on next launch.
                let stopped = self.stop(id);
                let saved = self.store.enabled(id, false);
                stopped?;
                saved?;
                Ok(())
            }
            Action::Start => self.store.enabled(id, true).and_then(|_| self.start(id)),
            Action::Restart => self
                .store
                .enabled(id, true)
                .and_then(|_| self.stop(id))
                .and_then(|_| self.start(id)),
        };
        match result {
            Ok(()) => {
                self.errors.remove(id);
            }
            Err(error) => {
                self.errors.insert(id.into(), error);
            }
        }
        self.snapshot()
    }
    pub fn restore(&mut self) -> Result<ControlSnapshot> {
        for a in self.store.agents()?.into_iter().filter(|a| a.enabled) {
            if let Err(error) = self.start(&a.id) {
                self.errors.insert(a.id, error);
            }
        }
        self.snapshot()
    }
    pub fn credential_request(&self, id: &str) -> Result<(String, String, u64, Option<String>)> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        let workspace = effective_databricks(&agent)?.map(|s| s.host);
        self.bundle.as_ref().map_err(Clone::clone)?;
        Ok((agent.credential_id, agent.pubkey, agent.revision, workspace))
    }
    pub fn action_with_key(
        &mut self,
        id: &str,
        action: Action,
        revision: u64,
        key: &crate::Secret,
        replay_floor: Option<u64>,
    ) -> Result<ControlSnapshot> {
        if self.credential_request(id)?.2 != revision {
            return Err("Saved settings changed while opening credentials; retry Start".into());
        }
        self.store.enabled(id, true)?;
        if matches!(action, Action::Restart) {
            self.stop(id)?;
        }
        match self.start_with_key(id, Some(key), replay_floor) {
            Ok(()) => {
                self.errors.remove(id);
            }
            Err(error) => {
                self.errors.insert(id.into(), error);
            }
        }
        self.snapshot()
    }
    pub fn record_error(&mut self, id: &str, error: String) {
        self.errors.insert(id.into(), error);
    }
    pub fn enabled_ids(&self) -> Result<Vec<String>> {
        Ok(self
            .store
            .agents()?
            .into_iter()
            .filter(|a| a.enabled)
            .map(|a| a.id)
            .collect())
    }
    fn start(&mut self, id: &str) -> Result<()> {
        self.start_with_key(id, None, None)
    }
    fn start_with_key(
        &mut self,
        id: &str,
        supplied: Option<&crate::Secret>,
        replay_floor: Option<u64>,
    ) -> Result<()> {
        if let Some(run) = self.running.get_mut(id) {
            if run.process.alive()? {
                return Ok(());
            }
        }
        self.running.remove(id);
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if !agent.enabled {
            return Err("Agent is disabled".into());
        }
        let bundle = self.bundle.as_ref().map_err(Clone::clone)?;
        let ownership = crate::ownership::Ownership::acquire(&self.ownership_root, &agent.id)?;
        let stored;
        let key = match supplied {
            Some(key) => key,
            None => {
                stored = self
                    .credentials
                    .read(&agent.credential_id, &agent.pubkey)?
                    .ok_or("Saved agent key is unavailable; nothing was started")?;
                &stored
            }
        };
        let settings = effective_databricks(&agent)?;
        let config = self.store.root();
        crate::connection::oauth_root(config)?;
        let runs = config.join("runs");
        crate::connection::private_directory(&runs)?;
        let temporary = tempfile::Builder::new()
            .prefix("agent-")
            .tempdir_in(&runs)
            .map_err(|_| "Could not create private runtime directory")?;
        let mut command = bundle.command(&agent, key)?;
        // Per-send startup input, never saved configuration or inherited environment.
        if let Some(floor) = replay_floor {
            command.env("BUZZ_ACP_REPLAY_FLOOR", floor.to_string());
        }
        // Last writer wins: neither user environment nor relay persona extra_env
        // may redirect credentials/temp signing material outside this app profile.
        command
            .env("BUZZ_AGENT_CONFIG_DIR", config)
            .env("TMPDIR", temporary.path())
            .env("TMP", temporary.path())
            .env("TEMP", temporary.path());
        if let Some(settings) = &settings {
            command
                .env("DATABRICKS_HOST", &settings.host)
                .env("DATABRICKS_MODEL_FILTER", &settings.filter)
                .env_remove("DATABRICKS_TOKEN");
        }
        let process = Process::spawn(&mut command)?;
        self.running.insert(
            id.into(),
            Running {
                process,
                revision: agent.revision,
                databricks_host: settings.map(|s| s.host),
                temporary: Some(temporary),
                _ownership: ownership,
            },
        );
        Ok(())
    }
    fn stop(&mut self, id: &str) -> Result<()> {
        if let Some(run) = self.running.get_mut(id) {
            run.process.stop()?;
        }
        self.running.remove(id);
        Ok(())
    }
    /// Caller holds the same native mutex used for Start/Restart. Use captured
    /// running settings, never a later saved edit, to determine credential users.
    pub fn disconnect(&mut self, workspace: &str) -> Result<()> {
        let workspace = crate::connection::origin(workspace)?;
        // Reap exits before deciding; failed teardown retains ownership and blocks.
        let ids: Vec<_> = self.running.keys().cloned().collect();
        for id in ids {
            let run = self.running.get_mut(&id).unwrap();
            if !run.process.alive()? {
                self.running.remove(&id);
            }
        }
        if self
            .running
            .values()
            .any(|r| r.databricks_host.as_deref() == Some(&workspace))
        {
            return Err("Stop agents using this Databricks workspace before Disconnect".into());
        }
        let cache = crate::connection::oauth_root(self.store.root())?;
        crate::connection::disconnect(&cache, &workspace)
    }
    pub fn shutdown(&mut self) -> Result<()> {
        let ids: Vec<_> = self.running.keys().cloned().collect();
        let mut result = Ok(());
        for id in ids {
            if let Err(e) = self.stop(&id) {
                result = Err(e);
            }
        }
        result
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
#[cfg(test)]
mod tests;

fn model_context(
    harness: &crate::HarnessEdit,
    environment: &BTreeMap<String, String>,
) -> Result<ModelContext> {
    if Path::new(&harness.command)
        .file_name()
        .and_then(|s| s.to_str())
        != Some("buzz-agent")
    {
        return Err("Model discovery requires the Buzz Agent harness".into());
    }
    let provider = environment
        .get("BUZZ_AGENT_PROVIDER")
        .unwrap_or(&harness.provider);
    if provider != "databricks_v2" {
        return Err(
            "Effective provider is not Databricks v2; check the provider and environment overrides"
                .into(),
        );
    }
    if environment.contains_key("DATABRICKS_TOKEN") {
        return Err("A saved or draft token override conflicts with this app-isolated OAuth connection. Remove it explicitly or keep manual model entry".into());
    }
    Ok(ModelContext {
        host: environment.get("DATABRICKS_HOST").cloned().or_else(|| {
            harness
                .databricks
                .as_ref()
                .map(|s| s.host.clone())
                .filter(|h| !h.is_empty())
        }),
        filter: environment
            .get("DATABRICKS_MODEL_FILTER")
            .cloned()
            .or_else(|| harness.databricks.as_ref().map(|s| s.filter.clone())),
        model_overridden: environment.contains_key("BUZZ_AGENT_MODEL"),
    })
}

fn goose_model_context(
    harness: &crate::HarnessEdit,
    environment: &BTreeMap<String, String>,
) -> Result<GooseModelContext> {
    crate::config::validate_environment(environment)?;
    let command = PathBuf::from(&harness.command);
    if command.file_name().and_then(|s| s.to_str()) != Some("goose") || !command.is_absolute() {
        return Err("Model discovery requires an absolute Goose executable path".into());
    }
    executable(&command)?;
    if environment
        .get("GOOSE_PROVIDER")
        .unwrap_or(&harness.provider)
        != "databricks_v2"
    {
        return Err(
            "Effective Goose provider is not Databricks v2; check environment overrides".into(),
        );
    }
    Ok(GooseModelContext {
        command,
        environment: environment.clone(),
        model_overridden: environment.contains_key("GOOSE_MODEL"),
    })
}
