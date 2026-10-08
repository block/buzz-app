//! Headless Codex model catalog and selected-model effort discovery. No prompts.
#![cfg(unix)]
use buzz_agent_controller::codex::CodexContext;
use serde_json::{json, Value};
use std::{collections::BTreeSet, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_MODELS: usize = 1_000;
const MAX_EFFORTS: usize = 20;
const MAX_CONFIG_OPTIONS: usize = 100;
const MAX_ID: usize = 512;
const MAX_NAME: usize = 1_024;
const INCOMPATIBLE: &str = "Codex model discovery could not be completed with the selected tools";
const TOO_LARGE: &str = "Codex model discovery exceeded its safe output limit";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Effort {
    pub(crate) model: String,
    pub(crate) current: Option<String>,
    pub(crate) options: Vec<Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Discovery {
    /// `None` means the adapter did not publish model metadata. `Some([])` is
    /// an authoritative, successfully discovered empty catalog.
    pub(crate) models: Option<Vec<Entry>>,
    /// The model resolved when the session opened, before an optional selection.
    pub(crate) resolved_model: Option<String>,
    /// The effort resolved when the session opened; not a per-model default.
    pub(crate) resolved_effort: Option<String>,
    /// Reported metadata for the selected/current model. Missing means unknown.
    pub(crate) effort: Option<Effort>,
}

/// One bounded ACP session over the bound adapter, as for Goose catalogs. The
/// process group is killed on drop, so cancellation and timeout leave no child.
struct Session {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::io::Take<tokio::process::ChildStdout>>,
    next: u64,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.child.start_kill();
    }
}
impl Session {
    fn start(context: &CodexContext) -> Result<Self, String> {
        let mut command = tokio::process::Command::from(context.adapter_command());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Codex to list models: {error}"))?;
        let input = child.stdin.take().ok_or(INCOMPATIBLE)?;
        let output = child.stdout.take().ok_or(INCOMPATIBLE)?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output.take(MAX_RESPONSE_BYTES)),
            next: 0,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|_| INCOMPATIBLE)?;
        let mut line = Vec::new();
        loop {
            line.clear();
            if self
                .output
                .read_until(b'\n', &mut line)
                .await
                .map_err(|_| INCOMPATIBLE)?
                == 0
            {
                return Err(INCOMPATIBLE.into());
            }
            let value: Value = serde_json::from_slice(&line).map_err(|_| INCOMPATIBLE)?;
            if value.get("method").is_some() {
                // Discovery grants no file, terminal, or permission requests.
                if value.get("id").is_some() {
                    return Err(INCOMPATIBLE.into());
                }
                continue;
            }
            if value.get("id") != Some(&json!(id)) {
                return Err(INCOMPATIBLE.into());
            }
            if let Some(error) = value.get("error") {
                return Err(rejected(error));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| INCOMPATIBLE.into());
        }
    }
}

fn rejected(error: &Value) -> String {
    let info = &error["data"]["codexErrorInfo"];
    let unauthorized = info == "unauthorized"
        || info.as_object().is_some_and(|info| {
            info.values()
                .any(|details| details["httpStatusCode"] == 401)
        });
    if unauthorized {
        "Sign in with the selected Codex CLI, then retry".into()
    } else {
        "Codex rejected the model discovery request".into()
    }
}

pub(crate) async fn discover(
    context: &CodexContext,
    selected_model: Option<&str>,
) -> Result<Discovery, String> {
    if selected_model.is_some_and(|value| !valid(value, MAX_ID)) {
        return Err(INCOMPATIBLE.into());
    }
    let mut session = Session::start(context)?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let initialized = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": {"name": "buzz-codex", "version": "0.0.0"}
                }),
            )
            .await?;
        if initialized["protocolVersion"] != 1
            || initialized["agentInfo"]["name"] != "@agentclientprotocol/codex-acp"
        {
            return Err("The selected Codex ACP adapter is incompatible. Install @agentclientprotocol/codex-acp.".into());
        }
        let opened = session
            .request(
                "session/new",
                json!({"cwd": context.workspace, "mcpServers": []}),
            )
            .await?;
        let session_id = opened
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| valid(value, MAX_ID))
            .ok_or(INCOMPATIBLE)?
            .to_owned();
        let initial = parse_options(opened.get("configOptions"))?;
        let resolved_model = initial.current_model.clone();
        let resolved_effort = initial
            .effort
            .as_ref()
            .and_then(|effort| effort.current.clone());
        let final_options = match selected_model.filter(|value| !value.is_empty()) {
            Some(selected) if initial.current_model.as_deref() != Some(selected) => {
                if !initial
                    .models
                    .as_ref()
                    .is_some_and(|models| models.iter().any(|model| model.id == selected))
                {
                    return Err(INCOMPATIBLE.into());
                }
                let changed = session
                    .request(
                        "session/set_config_option",
                        json!({"sessionId": session_id, "configId": "model", "value": selected}),
                    )
                    .await?;
                let changed = parse_options(changed.get("configOptions"))?;
                if changed.current_model.as_deref() != Some(selected) {
                    return Err(INCOMPATIBLE.into());
                }
                changed
            }
            _ => initial,
        };
        session
            .request("session/close", json!({"sessionId": session_id}))
            .await?;
        let Options {
            models,
            current_model,
            effort,
        } = final_options;
        Ok(Discovery {
            models,
            resolved_model,
            resolved_effort,
            effort: current_model.zip(effort).map(|(model, effort)| Effort { model, ..effort }),
        })
    })
    .await
    .map_err(|_| "Codex model discovery timed out; retry explicitly".to_owned())?
}

#[derive(Debug)]
struct Options {
    models: Option<Vec<Entry>>,
    current_model: Option<String>,
    effort: Option<Effort>,
}

fn parse_options(value: Option<&Value>) -> Result<Options, String> {
    let Some(value) = value else {
        return Ok(Options {
            models: None,
            current_model: None,
            effort: None,
        });
    };
    let options = value.as_array().ok_or(INCOMPATIBLE)?;
    if options.len() > MAX_CONFIG_OPTIONS {
        return Err(TOO_LARGE.into());
    }
    let mut model = None;
    let mut effort = None;
    for option in options {
        let id = option.get("id").and_then(Value::as_str);
        let category = option.get("category").and_then(Value::as_str);
        if id == Some("model") || category == Some("model") {
            if id != Some("model") || category != Some("model") || model.is_some() {
                return Err(INCOMPATIBLE.into());
            }
            model = Some(parse_select(option, MAX_MODELS)?);
        }
        if id == Some("reasoning_effort") || category == Some("thought_level") {
            if id != Some("reasoning_effort")
                || category != Some("thought_level")
                || effort.is_some()
            {
                return Err(INCOMPATIBLE.into());
            }
            effort = Some(parse_select(option, MAX_EFFORTS)?);
        }
    }
    let (models, current_model) = match model {
        Some(model) => {
            let current = current(&model)?;
            (Some(model.options), current)
        }
        None => (None, None),
    };
    if models.is_none() && effort.is_some() {
        return Err(INCOMPATIBLE.into());
    }
    let effort = effort
        .map(|selection| {
            Ok::<_, String>(Effort {
                model: String::new(),
                current: current(&selection)?,
                options: selection.options,
            })
        })
        .transpose()?;
    Ok(Options {
        models,
        current_model,
        effort,
    })
}

struct Selection {
    current: String,
    options: Vec<Entry>,
}

fn parse_select(value: &Value, limit: usize) -> Result<Selection, String> {
    if value.get("type").and_then(Value::as_str) != Some("select") {
        return Err(INCOMPATIBLE.into());
    }
    let current = value
        .get("currentValue")
        .and_then(Value::as_str)
        .filter(|value| value.is_empty() || valid(value, MAX_ID))
        .ok_or(INCOMPATIBLE)?
        .to_owned();
    let values = value
        .get("options")
        .and_then(Value::as_array)
        .ok_or(INCOMPATIBLE)?;
    if values.len() > limit {
        return Err(TOO_LARGE.into());
    }
    let mut ids = BTreeSet::new();
    let mut options = Vec::with_capacity(values.len());
    for option in values {
        if option.get("group").is_some() {
            return Err(INCOMPATIBLE.into());
        }
        let id = option
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| valid(value, MAX_ID))
            .ok_or(INCOMPATIBLE)?;
        let name = option
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| valid(value, MAX_NAME))
            .ok_or(INCOMPATIBLE)?;
        if !ids.insert(id) {
            return Err(INCOMPATIBLE.into());
        }
        options.push(Entry {
            id: id.to_owned(),
            name: name.to_owned(),
        });
    }
    Ok(Selection { current, options })
}

fn current(selection: &Selection) -> Result<Option<String>, String> {
    if selection.current.is_empty() && selection.options.is_empty() {
        return Ok(None);
    }
    selection
        .options
        .iter()
        .any(|option| option.id == selection.current)
        .then(|| Some(selection.current.clone()))
        .ok_or_else(|| INCOMPATIBLE.into())
}

fn valid(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests;
