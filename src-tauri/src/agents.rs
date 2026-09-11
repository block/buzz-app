//! App lifetime, not page/plugin lifetime. No live import or launch is admitted
//! until packaged runtime, credential and cross-app ownership acceptance is closed.
use buzz_agent_controller::{
    Action, AgentEdit, ControlSnapshot, Controller, Credentials, ImportPreview, Imports,
    LegacySource, Secret, Store,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const RUNTIME_GATE: &str = "Agent execution is unavailable in this checkpoint: bundled runtime and cross-app ownership protection are not ready. Keep old Buzz running for replies.";
const IMPORT_GATE: &str = "Import is disabled until native credential acceptance is complete. Preview does not access Keychain.";

// Deliberately no PlatformCredentials here yet. Even an accidental restore/read
// cannot access Keychain through this connected checkpoint.
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
}
impl Snapshot {
    fn from(data: ControlSnapshot) -> Self {
        Self {
            data,
            import_available: false,
        }
    }
}
struct Host {
    controller: Controller,
    imports: Imports,
    legacy_parent: PathBuf,
    workspace: PathBuf,
    closed: bool,
}
impl Host {
    fn open(root: PathBuf, legacy_parent: PathBuf, workspace: PathBuf) -> Result<Self, String> {
        let store = Store::open(root)?;
        let controller = Controller::new(
            store,
            Arc::new(PendingCredentials),
            Err(RUNTIME_GATE.into()),
        );
        // Do not restore enabled intent while execution safety is unavailable.
        Ok(Self {
            controller,
            imports: Imports::default(),
            legacy_parent,
            workspace,
            closed: false,
        })
    }
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        self.controller.snapshot().map(Snapshot::from)
    }
    fn action(&mut self, id: &str, action: Action) -> Result<Snapshot, String> {
        if !matches!(action, Action::Stop) {
            return Err(RUNTIME_GATE.into());
        }
        self.controller.action(id, action).map(Snapshot::from)
    }
    fn shutdown(&mut self) -> Result<(), String> {
        self.closed = true; // Fence queued commands before shutdown starts.
        self.controller.shutdown()
    }
}

#[derive(Clone)]
pub(crate) struct AgentHost(Arc<Mutex<Result<Host, String>>>);
impl AgentHost {
    pub(crate) fn open(paths: Result<(PathBuf, PathBuf, PathBuf), String>) -> Self {
        Self(Arc::new(Mutex::new(paths.and_then(
            |(root, legacy, workspace)| Host::open(root, legacy, workspace),
        ))))
    }
    fn with<T>(&self, operation: impl FnOnce(&mut Host) -> Result<T, String>) -> Result<T, String> {
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
    pub(crate) fn shutdown(&self) -> Result<(), String> {
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
        host.controller
            .save(&id, expected_revision, edit)
            .map(Snapshot::from)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_action(
    state: tauri::State<'_, AgentHost>,
    id: String,
    action: Action,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| host.action(&id, action)).await
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
    run(state.inner().clone(), move |_host| {
        let _ = (token, ids); // IPC shape is stable; unsafe capability is not admitted.
        Err(IMPORT_GATE.into())
    })
    .await
}

#[cfg(test)]
mod tests;
