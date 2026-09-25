//! Redacted saved-versus-running differences for the restart-required notice.
//! Raw values are compared natively; only the redacted entries cross IPC.
use crate::config::Agent;
use serde::Serialize;
use serde_json::{json, Map, Value};

const MASK: &str = "••••";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartDiffEntry {
    pub field: String,
    pub change: RestartChange,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestartChange {
    /// Safe scalar or array shown verbatim.
    Value {
        before: Value,
        after: Value,
    },
    /// Large text shown as character counts only.
    #[serde(rename_all = "camelCase")]
    Text {
        before_chars: Option<usize>,
        after_chars: Option<usize>,
    },
    /// Secret-bearing value shown only as a mask.
    Masked {
        before: Option<String>,
        after: Option<String>,
    },
    /// Environment key present only on one side; its value is never shown.
    Added,
    Removed,
}

/// Saved settings that a start applies. Identity and relay are immutable, and
/// the imported response policy is not editable, so neither can drift.
pub(crate) fn spawn_config(agent: &Agent) -> Value {
    let databricks = agent.harness.databricks.as_ref();
    json!({
        "name": agent.name,
        "system_prompt": agent.system_prompt,
        "workspace": agent.workspace,
        "command": agent.harness.command,
        "args": agent.harness.args,
        "model": agent.harness.model,
        "provider": agent.harness.provider,
        "databricks_host": databricks.map(|s| &s.host),
        "databricks_filter": databricks.map(|s| &s.filter),
        "env": agent.environment,
    })
}

pub(crate) fn diff(before: &Value, after: &Value) -> Vec<RestartDiffEntry> {
    let mut out = Vec::new();
    walk("", before, after, &mut out);
    out
}

fn walk(path: &str, before: &Value, after: &Value, out: &mut Vec<RestartDiffEntry>) {
    if before == after {
        return;
    }
    if let (Value::Object(before), Value::Object(after)) = (before, after) {
        for key in keys(before, after) {
            let child = if path.is_empty() {
                key.to_owned()
            } else {
                format!("{path}.{key}")
            };
            match (before.get(key), after.get(key)) {
                (Some(b), Some(a)) => walk(&child, b, a, out),
                (None, _) => out.push(entry(child, RestartChange::Added)),
                (_, None) => out.push(entry(child, RestartChange::Removed)),
            }
        }
        return;
    }
    let change = match path {
        "system_prompt" => RestartChange::Text {
            before_chars: before.as_str().map(|s| s.chars().count()),
            after_chars: after.as_str().map(|s| s.chars().count()),
        },
        // Arguments and environment values may carry credentials.
        _ if path == "args" || path.starts_with("env.") => RestartChange::Masked {
            before: (!before.is_null()).then(|| MASK.into()),
            after: (!after.is_null()).then(|| MASK.into()),
        },
        _ => RestartChange::Value {
            before: before.clone(),
            after: after.clone(),
        },
    };
    out.push(entry(path.to_owned(), change));
}

fn keys<'a>(before: &'a Map<String, Value>, after: &'a Map<String, Value>) -> Vec<&'a str> {
    let mut keys: Vec<_> = before
        .keys()
        .chain(after.keys())
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys
}

fn entry(field: String, change: RestartChange) -> RestartDiffEntry {
    RestartDiffEntry { field, change }
}

#[cfg(test)]
mod tests;
