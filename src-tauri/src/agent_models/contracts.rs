//! Sanitized discovery evidence. Static harness setup metadata lives in agents.rs.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Discovery {
    pub source: &'static str,
    pub authentication: &'static str,
    /// Remote request evidence; authentication alone does not establish freshness.
    pub catalog: &'static str,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(super) enum EffortOptions {
    // This describes the integration's exposed control, not model reasoning ability.
    Unsupported,
    Unknown,
    Supported { options: Vec<EffortOption> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelError {
    code: &'static str,
    message: String,
}
impl ModelError {
    pub(super) fn with_diagnostic(mut self, message: Option<&'static str>) -> Self {
        if self.code == "unavailable" {
            if let Some(message) = message {
                self.message = message.into();
            }
        }
        self
    }
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl From<String> for ModelError {
    fn from(message: String) -> Self {
        Self::new("configuration", message)
    }
}
impl From<&str> for ModelError {
    fn from(message: &str) -> Self {
        Self::new("configuration", message)
    }
}
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Serialize)]
pub(super) struct EffortOption {
    pub value: String,
    pub name: String,
}
