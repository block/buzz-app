//! Bounded official OpenAI catalog requests; persistence belongs to agent Save.
use super::{Catalog, CatalogIntegration, Discovery, EffortOptions, Model, ModelError, Operation};
use buzz_agent_controller::openai::{validate_key, Context};
use serde::Deserialize;
use std::{collections::HashSet, time::Duration};
use zeroize::{Zeroize, Zeroizing};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Settings {
    api_key: Option<String>,
}
impl Drop for Settings {
    fn drop(&mut self) {
        if let Some(key) = self.api_key.as_mut() {
            key.zeroize();
        }
    }
}

pub(super) async fn execute(
    context: Context,
    settings: Settings,
    operation: Operation,
    endpoint: String,
) -> Result<Catalog, ModelError> {
    if operation == Operation::Disconnect
        || (settings.api_key.is_some() && operation != Operation::Connect)
    {
        return Err(ModelError::new(
            "configuration",
            "Submit a key explicitly or refresh the saved key. Open AI setup does not revoke keys.",
        ));
    }
    let key = if let Some(key) = settings.api_key.as_ref() {
        Zeroizing::new(key.clone())
    } else {
        context.api_key.ok_or_else(|| {
            ModelError::new("authentication", "Enter an Open AI API key to load models")
        })?
    };
    validate_key(&key).map_err(|message| ModelError::new("authentication", message))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| ModelError::new("unavailable", "Could not initialize Open AI connection"))?;
    let mut response = client
        .get(endpoint)
        .bearer_auth(key.as_str())
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => ModelError::new(
                "authentication",
                "Open AI rejected this key or its model-list permission. Check the key and retry.",
            ),
            429 => ModelError::new(
                "unavailable",
                "Open AI rate-limited model lookup. Retry later.",
            ),
            _ => ModelError::new(
                "unavailable",
                "Open AI model lookup failed. Retry explicitly.",
            ),
        });
    }
    const MAX_BYTES: usize = 2 * 1024 * 1024;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(ModelError::new(
                "unavailable",
                "Open AI returned an oversized model catalog",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let models = parse_models(&bytes, &key)?;
    Ok(Catalog {
        integration: CatalogIntegration::Openai,
        models,
        defaults: None,
        discovery: Some(Discovery {
            source: "openaiCatalog",
            authentication: "authenticated",
            catalog: "remote",
        }),
        model_overridden: false,
        disconnected: false,
    })
}

fn network_error(error: reqwest::Error) -> ModelError {
    if error.is_timeout() {
        ModelError::new(
            "timeout",
            "Open AI model lookup timed out. Retry explicitly.",
        )
    } else {
        ModelError::new(
            "unavailable",
            "Could not reach Open AI. Check the connection and retry.",
        )
    }
}

fn parse_models(bytes: &[u8], key: &str) -> Result<Vec<Model>, ModelError> {
    #[derive(Deserialize)]
    struct List {
        object: String,
        data: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        object: String,
    }
    let invalid = || ModelError::new("unavailable", "Open AI returned an invalid model catalog");
    let list: List = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if list.object != "list" || list.data.len() > 10_000 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for entry in list.data {
        if entry.object != "model"
            || entry.id.is_empty()
            || entry.id.len() > 512
            || !entry.id.bytes().all(|b| b.is_ascii_graphic())
            || entry.id.contains(key)
        {
            return Err(invalid());
        }
        if seen.insert(entry.id.clone()) {
            models.push(Model {
                name: entry.id.clone(),
                id: entry.id,
                effort: EffortOptions::Default,
                error: None,
            });
        }
    }
    Ok(models)
}

#[cfg(test)]
mod tests;
