//! Codex's ACP catalog is authoritative for advertised choices, not entitlement.
use super::contracts::EffortOption;
use super::{Catalog, CatalogIntegration, Discovery, EffortOptions, Model, ModelError};
use buzz_agent_controller::{codex::Context, ContainedProcess};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};

pub(super) async fn execute(context: Context, selected: String) -> Result<Catalog, ModelError> {
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
fn models(response: &Value) -> Result<Vec<Model>, ModelError> {
    let model = option(response, "model").ok_or_else(|| {
        ModelError::new(
            "unavailable",
            "Codex did not advertise model configuration. Update codex-acp and refresh.",
        )
    })?;
    choices(model)?
        .into_iter()
        .map(|(id, name)| {
            Ok(Model {
                id,
                name,
                effort: EffortOptions::Unknown,
                error: None,
            })
        })
        .collect()
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
    pub(super) async fn execute(context: Context, selected: String) -> Result<Catalog, ModelError> {
        let mut command = context.command(&context.cli)?;
        command
            .args(["login", "status"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut login = ContainedProcess::spawn(&mut command)?;
        let authenticated = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(success) = login.exit_success()? {
                    return Ok::<_, String>(success);
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .map_err(|_| {
            ModelError::new(
                "timeout",
                "Codex login check timed out. Retry after checking the CLI.",
            )
        })??;
        login.stop()?;
        if !authenticated {
            return Err(ModelError::new("unavailable", "Codex login check did not succeed. Run codex login in the same configuration context, then refresh. Check the CLI configuration if login still fails."));
        }
        let mut session = Session::spawn(&context)?;
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            let initial = tokio::time::timeout(Duration::from_secs(30), async {
            session
                .rpc(
                    "initialize",
                    json!({"protocolVersion":1,"clientCapabilities":{}}),
                    "unavailable",
                )
                .await?;
            session
                .rpc(
                    "session/new",
                    json!({"cwd":context.workspace,"mcpServers":[]}),
                    "unavailable",
                )
                .await
            }).await.map_err(|_| ModelError::new("timeout", "Codex session discovery timed out."))??;
            let mut available = models(&initial)?;
            if !selected.is_empty() && available.iter().any(|m| m.id == selected) {
                let config_id = option(&initial, "model")
                    .and_then(|o| o["id"].as_str())
                    .ok_or_else(|| {
                        ModelError::new(
                            "unavailable",
                            "Codex did not return a model configuration ID.",
                        )
                    })?;
                let session_id = initial["sessionId"].as_str().ok_or_else(|| {
                    ModelError::new("unavailable", "Codex did not return a session ID.")
                })?;
                let selection = tokio::time::timeout(Duration::from_secs(15), session.rpc(
                    "session/set_config_option",
                    json!({"sessionId":session_id,"configId":config_id,"value":selected}),
                    "model",
                )).await.map_err(|_| ModelError::new("model", "Codex model selection timed out.")).and_then(|result| result).and_then(|updated| {
                    if option(&updated, "model").and_then(|o| o["currentValue"].as_str()) != Some(selected.as_str()) {
                        return Err(ModelError::new("model", "Codex did not confirm the selected model."));
                    }
                    apply_effort(&mut available, &updated, &selected)
                });
                if selection.is_err() {
                    if let Some(model) = available.iter_mut().find(|m| m.id == selected) {
                        model.effort = EffortOptions::Unknown;
                        model.error = Some("Codex could not confirm this model's configuration. Choose another listed model or refresh to retry.".into());
                    }
                }

            }
            Ok(Catalog {
                integration: CatalogIntegration::Codex,
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
                "#!/bin/sh\n[ \"$CODEX_HOME\" -ef \"$PWD/config\" ] || exit 2\nexit {}\n",
                if login { 0 } else { 1 }
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let adapter = dir.path().join("codex-acp");
        std::fs::write(&adapter, r#"#!/usr/bin/python3
import json, sys, os, time
assert os.path.realpath(os.environ['CODEX_HOME']) == os.getcwd() + '/config'
assert 'BUZZ_PRIVATE_KEY' not in os.environ
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    model = {'id':'model', 'category':'model', 'currentValue':'first', 'options':[{'value':'first','name':'First'},{'value':'second','name':'Second'}]}
    if method == 'initialize': result = {'protocolVersion':1}
    elif method == 'session/new': result = {'sessionId':'fixture', 'configOptions':[model]}
    elif method == 'session/set_config_option':
        if os.path.exists('hold-selection'): time.sleep(120)
        if os.path.exists('reject-model'):
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32602,'message':'secret provider details'}}), flush=True)
            continue
        assert request['params']['value'] in ['first','second']
        model['currentValue'] = request['params']['value']
        effort = 'low' if model['currentValue'] == 'first' else 'high'
        result = {'configOptions':[model, {'id':'effort','category':'thought_level','currentValue':effort,'options':[{'value':effort,'name':effort.title()}]}]}
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
        let environment = BTreeMap::from([(
            "CODEX_HOME".into(),
            dir.path().join("config").to_string_lossy().into_owned(),
        )]);
        let context = Context::new(&harness, &environment, dir.path().to_str().unwrap()).unwrap();
        (dir, context)
    }
    #[tokio::test]
    async fn real_transport_uses_login_and_selected_models_own_effort() {
        let (_dir, context) = fixture(true);
        let catalog = execute(context, "second".into()).await.unwrap();
        assert_eq!(catalog.models.len(), 2);
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
