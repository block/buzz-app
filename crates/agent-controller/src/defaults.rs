use crate::{connection::DatabricksSettings, HarnessEdit};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

/// Public, nonsecret build configuration. Saved values are never projected here.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDefaults {
    pub host: String,
    pub filter: String,
    pub model: String,
    pub provider: String,
    pub owner_only: bool,
    pub session_policy: String,
}
include!(concat!(env!("OUT_DIR"), "/agent_defaults.rs"));

impl BuildDefaults {
    // Resolve a temporary copy, never mutate the stored agent or its revision.
    pub(crate) fn resolve(
        &self,
        saved: &HarnessEdit,
        env: &BTreeMap<String, String>,
    ) -> HarnessEdit {
        let mut harness = saved.clone();
        if Path::new(&harness.command)
            .file_name()
            .and_then(|s| s.to_str())
            != Some("buzz-agent")
        {
            return harness;
        }
        if harness.provider.is_empty() {
            harness.provider.clone_from(&self.provider);
        }
        if let Some(provider) = env.get("BUZZ_AGENT_PROVIDER") {
            harness.provider.clone_from(provider);
        }
        if matches!(
            harness.provider.as_str(),
            "databricks_v2" | "databricks-v2" | "databricks"
        ) {
            if harness.model.is_empty() {
                harness.model = env.get("DATABRICKS_MODEL").unwrap_or(&self.model).clone();
            }
            if harness.databricks.is_none() && (!self.host.is_empty() || !self.filter.is_empty()) {
                harness.databricks = Some(DatabricksSettings {
                    host: self.host.clone(),
                    filter: self.filter.clone(),
                });
            }
        }
        if let Some(model) = env.get("BUZZ_AGENT_MODEL") {
            harness.model.clone_from(model);
        }
        harness
    }
}
