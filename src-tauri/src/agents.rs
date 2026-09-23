//! App lifetime, not page/plugin lifetime. Native startup uses app-owned resources.
use buzz_agent_controller::{
    Action, AgentEdit, ControlSnapshot, Controller, Credentials, ImportPreview, Imports,
    LegacySource, NewAgent, PlatformCredentials, RuntimeBundle, Store,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    #[serde(flatten)]
    data: ControlSnapshot,
    inventory_warnings: Vec<String>,
    import_available: bool,
    create_available: bool,
    local_inventory_actions: bool,
    default_workspace: String,
    harness_options: &'static [HarnessOption],
    databricks_defaults: crate::agent_models::Defaults,
}
impl Snapshot {
    fn from(data: ControlSnapshot, import_available: bool, workspace: &std::path::Path) -> Self {
        Self {
            data,
            inventory_warnings: Vec::new(),
            import_available,
            create_available: import_available,
            local_inventory_actions: true,
            default_workspace: workspace.to_string_lossy().into_owned(),
            harness_options: HARNESS_OPTIONS,
            databricks_defaults: crate::agent_models::defaults(),
        }
    }
}
// Editing suggestions only. No discovery, auth, installation claim or default rewrite.
// IDs/labels verified against buzz's catalog and buzz-agent's provider parser.
#[derive(Serialize)]
struct HarnessOption {
    command: &'static str,
    label: &'static str,
    providers: &'static [ProviderOption],
}
#[derive(Serialize)]
struct ProviderOption {
    value: &'static str,
    label: &'static str,
}
const HARNESS_OPTIONS: &[HarnessOption] = &[HarnessOption {
    command: "buzz-agent",
    label: "Buzz Agent",
    providers: &[ProviderOption {
        value: "databricks_v2",
        label: "Databricks v2",
    }],
}];

struct Host {
    inventory_warnings: Vec<String>,
    controller: Controller,
    imports: Imports,
    legacy_parent: PathBuf,
    workspace: PathBuf,
    closed: bool,
    credentials: Arc<dyn Credentials>,
    starts: BTreeMap<String, (u64, Option<String>)>,
    next_start: u64,
    creating: Option<(String, Arc<NewAgent>)>,
    legacy_check: fn() -> Result<(), String>,
}
impl Host {
    fn open(
        root: PathBuf,
        legacy_parent: PathBuf,
        workspace: PathBuf,
        bundle: Result<RuntimeBundle, String>,
        credentials: Arc<dyn Credentials>,
    ) -> Result<Self, String> {
        let mut store = Store::open(root)?;
        let inventory_warnings = store.migrate_legacy(&legacy_parent);
        let controller = Controller::new(
            store,
            credentials.clone(),
            bundle,
            legacy_parent.join("dev.local.buzz.agent-ownership"),
        );
        Ok(Self {
            inventory_warnings,
            controller,
            imports: Imports::default(),
            legacy_parent,
            workspace,
            closed: false,
            credentials,
            starts: BTreeMap::new(),
            next_start: 0,
            creating: None,
            legacy_check: refuse_legacy,
        })
    }
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        self.controller.snapshot().map(|data| {
            let mut snapshot = Snapshot::from(data, cfg!(target_os = "macos"), &self.workspace);
            snapshot.inventory_warnings = self.inventory_warnings.clone();
            snapshot
        })
    }
    fn action(&mut self, id: &str, action: Action) -> Result<Snapshot, String> {
        self.starts.remove(id);
        self.controller.action(id, action)?;
        self.snapshot()
    }
    fn refuse_legacy(&self, id: &str) -> Result<(), String> {
        if self.controller.requires_legacy_handover(id)? {
            (self.legacy_check)()
        } else {
            Ok(())
        }
    }
    fn shutdown(&mut self) -> Result<(), String> {
        self.closed = true; // Fence queued commands before shutdown starts.
        self.controller.shutdown()
    }
}

#[derive(Clone)]
pub(crate) struct AgentHost(Arc<Mutex<Result<Host, String>>>, Arc<AtomicBool>);
impl AgentHost {
    pub(crate) fn initialize(
        paths: Result<(PathBuf, PathBuf, PathBuf), String>,
        resources: Result<PathBuf, String>,
    ) -> Self {
        let state = Arc::new(Mutex::new(Err(
            "Agent runtime is initializing; retry shortly".into(),
        )));
        let closed = Arc::new(AtomicBool::new(false));
        let owner = Self(state.clone(), closed.clone());
        tauri::async_runtime::spawn(async move {
            let opened = tauri::async_runtime::spawn_blocking(move || {
                let bundle = resources.and_then(RuntimeBundle::new);
                paths.and_then(|(root, legacy, workspace)| {
                    Host::open(
                        root,
                        legacy,
                        workspace,
                        bundle,
                        Arc::new(PlatformCredentials::default()),
                    )
                })
            })
            .await
            .unwrap_or_else(|_| Err("Agent runtime initialization failed".into()));
            if closed.load(Ordering::SeqCst) {
                return;
            }
            if let Ok(mut state) = state.lock() {
                *state = opened;
            }
            Self(state, closed).restore().await;
        });
        owner
    }
    fn with<T>(&self, operation: impl FnOnce(&mut Host) -> Result<T, String>) -> Result<T, String> {
        if self.1.load(Ordering::SeqCst) {
            return Err("Agent host is shutting down".into());
        }
        let mut state = self
            .0
            .try_lock()
            .map_err(|_| "Another native agent operation is in progress")?;
        let host = state.as_mut().map_err(|message| message.clone())?;
        if host.closed {
            return Err("Agent host is shutting down".into());
        }
        operation(host)
    }
    pub(crate) async fn restore(&self) {
        let ids = self
            .with(|host| host.controller.enabled_ids())
            .unwrap_or_default();
        for id in ids {
            let _ = start(self.clone(), id, Action::Start, true, None).await;
        }
    }
    pub(crate) fn ensure_open(&self) -> Result<(), String> {
        self.with(|_| Ok(()))
    }
    pub(crate) fn disconnect(&self, workspace: &str) -> Result<(), String> {
        let workspace = buzz_agent_controller::connection::origin(workspace)?;
        self.with(|host| {
            host.controller.disconnect(&workspace)?;
            // A successful Disconnect also retires pre-existing credential waits.
            // Otherwise their late completion could start against the removed cache.
            host.starts
                .retain(|_, (_, pending)| pending.as_deref() != Some(&workspace));
            Ok(())
        })
    }
    pub(crate) fn model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::ModelContext, String> {
        self.with(|host| match (id, revision) {
            (Some(id), Some(revision)) => host.controller.model_context(id, revision, edit),
            (None, None) => Controller::draft_model_context(edit),
            _ => Err("Invalid agent model context".into()),
        })
    }
    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.1.store(true, Ordering::SeqCst);
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Agent host shutdown could not be confirmed")?;
        if let Ok(host) = state.as_mut() {
            host.shutdown()?;
        }
        Ok(())
    }
}
async fn run<T: Send + 'static>(
    state: AgentHost,
    operation: impl FnOnce(&mut Host) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || state.with(operation))
        .await
        .map_err(|_| "Native agent operation failed; refresh status before retrying")?
}
#[tauri::command]
pub(crate) async fn agent_control_snapshot(
    state: tauri::State<'_, AgentHost>,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), |host| host.snapshot()).await
}
#[tauri::command]
pub(crate) async fn agent_control_save(
    state: tauri::State<'_, AgentHost>,
    id: String,
    expected_revision: u64,
    edit: AgentEdit,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.controller.save(&id, expected_revision, edit)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_action(
    state: tauri::State<'_, AgentHost>,
    id: String,
    action: Action,
    replay_floor: Option<u64>,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    if matches!(action, Action::Stop) {
        return run(owner, move |host| host.action(&id, action)).await;
    }
    start(owner, id, action, false, replay_floor).await
}
async fn start(
    owner: AgentHost,
    id: String,
    action: Action,
    restore: bool,
    replay_floor: Option<u64>,
) -> Result<Snapshot, String> {
    let prepared = owner.with(|host| {
        host.starts.remove(&id);
        if restore && !host.controller.enabled_ids()?.contains(&id) {
            return Err("Agent disabled before restore".into());
        }
        let request = match host.controller.credential_request(&id) {
            Ok(request) => request,
            Err(error) => {
                host.controller.record_error(&id, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = host.refuse_legacy(&id) {
            host.controller.record_error(&id, error.clone());
            return Err(error);
        }
        host.next_start = host
            .next_start
            .checked_add(1)
            .ok_or("Start sequence exhausted")?;
        let ticket = host.next_start;
        host.starts.insert(id.clone(), (ticket, request.3.clone()));
        Ok((request, ticket, host.credentials.clone()))
    })?;
    let ((credential, pubkey, revision, _workspace), ticket, credentials) = prepared;
    // OS permission prompts never hold the controller. Stop/quit invalidate the
    // ticket while the OS owns its dialog; a late key cannot start a listener.
    let acquired =
        tauri::async_runtime::spawn_blocking(move || credentials.read(&credential, &pubkey))
            .await
            .map_err(|_| "Native credential operation failed".to_owned())
            .and_then(|v| v)
            .and_then(|v| v.ok_or("Saved agent key is unavailable; nothing was started".into()));
    run(owner, move |host| {
        if host.starts.get(&id).map(|(ticket, _)| *ticket) != Some(ticket) {
            return Err("Start cancelled by a newer action".into());
        }
        host.starts.remove(&id);
        let key = match acquired {
            Ok(key) => key,
            Err(error) => {
                host.controller.record_error(&id, error);
                return host.snapshot();
            }
        };
        if let Err(error) = host.refuse_legacy(&id) {
            host.controller.record_error(&id, error);
            return host.snapshot();
        }
        host.controller
            .action_with_key(&id, action, revision, &key, replay_floor)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_use_here(
    state: tauri::State<'_, AgentHost>,
    id: String,
    resolution: buzz_agent_controller::CommunityResolution,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.controller.use_here(&id, resolution)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_local_clone_settings(
    state: tauri::State<'_, AgentHost>,
    id: String,
) -> Result<buzz_agent_controller::CloneSettings, String> {
    run(state.inner().clone(), move |host| {
        host.controller.local_clone_settings(&id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_clone_settings(
    state: tauri::State<'_, AgentHost>,
    source: LegacySource,
    pubkey: String,
) -> Result<buzz_agent_controller::CloneSettings, String> {
    run(state.inner().clone(), move |host| {
        Imports::clone_settings(source, host.legacy_parent.clone(), &pubkey)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_preview(
    state: tauri::State<'_, AgentHost>,
    source: LegacySource,
    destination: String,
) -> Result<ImportPreview, String> {
    run(state.inner().clone(), move |host| {
        host.imports.preview(
            source,
            host.legacy_parent.clone(),
            host.workspace.clone(),
            &destination,
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_commit(
    state: tauri::State<'_, AgentHost>,
    token: String,
    ids: Vec<String>,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let (prepared, credentials) = owner.with(|host| {
        let prepared = host
            .controller
            .prepare_import(&mut host.imports, &token, &ids)?;
        // Consume the preview so concurrent IPC cannot import it twice.
        host.imports.discard();
        Ok((prepared, host.credentials.clone()))
    })?;
    let imported =
        tauri::async_runtime::spawn_blocking(move || prepared.acquire(credentials.as_ref()))
            .await
            .map_err(|_| "Native import credential operation failed")??;
    owner.with(|host| {
        host.controller.commit_import(imported)?;
        host.snapshot()
    })
}

#[tauri::command]
pub(crate) async fn agent_control_create_prepare(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
    destination: String,
    owner: String,
) -> Result<serde_json::Value, String> {
    run(state.inner().clone(), move |host| {
        if uuid::Uuid::parse_str(&request_id).is_err() {
            return Err("Invalid create request".into());
        }
        if host.creating.as_ref().map(|(id, _)| id) != Some(&request_id) {
            host.creating = Some((
                request_id,
                Arc::new(NewAgent::prepare(&destination, &owner)?),
            ));
        }
        let agent = &host.creating.as_ref().ok_or("Create request expired")?.1;
        if !agent.matches(&destination, &owner)? {
            return Err("Create destination or owner changed".into());
        }
        Ok(serde_json::json!({"id": agent.id, "pubkey": agent.key.pubkey()}))
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_create_commit(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
    edit: AgentEdit,
    auth: String,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let (prepared, credentials) = owner.with(|host| {
        let (_, prepared) = host
            .creating
            .as_ref()
            .filter(|(id, _)| id == &request_id)
            .ok_or("Create request expired; reopen Add agent")?;
        prepared.validate(edit.clone(), &auth)?;
        Ok((prepared.clone(), host.credentials.clone()))
    })?;
    let saved = prepared.clone();
    tauri::async_runtime::spawn_blocking(move || saved.save_key(credentials.as_ref()))
        .await
        .map_err(|_| "Native credential operation failed")??;
    owner.with(|host| {
        if host.creating.as_ref().map(|(id, _)| id) != Some(&request_id) {
            return Err("Create request was replaced".into());
        }
        host.controller.create(&prepared, edit, &auth)?;
        host.snapshot()
    })
}
#[tauri::command]
pub(crate) async fn agent_control_creation_profile(
    state: tauri::State<'_, AgentHost>,
    id: String,
) -> Result<Snapshot, String> {
    use base64::Engine;
    let owner = state.inner().clone();
    let (profile, credentials) = owner.with(|host| {
        Ok((
            host.controller.creation_profile(&id)?,
            host.credentials.clone(),
        ))
    })?;
    let (profile, body, authorization, event_id) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let key = credentials
                .read(&profile.credential_id, &profile.pubkey)?
                .ok_or("Agent key unavailable")?;
            let event = profile.event(&key)?;
            let event_id = event
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or("Invalid profile")?
                .to_owned();
            let body = serde_json::to_vec(&event).map_err(|_| "Could not encode profile")?;
            let authorization = base64::engine::general_purpose::STANDARD.encode(
                serde_json::to_vec(&profile.authenticate(&key, &body)?)
                    .map_err(|_| "Could not authorize profile")?,
            );
            Ok((profile, body, authorization, event_id))
        })
        .await
        .map_err(|_| "Native credential operation failed")??;
    owner.ensure_open()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Profile client unavailable")?;
    let mut response = client
        .post(&profile.url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Nostr {authorization}"))
        .header("x-auth-tag", &profile.auth)
        .body(body)
        .send()
        .await
        .map_err(|_| "Agent saved; profile publication unconfirmed. Retry this saved agent.")?;
    if !response.status().is_success() {
        return Err("Agent saved; relay refused its profile. Check community access, then retry this saved agent.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Profile receipt unavailable; retry this saved agent")?
    {
        if bytes.len() + chunk.len() > 16 * 1024 {
            return Err("Profile receipt too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let receipt: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid profile receipt; retry this saved agent")?;
    if receipt.get("accepted").and_then(serde_json::Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(serde_json::Value::as_str) != Some(event_id.as_str())
    {
        return Err("Agent saved; profile was not accepted. Retry this saved agent.".into());
    }
    owner.with(|host| {
        host.controller.profile_published(&id, profile.revision)?;
        host.snapshot()
    })
}

#[cfg(test)]
pub(crate) mod tests;

// Advisory handover guard only: unmodified old Buzz does not share our lock and
// can be launched afterward. Never inspect process environments or terminate it.
fn refuse_legacy_listing(listing: &str) -> Result<(), String> {
    for line in listing.lines() {
        let executable = line
            .trim()
            .split_once(char::is_whitespace)
            .map(|(_, exe)| exe.trim())
            .unwrap_or("");
        let name = std::path::Path::new(executable)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name == "buzz-desktop"
            || executable.contains("/Buzz.app/Contents/MacOS/")
            || executable.contains("/Buzz Dev.app/Contents/MacOS/")
        {
            return Err(
                "Stop old Buzz before starting agents here; simultaneous ownership is unsupported"
                    .into(),
            );
        }
    }
    Ok(())
}
fn refuse_legacy() -> Result<(), String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,comm="])
        .env_clear()
        .output()
        .map_err(|_| "Could not check old Buzz processes; Start refused")?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Could not check old Buzz processes; Start refused".into());
    }
    refuse_legacy_listing(&String::from_utf8_lossy(&output.stdout))
}
