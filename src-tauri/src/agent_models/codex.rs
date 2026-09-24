//! Codex's ACP catalog is authoritative for advertised choices, not entitlement.
#[cfg(unix)]
mod readiness;

use super::contracts::EffortOption;
use super::{Catalog, CatalogIntegration, Discovery, EffortOptions, Model, ModelError};
use buzz_agent_controller::{codex::Context, ContainedProcess};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};

pub(super) async fn execute(context: Context, selected: String) -> Result<Catalog, ModelError> {
    discover(context, Some(selected)).await
}

pub(super) async fn discover(
    context: Context,
    selected: Option<String>,
) -> Result<Catalog, ModelError> {
    #[cfg(unix)]
    {
        unix::execute(context, selected).await
    }
    #[cfg(not(unix))]
    {
        let _ = (context, selected);
        Err(ModelError::new(
            "unavailable",
            "Codex discovery requires supported process containment on this platform.",
        ))
    }
}

fn choices(option: &Value) -> Result<Vec<(String, String)>, ModelError> {
    let values = option["options"].as_array().ok_or_else(|| {
        ModelError::new(
            "unavailable",
            "Codex did not advertise selectable options. Update codex-acp and refresh.",
        )
    })?;
    let mut result = Vec::new();
    for value in values {
        if value.get("options").is_some() {
            result.extend(choices(value)?);
        } else {
            let id = value["value"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 512)
                .ok_or_else(|| {
                    ModelError::new("unavailable", "Codex returned an invalid option ID.")
                })?;
            result.push((
                id.to_owned(),
                value["name"]
                    .as_str()
                    .unwrap_or(id)
                    .chars()
                    .take(512)
                    .collect(),
            ));
        }
    }
    Ok(result)
}
fn option<'a>(response: &'a Value, category: &str) -> Option<&'a Value> {
    response["configOptions"]
        .as_array()?
        .iter()
        .find(|v| v["category"] == category)
}
fn current_value(response: &Value, category: &str) -> Option<String> {
    option(response, category)?["currentValue"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .map(str::to_owned)
}
fn models(response: &Value) -> Result<Vec<Model>, ModelError> {
    // Match Buzz's normalize_agent_models: stable entries first, then legacy
    // availableModels, preserving order and the first occurrence of each ID.
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |value: &Value, id_key: &str, name_key: &str| {
        if let Some(id) = value[id_key].as_str() {
            if seen.insert(id.to_owned()) {
                result.push(Model {
                    id: id.to_owned(),
                    name: value[name_key]
                        .as_str()
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or(id)
                        .trim()
                        .to_owned(),
                    effort: EffortOptions::Unknown,
                    error: None,
                });
            }
        }
    };
    for option in response["configOptions"].as_array().into_iter().flatten() {
        if option["category"] == "model" {
            for value in option["options"].as_array().into_iter().flatten() {
                add(value, "value", "displayName");
            }
        }
    }
    for value in response["models"]["availableModels"]
        .as_array()
        .into_iter()
        .flatten()
    {
        add(value, "modelId", "name");
    }
    Ok(result)
}

fn model_option<'a>(response: &'a Value, selected: &str) -> Option<&'a Value> {
    response["configOptions"].as_array()?.iter().find(|option| {
        option["category"] == "model"
            && option["options"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value["value"] == selected))
    })
}

fn apply_effort(models: &mut [Model], response: &Value, selected: &str) -> Result<(), ModelError> {
    let model = models.iter_mut().find(|m| m.id == selected).ok_or_else(|| ModelError::new("model", "The selected model ID is not advertised by Codex. Refresh and choose a listed model."))?;
    model.effort = match option(response, "thought_level") {
        Some(value) => EffortOptions::Supported {
            options: choices(value)?
                .into_iter()
                .map(|(value, name)| EffortOption { value, name })
                .collect(),
        },
        None => EffortOptions::Unknown,
    };
    Ok(())
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::{fd::OwnedFd, unix::net::UnixStream};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Session {
        process: ContainedProcess,
        stream: BufReader<tokio::net::UnixStream>,
        next: u64,
        remaining: usize,
    }
    impl Session {
        fn spawn(context: &Context) -> Result<Self, ModelError> {
            let (parent, child) = UnixStream::pair()
                .map_err(|_| ModelError::new("unavailable", "Could not open Codex transport."))?;
            let input = child
                .try_clone()
                .map_err(|_| ModelError::new("unavailable", "Could not open Codex transport."))?;
            let mut command = context.command(&context.adapter)?;
            command
                .args(&context.args)
                .stdin(Stdio::from(OwnedFd::from(input)))
                .stdout(Stdio::from(OwnedFd::from(child)))
                .stderr(Stdio::null());
            parent.set_nonblocking(true).map_err(|_| {
                ModelError::new("unavailable", "Could not configure Codex transport.")
            })?;
            let stream = tokio::net::UnixStream::from_std(parent).map_err(|_| {
                ModelError::new("unavailable", "Could not configure Codex transport.")
            })?;
            let process = ContainedProcess::spawn(&mut command)?;
            Ok(Self {
                process,
                stream: BufReader::new(stream),
                next: 0,
                remaining: 4 * 1024 * 1024,
            })
        }
        async fn rpc(
            &mut self,
            method: &str,
            params: Value,
            code: &'static str,
        ) -> Result<Value, ModelError> {
            self.next += 1;
            let mut bytes = serde_json::to_vec(
                &json!({"jsonrpc":"2.0", "id": self.next, "method": method, "params": params}),
            )
            .map_err(|_| ModelError::new(code, "Could not encode Codex request."))?;
            bytes.push(b'\n');
            self.stream.get_mut().write_all(&bytes).await.map_err(|_| {
                ModelError::new(
                    "unavailable",
                    "Codex transport closed. Check the adapter installation and configuration.",
                )
            })?;
            for _ in 0..128 {
                let mut line = Vec::new();
                loop {
                    let available = self.stream.fill_buf().await.map_err(|_| {
                        ModelError::new("unavailable", "Could not read Codex response.")
                    })?;
                    if available.is_empty() {
                        return Err(ModelError::new(
                            "unavailable",
                            "Codex exited before responding. Check its configuration and login.",
                        ));
                    }
                    let end = available.iter().position(|b| *b == b'\n').map(|i| i + 1);
                    let count = end.unwrap_or(available.len());
                    if count > self.remaining || line.len() + count > 1024 * 1024 {
                        return Err(ModelError::new(
                            "unavailable",
                            "Codex discovery response exceeded its size limit.",
                        ));
                    }
                    line.extend_from_slice(&available[..count]);
                    self.remaining -= count;
                    self.stream.consume(count);
                    if end.is_some() {
                        break;
                    }
                }
                let response: Value = serde_json::from_slice(&line).map_err(|_| {
                    ModelError::new("unavailable", "Codex returned an invalid ACP response.")
                })?;
                if response.get("method").is_some() {
                    if let Some(id) = response.get("id") {
                        let reply = format!(
                            "{}\n",
                            json!({"jsonrpc":"2.0", "id":id,"error":{"code":-32601,"message":"Discovery does not support client operations"}})
                        );
                        self.stream
                            .get_mut()
                            .write_all(reply.as_bytes())
                            .await
                            .map_err(|_| {
                                ModelError::new("unavailable", "Codex transport closed.")
                            })?;
                    }
                    continue;
                }
                if response["id"] != self.next {
                    return Err(ModelError::new(
                        "unavailable",
                        "Codex returned an unexpected response ID.",
                    ));
                }
                if response.get("error").is_some() {
                    return Err(ModelError::new(code, "Codex rejected this discovery or configuration request. Check login and the selected model/effort, then refresh."));
                }
                return response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| ModelError::new("unavailable", "Codex returned no result."));
            }
            Err(ModelError::new(
                "unavailable",
                "Codex sent too many discovery notifications.",
            ))
        }
    }
    pub(super) async fn execute(
        context: Context,
        selected: Option<String>,
    ) -> Result<Catalog, ModelError> {
        readiness::login(&context).await?;
        let mut session = Session::spawn(&context)?;
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            let initial = tokio::time::timeout(Duration::from_secs(30), async {
            let initialized = session
                .rpc(
                    "initialize",
                    json!({"protocolVersion":1,"clientCapabilities":{}}),
                    "unavailable",
                )
                .await?;
            readiness::adapter(&initialized)?;
            session
                .rpc(
                    "session/new",
                    json!({"cwd":context.workspace,"mcpServers":[]}),
                    "unavailable",
                )
                .await
            }).await.map_err(|_| ModelError::new("timeout", "Codex session discovery timed out."))??;
            let defaults = super::super::ResolvedDefaults {
                model: current_value(&initial, "model"),
                effort: current_value(&initial, "thought_level"),
            };
            let mut available = models(&initial)?;
            if selected.is_none() {
                // Effort is a separate control. Suppress legacy aliases when
                // the adapter also advertises their configurable base model.
                available.retain(|model| {
                    !model.id.strip_suffix(']').and_then(|id| id.rsplit_once('['))
                        .is_some_and(|(base, _)| model_option(&initial, base).is_some())
                });
            }
            // Browsing collects every model in one session. Creation can still
            // validate just its submitted selection without repeating the catalog.
            let selections: Vec<String> = match selected {
                Some(selected) => available.iter().filter(|model| model.id == selected).map(|model| model.id.clone()).collect(),
                None => available.iter().map(|model| model.id.clone()).collect(),
            };
            if selections.len() > 512 {
                return Err(ModelError::new("unavailable", "Codex advertised too many models to inspect. Update the adapter and retry."));
            }
            let mut base_options = std::collections::HashMap::<String, Value>::new();
            for selected in selections {
                let session_id = initial["sessionId"].as_str().ok_or_else(|| {
                    ModelError::new("unavailable", "Codex did not return a session ID.")
                })?;
                let selection = tokio::time::timeout(Duration::from_secs(15), async {
                    // Buzz's legacy catalog includes model[effort] IDs. Discover
                    // the base model's options before accepting the encoded effort.
                    let legacy = model_option(&initial, &selected).is_none();
                    let (base, encoded_effort) = if legacy {
                        selected.strip_suffix(']').and_then(|value| value.rsplit_once('['))
                            .map(|(model, effort)| (model, Some(effort)))
                            .unwrap_or((&selected, None))
                    } else { (selected.as_str(), None) };
                    let config = model_option(&initial, base).ok_or_else(|| {
                        ModelError::new("model", "Codex did not advertise configurable effort for this model.")
                    })?;
                    let config_id = config.get("configId").or_else(|| config.get("id"))
                        .and_then(Value::as_str).ok_or_else(|| {
                            ModelError::new("model", "Codex did not return a model configuration ID.")
                        })?;
                    let updated = if let Some(updated) = base_options.get(base) {
                        updated.clone()
                    } else {
                        let updated = session.rpc(
                            "session/set_config_option",
                            json!({"sessionId":session_id,"configId":config_id,"value":base}),
                            "model",
                        ).await?;
                        if model_option(&updated, base).and_then(|o| o["currentValue"].as_str()) != Some(base) {
                            return Err(ModelError::new("model", "Codex did not confirm the selected model."));
                        }
                        base_options.insert(base.to_owned(), updated.clone());
                        updated
                    };
                    if legacy {
                        if let Some(effort) = encoded_effort {
                            let advertised = option(&updated, "thought_level")
                                .map(choices).transpose()?.unwrap_or_default();
                            if !advertised.iter().any(|(value, _)| value == effort) {
                                return Err(ModelError::new("effort", "Codex did not advertise this model's encoded effort."));
                            }
                        }
                        session.rpc("session/set_model", json!({"sessionId":session_id,"modelId":selected}), "model").await?;
                    }
                    apply_effort(&mut available, &updated, &selected)
                }).await.map_err(|_| ModelError::new("model", "Codex model selection timed out.")).and_then(|result| result);
                if selection.is_err() {
                    if let Some(model) = available.iter_mut().find(|m| m.id == selected) {
                        model.effort = EffortOptions::Unknown;
                        model.error = Some("Codex could not confirm this model's configuration. Choose another listed model or refresh to retry.".into());
                    }
                }

            }
            Ok(Catalog {
                integration: CatalogIntegration::Codex,
                defaults: Some(defaults),
                models: available,
                discovery: Some(Discovery {
                    source: "codexAcp",
                    authentication: "authenticated",
                    catalog: "adapter",
                }),
                model_overridden: false,
                disconnected: false,
            })
        })
        .await
        .map_err(|_| ModelError::new("timeout", "Codex discovery timed out. Refresh to retry."));
        session.process.stop()?;
        result?
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use buzz_agent_controller::{AiConfiguration, EffortSelection, HarnessEdit};
    use std::{collections::BTreeMap, os::unix::fs::PermissionsExt};

    fn fixture(login: bool) -> (tempfile::TempDir, Context) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("config")).unwrap();
        let cli = dir.path().join("codex");
        std::fs::write(
            &cli,
            format!(
                "#!/bin/sh\n[ \"$1\" = -V ] && {{ echo 'codex-cli 0.151.0'; exit 0; }}\n[ \"$CODEX_HOME\" -ef \"$PWD/config\" ] || exit 2\nexit {}\n",
                if login { 0 } else { 1 }
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let adapter = dir.path().join("codex-acp");
        std::fs::write(&adapter, r#"#!/usr/bin/python3
import json, sys, os, time
if sys.argv[1:2] == ['cli']:
    cli = os.path.join(os.path.dirname(__file__), 'codex')
    os.execv(cli, [cli] + sys.argv[2:])
assert os.path.realpath(os.environ['CODEX_HOME']) == os.getcwd() + '/config'
assert 'BUZZ_PRIVATE_KEY' not in os.environ
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    with open('calls', 'a') as calls: calls.write(method + '\n')
    model = {'configId':'model', 'category':'model', 'currentValue':'first', 'options':[{'value':'first','name':'First'},{'value':'second','name':'Second'}]}
    if method == 'initialize': result = {'protocolVersion':1, 'agentInfo':{'name':'@agentclientprotocol/codex-acp','version':'1.3.0'}}
    elif method == 'session/new': result = {'sessionId':'fixture', 'models': {'availableModels': [{'modelId':'second[high]', 'name':'Second (high)'}] if os.path.exists('legacy-model') else []}, 'configOptions':[model, {'id':'effort','category':'thought_level','currentValue':'low','options':[{'value':'low','name':'Low'}]}]}
    elif method == 'session/set_config_option':
        if os.path.exists('hold-selection'): time.sleep(120)
        if os.path.exists('reject-model'):
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32602,'message':'secret provider details'}}), flush=True)
            continue
        assert request['params']['value'] in ['first','second']
        model['currentValue'] = request['params']['value']
        effort = 'low' if model['currentValue'] == 'first' else 'high'
        result = {'configOptions':[model, {'id':'effort','category':'thought_level','currentValue':effort,'options':[{'value':effort,'name':effort.title()}]}]}
    elif method == 'session/set_model':
        assert request['params']['modelId'] == 'second[high]'
        result = {}
    else: raise AssertionError('Unexpected operation: ' + method)
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}), flush=True)
"#).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o700)).unwrap();
        let harness = HarnessEdit {
            command: adapter.to_string_lossy().into_owned(),
            args: vec![],
            model: "second".into(),
            provider: String::new(),
            databricks: None,
            configuration: Some(AiConfiguration::Advanced {
                effort: EffortSelection::Value {
                    value: "high".into(),
                },
            }),
        };
        let environment = BTreeMap::from([
            ("CODEX_PATH".into(), cli.to_string_lossy().into_owned()),
            (
                "CODEX_HOME".into(),
                dir.path().join("config").to_string_lossy().into_owned(),
            ),
        ]);
        let context = Context::new(&harness, &environment, dir.path().to_str().unwrap()).unwrap();
        (dir, context)
    }
    #[test]
    fn catalog_matches_buzz_stable_then_legacy_order_and_first_id_wins() {
        let response = json!({
            "configOptions": [
                {"category":"thought_level", "options":[{"value":"not-a-model"}]},
                {"category":"model", "options":[
                    {"value":"first", "displayName":"First stable", "name":"Other name"},
                    {"value":"raw", "name":"Ignored like original Buzz"},
                    {"value":"first", "displayName":"Duplicate"}]},
                {"category":"model", "options":[{"value":"second", "displayName":"Second stable"}]}
            ],
            "models":{"availableModels":[
                {"modelId":"first", "name":"Legacy duplicate"},
                {"modelId":"second[high]", "name":"Second (high)"},
                {"modelId":"second[high]", "name":"Duplicate"}
            ]}
        });
        let catalog = models(&response).unwrap();
        let pairs: Vec<_> = catalog
            .iter()
            .map(|m| (m.id.as_str(), m.name.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("first", "First stable"),
                ("raw", "raw"),
                ("second", "Second stable"),
                ("second[high]", "Second (high)")
            ]
        );
        assert_eq!(
            models(&json!({"models":{"availableModels":[{"modelId":"legacy", "name":"Legacy"}]}}))
                .unwrap()[0]
                .id,
            "legacy"
        );
        assert!(models(&json!({})).unwrap().is_empty());
    }

    #[tokio::test]
    async fn complete_catalog_uses_one_session_and_one_probe_per_base_model() {
        let (dir, context) = fixture(true);
        std::fs::write(dir.path().join("legacy-model"), "").unwrap();
        let catalog = discover(context, None).await.unwrap();
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        for (model, effort) in [("first", "low"), ("second", "high")] {
            assert!(catalog
                .validate_selection(
                    model,
                    &EffortSelection::Value {
                        value: effort.into()
                    }
                )
                .is_ok());
        }
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert_eq!(
            calls
                .lines()
                .filter(|method| *method == "initialize")
                .count(),
            1
        );
        assert_eq!(
            calls
                .lines()
                .filter(|method| *method == "session/new")
                .count(),
            1
        );
        assert_eq!(
            calls
                .lines()
                .filter(|method| *method == "session/set_config_option")
                .count(),
            2
        );
        assert_eq!(
            calls
                .lines()
                .filter(|method| *method == "session/set_model")
                .count(),
            0
        );
        let defaults = catalog.defaults.unwrap();
        assert_eq!(defaults.model.as_deref(), Some("first"));
        assert_eq!(defaults.effort.as_deref(), Some("low"));
    }

    #[tokio::test]
    async fn legacy_effort_variant_is_selected_and_validated_through_real_transport() {
        let (dir, context) = fixture(true);
        std::fs::write(dir.path().join("legacy-model"), "").unwrap();
        let catalog = execute(context, "second[high]".into()).await.unwrap();
        assert_eq!(catalog.models.len(), 3);
        assert_eq!(catalog.models[2].name, "Second (high)");
        assert!(catalog
            .validate_selection(
                "second[high]",
                &EffortSelection::Value {
                    value: "high".into()
                }
            )
            .is_ok());
        assert!(catalog
            .validate_selection(
                "second[high]",
                &EffortSelection::Value {
                    value: "low".into()
                }
            )
            .is_err());
    }

    #[tokio::test]
    async fn real_transport_uses_login_and_selected_models_own_effort() {
        let (_dir, context) = fixture(true);
        let catalog = execute(context, "second".into()).await.unwrap();
        assert_eq!(catalog.models.len(), 2);
        let defaults = catalog.defaults.as_ref().unwrap();
        assert_eq!(defaults.model.as_deref(), Some("first"));
        assert_eq!(defaults.effort.as_deref(), Some("low"));
        assert!(catalog
            .validate_selection(
                "second",
                &EffortSelection::Value {
                    value: "high".into()
                }
            )
            .is_ok());
        assert!(catalog
            .validate_selection(
                "second",
                &EffortSelection::Value {
                    value: "low".into()
                }
            )
            .is_err());
        assert!(catalog
            .validate_selection(
                "first",
                &EffortSelection::Value {
                    value: "high".into()
                }
            )
            .is_err());
        assert_eq!(catalog.discovery.unwrap().catalog, "adapter");
    }
    #[tokio::test]
    async fn absent_selection_preserves_advertised_catalog_for_recovery() {
        let (_dir, context) = fixture(true);
        let catalog = execute(context, "removed".into()).await.unwrap();
        assert_eq!(catalog.models.len(), 2);
        assert!(catalog
            .validate_selection("removed", &EffortSelection::Unsupported)
            .is_err());
    }
    #[tokio::test]
    async fn failed_login_does_not_become_catalog_success() {
        let (_dir, context) = fixture(false);
        let error = execute(context, "second".into()).await.err().unwrap();
        assert_eq!(serde_json::to_value(error).unwrap()["code"], "unavailable");
    }
    #[tokio::test]
    async fn login_failures_are_distinct_sanitized_and_do_not_start_adapter() {
        for (script, expected) in [
            ("echo 'Not logged in' >&2; exit 1", "authentication"),
            (
                "echo 'Error loading configuration: secret-fixture' >&2; exit 1",
                "configuration",
            ),
            ("echo 'secret-fixture' >&2; exit 2", "unavailable"),
            (
                "exec /usr/bin/python3 -c \"print('secret-fixture' * 2000)\"",
                "unavailable",
            ),
        ] {
            let (dir, context) = fixture(true);
            std::fs::write(&context.cli, format!("#!/bin/sh\n[ \"$1\" = -V ] && {{ echo 'codex-cli 0.151.0'; exit 0; }}\n{script}\n")).unwrap();
            let error = execute(context, "second".into()).await.err().unwrap();
            let error = serde_json::to_value(error).unwrap();
            assert_eq!(error["code"], expected);
            assert!(!error.to_string().contains("secret-fixture"));
            assert!(!dir.path().join("calls").exists());
        }
    }

    #[tokio::test]
    async fn missing_or_malformed_cli_is_unknown_not_logged_out() {
        for script in [None, Some("#!/bin/sh\necho malformed-version\n")] {
            let (dir, context) = fixture(true);
            if let Some(script) = script {
                std::fs::write(&context.cli, script).unwrap();
            } else {
                std::fs::remove_file(&context.cli).unwrap();
            }
            let error = execute(context, String::new()).await.err().unwrap();
            assert_eq!(serde_json::to_value(error).unwrap()["code"], "unavailable");
            assert!(!dir.path().join("calls").exists());
        }
    }

    #[tokio::test]
    async fn unsupported_adapter_fails_before_session_creation() {
        for info in [
            json!({"name":"@agentclientprotocol/codex-acp", "version":"0.16.0"}),
            json!({"name":"@agentclientprotocol/codex-acp", "version":"malformed"}),
            json!({"name":"@agentclientprotocol/codex-acp"}),
            json!({"name":"other", "version":"1.3.0"}),
        ] {
            let (dir, context) = fixture(true);
            let script = std::fs::read_to_string(&context.adapter).unwrap().replace(
                "{'name':'@agentclientprotocol/codex-acp','version':'1.3.0'}",
                &info.to_string(),
            );
            std::fs::write(&context.adapter, script).unwrap();
            assert!(execute(context, "second".into()).await.is_err());
            assert_eq!(
                std::fs::read_to_string(dir.path().join("calls")).unwrap(),
                "initialize\n"
            );
        }
    }

    #[tokio::test]
    async fn login_timeout_reaps_child_and_remains_unknown() {
        let (dir, context) = fixture(true);
        std::fs::write(
            &context.cli,
            "#!/bin/sh\n[ \"$1\" = -V ] && { echo 'codex-cli 0.151.0'; exit 0; }\necho $$ > login-pid\n/bin/sleep 60 &\necho $! > login-child-pid\nwait\n",
        )
        .unwrap();
        let error = execute(context, "second".into()).await.err().unwrap();
        assert_eq!(serde_json::to_value(error).unwrap()["code"], "timeout");
        for filename in ["login-pid", "login-child-pid"] {
            let pid = std::fs::read_to_string(dir.path().join(filename)).unwrap();
            let status = std::process::Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(!status.success());
        }
        assert!(!dir.path().join("calls").exists());
    }

    #[tokio::test]
    async fn rejected_model_retains_recovery_choices_and_safe_error() {
        let (dir, context) = fixture(true);
        std::fs::write(dir.path().join("reject-model"), "").unwrap();
        let catalog = execute(context, "second".into()).await.unwrap();
        assert_eq!(catalog.models.len(), 2);
        assert!(catalog.models[1].error.is_some());
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("secret provider"));
        assert!(catalog
            .validate_selection(
                "second",
                &EffortSelection::Value {
                    value: "high".into()
                }
            )
            .is_err());
    }
    #[tokio::test]
    async fn hung_selection_retains_catalog_after_its_bounded_timeout() {
        let (dir, context) = fixture(true);
        std::fs::write(dir.path().join("hold-selection"), "").unwrap();
        let catalog = execute(context, "second".into()).await.unwrap();
        assert_eq!(catalog.models.len(), 2);
        assert!(catalog.models[1].error.is_some());
        assert!(catalog
            .validate_selection(
                "second",
                &EffortSelection::Value {
                    value: "high".into()
                }
            )
            .is_err());
    }
    #[tokio::test]
    async fn oversized_transport_response_is_bounded() {
        let (_dir, context) = fixture(true);
        std::fs::write(
            &context.adapter,
            "#!/usr/bin/python3\nprint('x' * (1024 * 1024 + 1), flush=True)\n",
        )
        .unwrap();
        let error = execute(context, String::new()).await.err().unwrap();
        assert!(error.to_string().contains("size limit"));
    }
    #[test]
    fn native_creation_checks_codex_before_generating_identity() {
        use crate::agents::tests::{fixture as host_fixture, has_prepared_identity, invoke};
        let (dir, context) = fixture(true);
        let (_store, host, _app, view) = host_fixture();
        let mut edit = json!({"name":"Codex fixture", "workspace":dir.path(), "systemPrompt":"", "harness":{"command":context.adapter,"args":[],"provider":"","model":"second","configuration":{"mode":"advanced","effort":{"kind":"value","value":"low"}}}, "environment":{"CODEX_HOME":dir.path().join("config")}});
        let prepare = |edit: Value| {
            invoke(
                &view,
                "agent_control_create_prepare",
                json!({"requestId":uuid::Uuid::new_v4().to_string(),"destination":"wss://relay.example","owner":"ab".repeat(32),"edit":edit}),
            )
        };
        assert_eq!(prepare(edit.clone()).unwrap_err()["code"], "effort");
        assert!(!has_prepared_identity(&host));
        edit["harness"]["configuration"]["effort"]["value"] = json!("high");
        assert!(prepare(edit).is_ok());
        assert!(has_prepared_identity(&host));
    }
    #[tokio::test]
    async fn cancelling_probe_reaps_adapter() {
        let (dir, context) = fixture(true);
        std::fs::write(
            &context.adapter,
            "#!/bin/sh\necho $$ > adapter.pid\nexec sleep 120\n",
        )
        .unwrap();
        let host = super::super::ModelHost::new(Ok(dir.path().join("store")));
        let ticket = host.begin().unwrap();
        let owner = host.clone();
        let task =
            tokio::spawn(async move { owner.run(ticket, execute(context, "".into())).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !dir.path().join("adapter.pid").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        host.cancel(ticket).unwrap();
        assert!(task.await.unwrap().is_err());
        let pid = std::fs::read_to_string(dir.path().join("adapter.pid")).unwrap();
        assert!(!std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
        assert!(host.begin().is_ok());
    }
}
