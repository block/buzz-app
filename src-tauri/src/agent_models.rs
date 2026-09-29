//! Native connection owner. No work on snapshot/render; only an explicit ticket
//! admits auth/catalog work. This lock is independent of agent Save/Stop.
use buzz_agent::{
    auth::{BrowserOpener, PkceOAuthConfig, PkceOAuthTokenSource},
    config::{Config, DatabricksModelFilter, Provider},
    AgentError,
};
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
mod openai;
pub(crate) use contracts::ModelError;
use contracts::{Discovery, EffortOptions};

const CANCELLED: &str = "Connection request cancelled or expired";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Defaults {
    host: String,
    filter: String,
}
pub(crate) fn defaults() -> Defaults {
    let defaults = buzz_agent_controller::build_defaults();
    Defaults {
        host: defaults.host,
        filter: defaults.filter,
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    content = "settings",
    rename_all = "lowercase",
    deny_unknown_fields
)]
enum Integration {
    Openai(openai::Settings),
    Databricks(DatabricksSettings),
    Codex,
    Goose,
    Pi,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DatabricksSettings {
    host: String,
    filter: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: Option<String>,
    expected_revision: Option<u64>,
    edit: Option<AgentEdit>,
    #[serde(default)]
    integration: Option<Integration>,
    #[serde(default)]
    host: String,
    #[serde(default)]
    filter: String,
    action: Operation,
    /// Blank host/filter are inherited from write-only Agent defaults the UI
    /// cannot see, so native supplies them instead of treating blank as explicit.
    #[serde(default)]
    inherit_workspace: bool,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Connect,
    Refresh,
    Disconnect,
    /// Pi only: one tiny prompt with the draft's provider and model.
    Test,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    integration: CatalogIntegration,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    models: Vec<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    defaults: Option<ResolvedDefaults>,
    #[serde(skip_serializing_if = "Option::is_none")]
    discovery: Option<Discovery>,
    model_overridden: bool,
    disconnected: bool,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CatalogIntegration {
    Openai,
    Databricks { host: String },
    Codex,
    Goose,
    Pi,
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
    openai_endpoint: String,
}
impl ModelHost {
    /// Headless preflight, before identity generation. Never opens a browser.
    pub(crate) async fn validate_creation(&self, edit: &AgentEdit) -> Result<(), ModelError> {
        use buzz_agent_controller::{AiConfiguration, Controller};
        if edit.harness.configuration.is_none() {
            return Ok(());
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
        if edit.harness.command == "buzz-agent" && edit.harness.provider == "openai" {
            buzz_agent_controller::openai::validate_selection(&edit.harness)?;
            let context = Controller::draft_model_context(edit.clone())?
                .openai
                .ok_or("Choose Buzz Agent with Open AI")?;
            let ticket = self.begin_creation().await?;
            let catalog = self
                .run(
                    ticket,
                    openai::execute(
                        context,
                        openai::Settings::default(),
                        Operation::Refresh,
                        self.openai_endpoint.clone(),
                    ),
                )
                .await?;
            return catalog.validate_selection(
                &edit.harness.model,
                &buzz_agent_controller::EffortSelection::Default,
            );
        }
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
        // Goose and Pi retain their established configuration semantics.
        if matches!(
            std::path::Path::new(&edit.harness.command)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("goose" | "buzz-pi-acp")
        ) {
            return Ok(());
        }
        let Some(AiConfiguration::Advanced { effort }) = &edit.harness.configuration else {
            return Ok(());
        };
        let context = Controller::draft_model_context(edit.clone())?;
        let settings = edit.harness.databricks.as_ref();
        let defaults = defaults();
        let request = Request {
            id: None,
            expected_revision: None,
            edit: None,
            integration: None,
            host: settings
                .map(|settings| settings.host.clone())
                .unwrap_or(defaults.host),
            filter: settings
                .map(|settings| settings.filter.clone())
                .unwrap_or(defaults.filter),
            action: Operation::Refresh,
            inherit_workspace: false,
        };
        let (workspace, filter) = resolve(&request, &context)?;
        let cache = self.cache(&workspace)?;
        let factory = self.factory.clone();
        let ticket = self.begin_creation().await?;
        let catalog = self
            .run(ticket, async move {
                execute(
                    Operation::Refresh,
                    workspace,
                    filter,
                    cache,
                    false,
                    factory,
                    Arc::new(Headless),
                )
                .await
                .map_err(ModelError::from)
            })
            .await?;
        catalog.validate_selection(&edit.harness.model, effort)
    }

    pub(crate) fn new(root: Result<PathBuf, String>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                root,
                next: 0,
                pending: None,
                closed: false,
            })),
            factory: Arc::new(RuntimeFactory),
            openai_endpoint: "https://api.openai.com/v1/models".into(),
        }
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
                    if state.pending.as_ref().map_or(true, |pending| {
                        pending.abort.is_none()
                            && pending.created.elapsed() > Duration::from_secs(15)
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
                .and_then(|result| result);
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
impl Catalog {
    fn validate_selection(
        &self,
        model: &str,
        effort: &buzz_agent_controller::EffortSelection,
    ) -> Result<(), ModelError> {
        use buzz_agent_controller::EffortSelection;
        if self.disconnected
            || !self.discovery.as_ref().is_some_and(|discovery| {
                discovery.authentication == "authenticated"
                    && match self.integration {
                        CatalogIntegration::Openai => {
                            discovery.source == "openaiCatalog" && discovery.catalog == "remote"
                        }
                        CatalogIntegration::Databricks { .. } => {
                            discovery.source == "databricksCatalog" && discovery.catalog == "remote"
                        }
                        CatalogIntegration::Codex => {
                            discovery.source == "codexAcp" && discovery.catalog == "adapter"
                        }
                        _ => false,
                    }
            })
        {
            return Err(ModelError::new(
                "unavailable",
                "Account model availability could not be verified. Refresh models before creating the agent.",
            ));
        }
        let selected = self
            .models
            .iter()
            .find(|entry| entry.id == model)
            .ok_or_else(|| {
                ModelError::new(
                "model",
                "The selected model ID is unavailable. Refresh models and select a listed model.",
            )
            })?;
        if let Some(error) = &selected.error {
            return Err(ModelError::new("model", error.clone()));
        }
        let valid = match (&selected.effort, effort) {
            (EffortOptions::Default, EffortSelection::Default) => true,
            (EffortOptions::Unsupported, EffortSelection::Unsupported) => true,
            (EffortOptions::Supported { options }, EffortSelection::Value { value }) => {
                options.iter().any(|option| option.value == *value)
            }
            _ => false,
        };
        if !valid {
            return Err(ModelError::new(
                "effort",
                "Choose an effort advertised for the selected model, or Not supported when explicitly reported.",
            ));
        }
        Ok(())
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
fn resolve(
    request: &Request,
    context: &buzz_agent_controller::ModelContext,
) -> Result<(String, Option<DatabricksModelFilter>), String> {
    if request.host.len() > 4096 || request.filter.len() > 4096 {
        return Err("Connection settings are too long".into());
    }
    // An explicit agent workspace/filter must never be replaced by an inherited
    // default, even if a caller sends inheritWorkspace with blank request fields.
    let can_inherit = request.inherit_workspace
        && request
            .edit
            .as_ref()
            .is_some_and(|edit| edit.harness.databricks.is_none());
    let defer = |value: &str| can_inherit && value.is_empty();
    let host = origin(context.host.as_deref().unwrap_or(&request.host))?;
    if context.host.is_some() && !defer(&request.host) && origin(&request.host)? != host {
        return Err("Workspace conflicts with the saved/draft DATABRICKS_HOST override; use that workspace or edit the override".into());
    }
    let filter = match &context.filter {
        Some(native) if defer(&request.filter) => native,
        Some(native) if native != &request.filter => {
            return Err("Filter conflicts with the saved/draft DATABRICKS_MODEL_FILTER override; edit the override or match it explicitly".into());
        }
        _ => &request.filter,
    };
    let filter = DatabricksModelFilter::parse(Some(filter))
        .map_err(|_| "Invalid model filter".to_owned())?;
    Ok((host, filter))
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
    mut request: Request,
) -> Result<Catalog, ModelError> {
    let host = state.inner().clone();
    let controller = agents.inner().clone();
    if matches!(request.integration.as_ref(), Some(Integration::Openai(_))) {
        let Some(Integration::Openai(settings)) = request.integration.take() else {
            return Err(ModelError::new(
                "configuration",
                "Open AI integration settings are missing",
            ));
        };
        let prepared = match request.edit.take() {
            Some(edit) => controller
                .model_context(request.id.as_deref(), request.expected_revision, edit)
                .await
                .map_err(ModelError::from)
                .and_then(|context| {
                    context.openai.ok_or_else(|| {
                        ModelError::new("configuration", "Choose Buzz Agent with Open AI")
                    })
                }),
            None => Err(ModelError::new(
                "configuration",
                "Agent draft is required for Open AI setup",
            )),
        };
        let endpoint = state.openai_endpoint.clone();
        return host
            .run(ticket, async move {
                openai::execute(prepared?, settings, request.action, endpoint).await
            })
            .await;
    }
    if matches!(request.integration.as_ref(), Some(Integration::Codex)) {
        let advanced = request.edit.as_ref().is_some_and(|edit| {
            matches!(
                edit.harness.configuration,
                Some(buzz_agent_controller::AiConfiguration::Advanced { .. })
            )
        });
        let selected = if advanced { None } else { Some(String::new()) };
        let prepared = match request.edit.clone() {
            Some(edit) => controller
                .model_context(request.id.as_deref(), request.expected_revision, edit)
                .await
                .map_err(ModelError::from)
                .and_then(|context| {
                    context.codex.ok_or_else(|| {
                        ModelError::new(
                            "configuration",
                            "Choose the Codex harness for Codex discovery",
                        )
                    })
                }),
            None => Err(ModelError::new(
                "configuration",
                "Agent draft is required for model lookup",
            )),
        };
        return host
            .run(ticket, async move {
                if request.action != Operation::Refresh {
                    return Err(ModelError::new(
                        "configuration",
                        "Use codex login in your terminal, then Refresh models. Buzz does not log out or replace your shared Codex account.",
                    ));
                }
                codex::discover(prepared?, selected).await
            })
            .await;
    }
    if let Some(Integration::Databricks(settings)) = request.integration.take() {
        request.host = settings.host;
        request.filter = settings.filter;
    }
    let pi = matches!(request.integration.as_ref(), Some(Integration::Pi))
        || request.edit.as_ref().is_some_and(|edit| {
            std::path::Path::new(&edit.harness.command)
                .file_name()
                .and_then(|name| name.to_str())
                == Some("buzz-pi-acp")
        });
    if pi {
        let edit = request.edit.clone().ok_or_else(|| {
            ModelError::new(
                "configuration",
                "Agent draft is required for Pi model lookup",
            )
        })?;
        let prepared = controller
            .pi_model_context(
                request.id.as_deref(),
                request.expected_revision,
                edit.clone(),
            )
            .await
            .map_err(ModelError::from);
        return host
            .run(ticket, async move {
                if request.action == Operation::Disconnect {
                    return Err(ModelError::new(
                        "configuration",
                        "Pi credentials are managed by Pi",
                    ));
                }
                let context = prepared?;
                if request.action == Operation::Test {
                    let harness = &edit.harness;
                    crate::pi_models::test(context, &harness.provider, &harness.model).await?;
                    return Ok(Catalog {
                        integration: CatalogIntegration::Pi,
                        host: Some(String::new()),
                        models: vec![],
                        defaults: None,
                        discovery: None,
                        model_overridden: false,
                        disconnected: false,
                    });
                }
                let models = crate::pi_models::fetch(context)
                    .await?
                    .into_iter()
                    .map(|id| Model {
                        name: id.clone(),
                        id,
                        effort: EffortOptions::Unknown,
                        error: None,
                    })
                    .collect();
                Ok(Catalog {
                    integration: CatalogIntegration::Pi,
                    host: Some(String::new()),
                    models,
                    defaults: None,
                    discovery: None,
                    model_overridden: false,
                    disconnected: false,
                })
            })
            .await;
    }
    if request.action == Operation::Test {
        return host
            .run(ticket, async {
                Err(ModelError::new(
                    "configuration",
                    "Connection tests are only available for Pi",
                ))
            })
            .await;
    }
    let goose = matches!(request.integration.as_ref(), Some(Integration::Goose))
        || request.edit.as_ref().is_some_and(|edit| {
            std::path::Path::new(&edit.harness.command)
                .file_name()
                .and_then(|name| name.to_str())
                == Some("goose")
        });
    if goose {
        // Goose's catalog handler may start OAuth on a cache miss. Only the
        // explicit Browse/Retry action may invoke it; Refresh stays headless.
        if request.action != Operation::Connect {
            return host
                .run(ticket, async {
                    Err(ModelError::new(
                        "configuration",
                        "Goose model lookup requires explicit Browse or Retry",
                    ))
                })
                .await;
        }
        let prepared = match request.edit.clone() {
            Some(edit) => {
                controller
                    .goose_model_context(request.id.as_deref(), request.expected_revision, edit)
                    .await
            }
            None => Err("Agent draft is required for model lookup".to_owned()),
        };
        return host
            .run(ticket, async move {
                let context = prepared.map_err(ModelError::from)?;
                let model_overridden = context.model_overridden;
                let models = crate::goose_models::fetch(context)
                    .await?
                    .into_iter()
                    .map(|id| Model {
                        name: id.clone(),
                        id,
                        effort: EffortOptions::Unknown,
                        error: None,
                    })
                    .collect();
                Ok(Catalog {
                    integration: CatalogIntegration::Goose,
                    host: Some(String::new()),
                    models,
                    defaults: None,
                    discovery: None,
                    model_overridden,
                    disconnected: false,
                })
            })
            .await;
    }
    // Disconnect is recovery: changing provider or breaking saved settings must
    // not trap credentials. Its explicit host selects ONLY this app's cache.
    let prepared = if request.action == Operation::Disconnect {
        // An inherited workspace is sent blank; native resolves it from Agent
        // defaults without the draft, so recovery survives invalid settings.
        let named = if request.inherit_workspace && request.host.is_empty() {
            controller
                .inherited_workspace()
                .await
                .and_then(|workspace| {
                    workspace.ok_or_else(|| {
                        "Agent defaults no longer set a Databricks workspace".to_owned()
                    })
                })
        } else {
            controller.ensure_open().await.map(|_| request.host.clone())
        };
        named
            .and_then(|named| origin(&named))
            .and_then(|workspace| {
                host.cache(&workspace)
                    .map(|cache| (false, workspace, None, cache))
            })
    } else {
        // Short settings read only; never hold the controller across network waits.
        let context = match request.edit.clone() {
            Some(edit) => {
                controller
                    .model_context(request.id.as_deref(), request.expected_revision, edit)
                    .await
            }
            None => Err("Agent draft is required for model lookup".to_owned()),
        };
        context
            .and_then(|context| {
                resolve(&request, &context)
                    .map(|(workspace, filter)| (context.model_overridden, workspace, filter))
            })
            .and_then(|(overridden, workspace, filter)| {
                host.cache(&workspace)
                    .map(|cache| (overridden, workspace, filter, cache))
            })
    };
    let factory = state.factory.clone();
    let hide_inherited_host = request.inherit_workspace && request.host.is_empty();
    host.run(ticket, async move {
        let (model_overridden, workspace, filter, cache) = prepared.map_err(ModelError::from)?;
        if request.action == Operation::Disconnect {
            controller
                .disconnect(&workspace)
                .await
                .map_err(ModelError::from)?;
            return Ok(Catalog {
                integration: CatalogIntegration::Databricks {
                    host: workspace.clone(),
                },
                host: Some(if hide_inherited_host {
                    String::new()
                } else {
                    workspace
                }),
                models: vec![],
                defaults: None,
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
        .map_err(ModelError::from)
    })
    .await
    .map(|mut catalog| {
        // The native connection uses the inherited write-only environment;
        // the catalog projection must not reveal its workspace URL to the UI.
        if hide_inherited_host {
            if let Some(host) = catalog.host.as_mut() {
                host.clear();
            }
            if let CatalogIntegration::Databricks { host } = &mut catalog.integration {
                host.clear();
            }
        }
        catalog
    })
}

// Production reuses the immutable engine with its existing auth policy. Tests replace only the
// network/auth transport behind the same command admission and operation logic.
trait Connection: Send + Sync {
    fn connect(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>;
    fn models(
        &self,
        filter: Option<DatabricksModelFilter>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Vec<buzz_agent::catalog::ModelEntry>, AgentError>,
                > + Send
                + '_,
        >,
    >;
}
trait Factory: Send + Sync {
    fn open(
        &self,
        workspace: &str,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Box<dyn Connection>, String>;
}
struct RuntimeFactory;
struct RuntimeConnection {
    workspace: String,
    cache: PathBuf,
    auth: Arc<PkceOAuthTokenSource>,
}
impl Factory for RuntimeFactory {
    fn open(
        &self,
        workspace: &str,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Box<dyn Connection>, String> {
        let workspace = origin(workspace)?;
        Ok(Box::new(RuntimeConnection::new(workspace, cache, opener)?))
    }
}
impl RuntimeConnection {
    fn new(
        workspace: String,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Self, String> {
        // Match the pinned runtime's discovery/client/scopes/namespace exactly.
        // Do not call the convenience wrapper: its default opener logs the URL.
        let auth = PkceOAuthTokenSource::new_with(
            PkceOAuthConfig {
                discovery_url: format!("{workspace}/oidc/.well-known/oauth-authorization-server"),
                client_id: "databricks-cli".into(),
                scopes: vec!["all-apis".into(), "offline_access".into()],
                cache_namespace: "databricks".into(),
                cache_dir_override: Some(cache.to_path_buf()),
            },
            opener,
        )
        .map_err(|_| "Could not open the app-isolated Databricks connection")?;
        Ok(Self {
            workspace,
            cache: cache.into(),
            auth,
        })
    }
}
impl Connection for RuntimeConnection {
    fn connect(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async {
            self.auth
                .interactive_login()
                .await
                .map_err(|_| "Sign-in was not completed. Choose Retry models when ready".into())
        })
    }
    fn models(
        &self,
        filter: Option<DatabricksModelFilter>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Vec<buzz_agent::catalog::ModelEntry>, AgentError>,
                > + Send
                + '_,
        >,
    > {
        Box::pin(async {
            let config = Config::for_discovery(
                Provider::DatabricksV2,
                String::new(),
                self.workspace.clone(),
                filter,
            );
            buzz_agent::discover_databricks_models_with_cache_dir(&config, Some(&self.cache)).await
        })
    }
}
async fn execute(
    action: Operation,
    workspace: String,
    filter: Option<DatabricksModelFilter>,
    cache: PathBuf,
    model_overridden: bool,
    factory: Arc<dyn Factory>,
    opener: Arc<dyn BrowserOpener>,
) -> Result<Catalog, String> {
    let connection = factory.open(&workspace, &cache, opener.clone())?;
    // The picker is user intent to discover models, not a mandatory login ceremony.
    // Reuse/refresh cached credentials first; unrelated failures must never open SSO.
    let entries = match connection.models(filter.clone()).await {
        Err(AgentError::LlmAuth(_)) if action == Operation::Connect => {
            // Discovery may have invalidated a rejected token on disk. Reopen after
            // that verdict rather than retaining a pre-discovery in-memory token.
            let connection = factory.open(&workspace, &cache, opener)?;
            connection.connect().await?;
            connection.models(filter).await
        }
        result => result,
    }
    .map_err(|error| match error {
        AgentError::LlmAuth(_) => "Sign-in required. Choose Retry models to sign in".to_owned(),
        _ => "Models unavailable. Check the workspace, filter or network and retry".to_owned(),
    })?;
    if entries.len() > 10_000
        || entries.iter().any(|m| {
            m.id.len() > 512
                || m.name.len() > 1024
                || m.id.chars().any(char::is_control)
                || m.name.chars().any(char::is_control)
        })
    {
        return Err("Model catalog exceeds the app's safe display limits; use a narrower filter or custom ID".into());
    }
    // Upstream's explicitly labelled authenticated-empty defaults are NOT
    // discovered IDs. Keep custom entry, show empty instead of guessing models.
    let models = entries
        .into_iter()
        .filter(|m| !m.name.ends_with(" (default catalog)"))
        .map(|m| Model {
            id: m.id,
            name: m.name,
            effort: EffortOptions::Unsupported,
            error: None,
        })
        .collect();
    Ok(Catalog {
        integration: CatalogIntegration::Databricks {
            host: workspace.clone(),
        },
        host: Some(workspace),
        models,
        defaults: None,
        discovery: Some(Discovery {
            source: "databricksCatalog",
            authentication: "authenticated",
            catalog: "remote",
        }),
        model_overridden,
        disconnected: false,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod bundled_tests;
