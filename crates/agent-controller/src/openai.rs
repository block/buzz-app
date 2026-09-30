//! Official OpenAI setup for the bundled Buzz Agent. No ambient credentials.
use crate::{HarnessEdit, Result};
use std::{collections::BTreeMap, process::Command};

/// Validate a submitted key without returning its contents in errors.
pub fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 4096 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(
            "Enter a nonempty Open AI API key without whitespace (at most 4096 bytes)".into(),
        );
    }
    Ok(())
}

/// Check the provider boundary before any credential read or network operation.
pub struct Context {
    /// The key resolved from agent environment settings, never returned in snapshots.
    pub api_key: Option<zeroize::Zeroizing<String>>,
}

/// Resolve the provider key from the existing agent environment settings.
pub fn context(harness: &HarnessEdit, environment: &BTreeMap<String, String>) -> Result<Context> {
    if harness.command != "buzz-agent" || harness.provider != "openai" || !harness.args.is_empty() {
        return Err("Open AI key setup requires the bundled Buzz Agent, Open AI provider, and no custom arguments".into());
    }
    if environment.keys().any(|name| {
        let upper = name.to_ascii_uppercase();
        (upper.starts_with("OPENAI_") && name != "OPENAI_COMPAT_API_KEY")
            || matches!(
                upper.as_str(),
                "BUZZ_AGENT_PROVIDER"
                    | "BUZZ_AGENT_MODEL"
                    | "BUZZ_AGENT_THINKING_EFFORT"
                    | "HTTP_PROXY"
                    | "HTTPS_PROXY"
                    | "ALL_PROXY"
            )
            || upper.starts_with("BUZZ_ACP_")
    }) {
        return Err("Remove Open AI/provider/model/effort or proxy environment overrides before using managed Open AI setup".into());
    }
    Ok(Context {
        api_key: environment
            .get("OPENAI_COMPAT_API_KEY")
            .cloned()
            .map(zeroize::Zeroizing::new),
    })
}

/// Require an explicit model and delegate effort without guessing capabilities.
pub fn validate_selection(harness: &HarnessEdit) -> Result<()> {
    if !matches!(
        harness.configuration,
        Some(crate::AiConfiguration::Advanced {
            effort: crate::EffortSelection::Default
        })
    ) || harness.model.trim().is_empty()
    {
        return Err("Open AI requires an explicit model with effort at Runtime default".into());
    }
    Ok(())
}

pub(crate) fn apply(
    harness: &HarnessEdit,
    environment: &BTreeMap<String, String>,
    command: &mut Command,
) -> Result<()> {
    // Imported/legacy agents retain their existing environment and argv semantics.
    // The explicit Runtime-default selection opts into the managed setup contract.
    if harness.command != "buzz-agent"
        || harness.provider != "openai"
        || !matches!(
            harness.configuration,
            Some(crate::AiConfiguration::Advanced {
                effort: crate::EffortSelection::Default
            })
        )
    {
        return Ok(());
    }
    let context = context(harness, environment)?;
    validate_selection(harness)?;
    let key = context
        .api_key
        .as_deref()
        .ok_or("Enter an Open AI API key in the agent settings")?;
    validate_key(key)?;
    command
        .env("OPENAI_COMPAT_API_KEY", key.as_str())
        .env("OPENAI_COMPAT_BASE_URL", "https://api.openai.com/v1")
        .env("OPENAI_COMPAT_API", "auto")
        .env("BUZZ_AGENT_PROVIDER", "openai")
        .env("BUZZ_AGENT_MODEL", &harness.model)
        .env_remove("BUZZ_AGENT_THINKING_EFFORT")
        .env_remove("BUZZ_ACP_EFFORT_LEVEL");
    Ok(())
}
