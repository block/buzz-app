//! Databricks-specific authentication, settings and catalog projection.
use super::{Catalog, CatalogIntegration, Discovery, EffortOptions, Model, ModelError, Operation};
use buzz_agent::{
    auth::{BrowserOpener, PkceOAuthConfig, PkceOAuthTokenSource},
    config::{Config, DatabricksModelFilter, Provider},
    AgentError,
};
use buzz_agent_controller::connection::origin;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    pub host: String,
    pub filter: String,
}

mod defaults {
    include!(concat!(env!("OUT_DIR"), "/agent_defaults.rs"));
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Defaults {
    pub(super) host: String,
    pub(super) filter: String,
}
pub(crate) fn defaults() -> Defaults {
    Defaults {
        host: defaults::HOST.into(),
        filter: defaults::FILTER.into(),
    }
}
pub(super) fn resolve(
    request: &Settings,
    context: &buzz_agent_controller::ModelContext,
) -> Result<(String, Option<DatabricksModelFilter>), String> {
    if request.host.len() > 4096 || request.filter.len() > 4096 {
        return Err("Connection settings are too long".into());
    }
    let host = origin(context.host.as_deref().unwrap_or(&request.host))?;
    if context.host.is_some() && origin(&request.host)? != host {
        return Err("Workspace conflicts with the saved/draft DATABRICKS_HOST override; use that workspace or edit the override".into());
    }
    if context
        .filter
        .as_ref()
        .is_some_and(|v| v != &request.filter)
    {
        return Err("Filter conflicts with the saved/draft DATABRICKS_MODEL_FILTER override; edit the override or match it explicitly".into());
    }
    let filter = DatabricksModelFilter::parse(Some(&request.filter))
        .map_err(|_| "Invalid model filter".to_owned())?;
    Ok((host, filter))
}
// Production reuses the immutable engine with its existing auth policy. Tests replace only the
// network/auth transport behind the same command admission and operation logic.
pub(super) trait Connection: Send + Sync {
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
pub(super) trait Factory: Send + Sync {
    fn open(
        &self,
        workspace: &str,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Box<dyn Connection>, String>;
}
pub(super) struct RuntimeFactory;
pub(super) struct RuntimeConnection {
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
    pub(super) fn new(
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
pub(super) async fn execute(
    action: Operation,
    workspace: String,
    filter: Option<DatabricksModelFilter>,
    cache: PathBuf,
    model_overridden: bool,
    factory: Arc<dyn Factory>,
    opener: Arc<dyn BrowserOpener>,
) -> Result<Catalog, ModelError> {
    let connection = factory.open(&workspace, &cache, opener.clone())?;
    // The picker is user intent to discover models, not a mandatory login ceremony.
    // Reuse/refresh cached credentials first; unrelated failures must never open SSO.
    let entries = match connection.models(filter.clone()).await {
        Err(AgentError::LlmAuth(_)) if action == Operation::Connect => {
            // Discovery may have invalidated a rejected token on disk. Reopen after
            // that verdict rather than retaining a pre-discovery in-memory token.
            let connection = factory.open(&workspace, &cache, opener)?;
            connection.connect().await.map_err(|_| {
                ModelError::new(
                    "authentication",
                    "Sign-in was not completed. Choose Connect account when ready",
                )
            })?;
            connection.models(filter).await
        }
        result => result,
    }
    .map_err(|error| match error {
        AgentError::LlmAuth(_) => ModelError::new(
            "authentication",
            "Sign-in required. Choose Connect account to sign in",
        ),
        _ => ModelError::new(
            "unavailable",
            "Models unavailable. Check the workspace, filter or network and retry",
        ),
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
        defaults: None,
        integration: CatalogIntegration::Databricks { host: workspace },
        models,
        discovery: Some(Discovery {
            source: "databricksCatalog",
            authentication: "authenticated",
            catalog: "remote",
        }),
        model_overridden,
        disconnected: false,
    })
}
