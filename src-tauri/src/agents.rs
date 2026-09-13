//! App lifetime, not page/plugin lifetime. The disposable editor opts out of
//! credentials/execution; normal native startup uses only app-owned resources.
use buzz_agent_controller::{
    Action, AgentEdit, ControlSnapshot, Controller, Credentials, ImportPreview, Imports,
    LegacySource, PlatformCredentials, RuntimeBundle, Secret, Store,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const RUNTIME_GATE: &str = "Agent execution is disabled in the disposable editor preview.";
const IMPORT_GATE: &str = "Credential import is disabled in the disposable editor preview.";

// Disposable preview: even accidental restore/read cannot access Keychain.
struct PendingCredentials;
impl Credentials for PendingCredentials {
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        Err(IMPORT_GATE.into())
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
        Err(IMPORT_GATE.into())
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    #[serde(flatten)]
    data: ControlSnapshot,
    import_available: bool,
    harness_options: &'static [HarnessOption],
    databricks_defaults: crate::agent_models::Defaults,
}
impl Snapshot {
    fn from(data: ControlSnapshot, import_available: bool) -> Self {
        Self {
            data,
            import_available,
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
    controller: Controller,
    imports: Imports,
    legacy_parent: PathBuf,
    workspace: PathBuf,
    closed: bool,
    preview: bool,
    credentials: Arc<dyn Credentials>,
    starts: BTreeMap<String, (u64, Option<String>)>,
    next_start: u64,
    legacy_check: fn() -> Result<(), String>,
}
impl Host {
    fn open(
        root: PathBuf,
        legacy_parent: PathBuf,
        workspace: PathBuf,
        bundle: Result<RuntimeBundle, String>,
        preview: bool,
    ) -> Result<Self, String> {
        let store = Store::open(root)?;
        let credentials: Arc<dyn Credentials> = if preview {
            Arc::new(PendingCredentials)
        } else {
            Arc::new(PlatformCredentials::default())
        };
        let controller = Controller::new(
            store,
            credentials.clone(),
            if preview {
                Err(RUNTIME_GATE.into())
            } else {
                bundle
            },
            legacy_parent.join("dev.local.buzz.agent-ownership"),
        );
        Ok(Self {
            controller,
            imports: Imports::default(),
            legacy_parent,
            workspace,
            closed: false,
            preview,
            credentials,
            starts: BTreeMap::new(),
            next_start: 0,
            legacy_check: refuse_legacy,
        })
    }
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        self.controller
            .snapshot()
            .map(|data| Snapshot::from(data, !self.preview && cfg!(target_os = "macos")))
    }
    fn action(&mut self, id: &str, action: Action) -> Result<Snapshot, String> {
        if self.preview && !matches!(action, Action::Stop) {
            return Err(RUNTIME_GATE.into());
        }
        self.starts.remove(id);
        self.controller.action(id, action)?;
        self.snapshot()
    }
    fn refuse_legacy(&self) -> Result<(), String> {
        (self.legacy_check)()
    }
    fn shutdown(&mut self) -> Result<(), String> {
        self.closed = true; // Fence queued commands before shutdown starts.
        self.controller.shutdown()
    }
}

#[derive(Clone)]
pub(crate) struct AgentHost(Arc<Mutex<Result<Host, String>>>, Arc<AtomicBool>);
impl AgentHost {
    #[cfg(test)]
    pub(crate) fn open(
        paths: Result<(PathBuf, PathBuf, PathBuf), String>,
        bundle: Result<RuntimeBundle, String>,
        preview: bool,
    ) -> Self {
        Self(
            Arc::new(Mutex::new(paths.and_then(|(root, legacy, workspace)| {
                Host::open(root, legacy, workspace, bundle, preview)
            }))),
            Arc::new(AtomicBool::new(false)),
        )
    }
    pub(crate) fn initialize(
        paths: Result<(PathBuf, PathBuf, PathBuf), String>,
        resources: Result<PathBuf, String>,
        preview: bool,
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
                    Host::open(root, legacy, workspace, bundle, preview)
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
            .with(|host| {
                if host.preview {
                    Ok(vec![])
                } else {
                    host.controller.enabled_ids()
                }
            })
            .unwrap_or_default();
        for id in ids {
            let _ = start(self.clone(), id, Action::Start, true).await;
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
        id: &str,
        revision: u64,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::ModelContext, String> {
        self.with(|host| host.controller.model_context(id, revision, edit))
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
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    if matches!(action, Action::Stop) {
        return run(owner, move |host| host.action(&id, action)).await;
    }
    start(owner, id, action, false).await
}
async fn start(
    owner: AgentHost,
    id: String,
    action: Action,
    restore: bool,
) -> Result<Snapshot, String> {
    let prepared = owner.with(|host| {
        if host.preview {
            return Err(RUNTIME_GATE.into());
        }
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
        if let Err(error) = host.refuse_legacy() {
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
        if let Err(error) = host.refuse_legacy() {
            host.controller.record_error(&id, error);
            return host.snapshot();
        }
        host.controller
            .action_with_key(&id, action, revision, &key)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_preview(
    state: tauri::State<'_, AgentHost>,
    source: LegacySource,
) -> Result<ImportPreview, String> {
    run(state.inner().clone(), move |host| {
        host.imports
            .preview(source, host.legacy_parent.clone(), host.workspace.clone())
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
        if host.preview {
            return Err(IMPORT_GATE.into());
        }
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
