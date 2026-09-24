//! Native connection owner. No work on snapshot/render; only an explicit ticket
//! admits auth/catalog work. This lock is independent of agent Save/Stop.
use buzz_agent::auth::BrowserOpener;
use buzz_agent_controller::connection::{oauth_root, origin};
use buzz_agent_controller::AgentEdit;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;

mod codex;
mod contracts;
mod databricks;
pub(crate) use contracts::ModelError;
use contracts::{Discovery, EffortOptions};
pub(crate) use databricks::{defaults, Defaults};
use databricks::{execute, resolve, Factory, RuntimeFactory};
const CANCELLED: &str = "Connection request cancelled or expired";
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    content = "settings",
    rename_all = "lowercase",
    deny_unknown_fields
)]
enum Integration {
    Databricks(databricks::Settings),
    Codex,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: Option<String>,
    expected_revision: Option<u64>,
    edit: Option<AgentEdit>,
    integration: Integration,
    action: Operation,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Connect,
    Refresh,
    Disconnect,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    integration: CatalogIntegration,
    models: Vec<Model>,
    defaults: Option<ResolvedDefaults>,
    discovery: Option<Discovery>,
    model_overridden: bool,
    disconnected: bool,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CatalogIntegration {
    Databricks { host: String },
    Codex,
}
#[derive(Serialize)]
struct ResolvedDefaults {
    model: Option<String>,
    effort: Option<String>,
}
#[derive(Serialize)]
struct Model {
    id: String,
    name: String,
    effort: EffortOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
struct Ticket {
    id: u64,
    abort: Option<tokio::task::AbortHandle>,
    cancelled: bool,
    created: std::time::Instant,
}
struct State {
    root: Result<PathBuf, String>,
    next: u64,
    pending: Option<Ticket>,
    closed: bool,
}
#[derive(Clone)]
pub(crate) struct ModelHost {
    state: Arc<Mutex<State>>,
    factory: Arc<dyn Factory>,
}
impl ModelHost {
    /// Headless preflight, before identity generation. Never opens a browser.
    pub(crate) async fn validate_creation(&self, edit: &AgentEdit) -> Result<(), ModelError> {
        use buzz_agent_controller::{AiConfiguration, Controller};
        if edit.harness.configuration.is_none() {
            return Err(ModelError::new(
                "configuration",
                "Choose Harness defaults or Advanced before creating an agent.",
            ));
        }
        edit.harness.validate_configuration().map_err(|message| {
            let code = match &edit.harness.configuration {
                Some(AiConfiguration::Advanced { .. }) if edit.harness.model.trim().is_empty() => {
                    "model"
                }
                Some(AiConfiguration::Advanced { .. }) => "effort",
                _ => "configuration",
            };
            ModelError::new(code, message)
        })?;
        if buzz_agent_controller::codex::is_codex(&edit.harness.command) {
            let context = Controller::draft_model_context(edit.clone())?
                .codex
                .ok_or("Missing Codex context")?;
            let ticket = self.begin_creation().await?;
            let catalog = self
                .run(ticket, codex::execute(context, edit.harness.model.clone()))
                .await?;
            if let Some(AiConfiguration::Advanced { effort }) = &edit.harness.configuration {
                catalog.validate_selection(&edit.harness.model, effort)?;
            }
            return Ok(());
        }
        let Some(AiConfiguration::Advanced { effort }) = &edit.harness.configuration else {
            return Ok(());
        };
        let context = Controller::draft_model_context(edit.clone())?;
        let settings = edit.harness.databricks.as_ref();
        let defaults = defaults();
        let settings = databricks::Settings {
            host: settings.map(|s| s.host.clone()).unwrap_or(defaults.host),
            filter: settings
                .map(|s| s.filter.clone())
                .unwrap_or(defaults.filter),
        };
        let (workspace, filter) = resolve(&settings, &context)?;
        let cache = self.cache(&workspace)?;
        let factory = self.factory.clone();
        let ticket = self.begin_creation().await?;
        let catalog = self
            .run(
                ticket,
                execute(
                    Operation::Refresh,
                    workspace,
                    filter,
                    cache,
                    false,
                    factory,
                    Arc::new(Headless),
                ),
            )
            .await?;
        catalog.validate_selection(&edit.harness.model, effort)
    }
}

impl Catalog {
    fn validate_selection(
        &self,
        model: &str,
        effort: &buzz_agent_controller::EffortSelection,
    ) -> Result<(), ModelError> {
        use buzz_agent_controller::EffortSelection;
        if self.disconnected
            || !self.discovery.as_ref().is_some_and(|d| {
                d.authentication == "authenticated"
                    && match self.integration {
                        CatalogIntegration::Databricks { .. } => {
                            d.source == "databricksCatalog" && d.catalog == "remote"
                        }
                        CatalogIntegration::Codex => {
                            d.source == "codexAcp" && d.catalog == "adapter"
                        }
                    }
            })
        {
            return Err(ModelError::new("unavailable", "Account model availability could not be verified. Refresh models before creating the agent."));
        }
        let selected = self.models.iter().find(|m| m.id == model).ok_or_else(|| {
            ModelError::new(
                "model",
                "The selected model ID is unavailable. Refresh models and select a listed model.",
            )
        })?;
        if let Some(error) = &selected.error {
            return Err(ModelError::new("model", error.clone()));
        }
        let valid = match (&selected.effort, effort) {
            (EffortOptions::Unsupported, EffortSelection::Unsupported) => true,
            (EffortOptions::Supported { options }, EffortSelection::Value { value }) => {
                options.iter().any(|o| o.value == *value)
            }
            _ => false,
        };
        if !valid {
            return Err(ModelError::new("effort", "Choose an effort advertised for the selected model, or Not supported when explicitly reported."));
        }
        Ok(())
    }
}

impl ModelHost {
    pub(crate) fn new(root: Result<PathBuf, String>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                root,
                next: 0,
                pending: None,
                closed: false,
            })),
            factory: Arc::new(RuntimeFactory),
        }
    }
    // Creation waits for the existing discovery owner to retire. Keep one lane,
    // so credential work and child cleanup cannot overlap a second session.
    async fn begin_creation(&self) -> Result<u64, ModelError> {
        tokio::time::timeout(Duration::from_secs(185), async {
            loop {
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| ModelError::new("cancelled", CANCELLED))?;
                    if state.closed {
                        return Err(ModelError::new("cancelled", CANCELLED));
                    }
                    if state.pending.as_ref().map_or(true, |p| {
                        p.abort.is_none() && p.created.elapsed() > Duration::from_secs(15)
                    }) {
                        return Self::reserve(&mut state).map_err(ModelError::from);
                    }
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .map_err(|_| {
            ModelError::new(
                "timeout",
                "Model discovery is still busy. Cancel it or wait, then retry Create.",
            )
        })?
    }
    fn begin(&self) -> Result<u64, String> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        Self::reserve(&mut state)
    }
    fn reserve(state: &mut State) -> Result<u64, String> {
        if state.closed {
            return Err(CANCELLED.into());
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|p| p.abort.is_none() && p.created.elapsed() > Duration::from_secs(15))
        {
            state.pending = None;
        }
        if state.pending.is_some() {
            return Err("Another model connection request is in progress; cancel it first".into());
        }
        state.next = state
            .next
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(CANCELLED)?;
        let id = state.next;
        state.pending = Some(Ticket {
            id,
            abort: None,
            cancelled: false,
            created: std::time::Instant::now(),
        });
        Ok(id)
    }
    fn cancel(&self, ticket: u64) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if let Some(pending) = state.pending.as_mut().filter(|p| p.id == ticket) {
            pending.cancelled = true;
            if let Some(abort) = &pending.abort {
                // Keep admission occupied until JoinHandle confirms the future
                // (including callback/credential work) has actually been dropped.
                abort.abort();
            } else {
                state.pending = None;
            }
        }
        Ok(())
    }
    pub(crate) fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            if let Some(pending) = state.pending.take() {
                if let Some(abort) = pending.abort {
                    abort.abort();
                }
            }
        }
    }
    async fn run(
        &self,
        ticket: u64,
        work: impl std::future::Future<Output = Result<Catalog, ModelError>> + Send + 'static,
    ) -> Result<Catalog, ModelError> {
        let task = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| ModelError::new("cancelled", CANCELLED))?;
            let pending = state
                .pending
                .as_mut()
                .filter(|p| {
                    p.id == ticket
                        && p.abort.is_none()
                        && !p.cancelled
                        && p.created.elapsed() < Duration::from_secs(15)
                })
                .ok_or_else(|| ModelError::new("cancelled", CANCELLED))?;
            let task = tokio::spawn(async move {
                tokio::time::timeout(Duration::from_secs(180), work)
                    .await
                    .map_err(|_| {
                        ModelError::new("timeout", "Connection timed out; retry explicitly")
                    })?
            });
            pending.abort = Some(task.abort_handle());
            task
        };
        // The supervisor owns retirement even if the IPC response future is
        // dropped. Only the worker is abortable; admission reopens AFTER drop.
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = task
                .await
                .map_err(|_| ModelError::new("cancelled", CANCELLED))
                .and_then(|r| r);
            let result = (|| {
                let mut state = owner
                    .state
                    .lock()
                    .map_err(|_| ModelError::new("cancelled", CANCELLED))?;
                if !state.pending.as_ref().is_some_and(|p| p.id == ticket) {
                    return Err(ModelError::new("cancelled", CANCELLED));
                }
                let cancelled = state.pending.as_ref().is_some_and(|p| p.cancelled) || state.closed;
                state.pending = None;
                if cancelled {
                    Err(ModelError::new("cancelled", CANCELLED))
                } else {
                    result
                }
            })();
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| ModelError::new("cancelled", CANCELLED))?
    }
    fn cache(&self, _host: &str) -> Result<PathBuf, String> {
        let state = self.state.lock().map_err(|_| CANCELLED)?;
        oauth_root(&state.root.clone()?)
    }
}
struct Headless;
impl BrowserOpener for Headless {
    fn open(&self, _: &str) -> Result<(), String> {
        Err("Sign in using Browse models before creating the agent".into())
    }
}
struct Opener<R: tauri::Runtime>(tauri::AppHandle<R>);
impl<R: tauri::Runtime> BrowserOpener for Opener<R> {
    fn open(&self, url: &str) -> Result<(), String> {
        self.0
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Could not open the sign-in browser".into())
    }
}
#[tauri::command]
pub(crate) fn agent_models_begin(state: tauri::State<'_, ModelHost>) -> Result<u64, String> {
    state.begin()
}
#[tauri::command]
pub(crate) fn agent_models_cancel(
    state: tauri::State<'_, ModelHost>,
    ticket: u64,
) -> Result<(), String> {
    state.cancel(ticket)
}
#[tauri::command]
pub(crate) async fn agent_models_run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, ModelHost>,
    agents: tauri::State<'_, crate::agents::AgentHost>,
    ticket: u64,
    request: Request,
) -> Result<Catalog, ModelError> {
    if matches!(request.integration, Integration::Codex) {
        let host = state.inner().clone();
        let prepared = request
            .edit
            .clone()
            .ok_or_else(|| "Agent draft is required for model lookup".to_owned())
            .and_then(|edit| {
                let selected = edit.harness.model.clone();
                agents
                    .model_context(request.id.as_deref(), request.expected_revision, edit)
                    .and_then(|context| {
                        context
                            .codex
                            .ok_or("Choose the Codex harness for Codex discovery".into())
                    })
                    .map(|context| (context, selected))
            });
        return host.run(ticket, async move {
            if request.action != Operation::Refresh { return Err(ModelError::new("configuration", "Use codex login in your terminal, then Refresh models. Buzz does not log out or replace your shared Codex account.")); }
            let (context, _) = prepared?;
            codex::discover(context, None).await
        }).await;
    }
    let Integration::Databricks(settings) = &request.integration else {
        return Err("Unsupported integration".into());
    };
    let host = state.inner().clone();
    let controller = agents.inner().clone();
    // Disconnect is recovery: changing provider or breaking saved settings must
    // not trap credentials. Its explicit host selects ONLY this app's cache.
    let prepared = if request.action == Operation::Disconnect {
        controller
            .ensure_open()
            .and_then(|_| origin(&settings.host))
            .and_then(|workspace| {
                host.cache(&workspace)
                    .map(|cache| (false, workspace, None, cache))
            })
    } else {
        // Short settings read only; never hold the controller across network waits.
        request
            .edit
            .clone()
            .ok_or_else(|| "Agent draft is required for model lookup".to_owned())
            .and_then(|edit| {
                controller.model_context(request.id.as_deref(), request.expected_revision, edit)
            })
            .and_then(|context| {
                resolve(settings, &context)
                    .map(|(workspace, filter)| (context.model_overridden, workspace, filter))
            })
            .and_then(|(overridden, workspace, filter)| {
                host.cache(&workspace)
                    .map(|cache| (overridden, workspace, filter, cache))
            })
    };
    let factory = state.factory.clone();
    host.run(ticket, async move {
        let (model_overridden, workspace, filter, cache) = prepared?;
        if request.action == Operation::Disconnect {
            controller.disconnect(&workspace)?;
            return Ok(Catalog {
                defaults: None,
                integration: CatalogIntegration::Databricks { host: workspace },
                models: vec![],
                discovery: None,
                model_overridden,
                disconnected: true,
            });
        }
        execute(
            request.action,
            workspace,
            filter,
            cache,
            model_overridden,
            factory,
            Arc::new(Opener(app)),
        )
        .await
    })
    .await
}

#[cfg(test)]
use buzz_agent::{config::DatabricksModelFilter, AgentError};
#[cfg(test)]
use databricks::{Connection, RuntimeConnection};
#[cfg(test)]
mod tests;

#[cfg(test)]
mod bundled_tests;
