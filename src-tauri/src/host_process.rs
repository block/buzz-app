//! Duplex, newline-framed processes declared in an installed plugin's host grant.
//! The host owns process groups, limits and lifetime; the plugin owns its protocol.
use crate::{with_manager, PluginManager};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

const MAX_FRAME: usize = 8 * 1024 * 1024;
#[derive(Clone, Default)]
pub(crate) struct HostProcesses(Arc<Mutex<HashMap<String, Process>>>);
struct Process {
    owner: String,
    revision: String,
    input: mpsc::Sender<String>,
    _cancel: tokio::sync::oneshot::Sender<()>,
}
impl HostProcesses {
    pub(crate) fn revoke(&self, owner: Option<&str>) {
        if let Ok(mut table) = self.0.lock() {
            table.retain(|_, process| owner.is_some_and(|id| process.owner != id));
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ProcessEvent {
    Line { text: String },
    Exit { error: String },
}

#[tauri::command]
pub(crate) async fn plugin_host_process_open(
    manager: tauri::State<'_, PluginManager>,
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    revision: String,
    command_id: String,
    connection_id: String,
    on_event: tauri::ipc::Channel<ProcessEvent>,
) -> Result<(), String> {
    let owner = id.clone();
    let version = revision.clone();
    let command = with_manager(manager, move |manager| {
        manager
            .host_grants(&id, &revision)?
            .commands
            .into_iter()
            .find(|command| command.id == command_id)
            .ok_or("Command is not declared".into())
    })
    .await?;
    #[cfg(not(unix))]
    {
        let _ = (processes, owner, version, command, connection_id, on_event);
        Err("Plugin processes currently require macOS or Linux".into())
    }
    #[cfg(unix)]
    {
        use crate::host_command::{effective_path, resolve_program, ProcessGroupGuard};
        use std::process::Stdio;
        let (input, mut receiver) = mpsc::channel::<String>(32);
        let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
        let mut table = processes
            .0
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        if table.len() >= 16 || table.contains_key(&connection_id) {
            return Err("Too many plugin processes or duplicate connection".into());
        }
        let path = effective_path();
        let mut child = tokio::process::Command::new(resolve_program(&command.program, &path));
        child
            .args(&command.args)
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = child
            .spawn()
            .map_err(|error| format!("Could not start {}: {error}", command.program))?;
        let group = ProcessGroupGuard {
            process_id: child.id().ok_or("Process did not start")? as i32,
            armed: true,
        };
        let mut stdin = child.stdin.take().ok_or("Process stdin unavailable")?;
        let mut stdout = child.stdout.take().ok_or("Process stdout unavailable")?;
        table.insert(
            connection_id.clone(),
            Process {
                owner,
                revision: version,
                input,
                _cancel: cancel,
            },
        );
        drop(table);
        let registry = processes.inner().clone();
        tauri::async_runtime::spawn(async move {
            let writing = async {
                while let Some(message) = receiver.recv().await {
                    stdin
                        .write_all(message.as_bytes())
                        .await
                        .map_err(|_| "Process input closed")?;
                }
                Err::<(), &str>("Process input closed")
            };
            let reading = async {
                let mut pending = Vec::new();
                let mut buffer = [0; 16384];
                loop {
                    let count = stdout
                        .read(&mut buffer)
                        .await
                        .map_err(|_| "Process output failed")?;
                    if count == 0 {
                        return Err("Process exited");
                    }
                    pending.extend_from_slice(&buffer[..count]);
                    while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                        if end > MAX_FRAME {
                            return Err("Process frame exceeds 8 MiB");
                        }
                        let text = String::from_utf8(pending.drain(..=end).collect())
                            .map_err(|_| "Process output is not UTF-8")?;
                        on_event
                            .send(ProcessEvent::Line { text })
                            .map_err(|_| "Process has no reader")?;
                    }
                    if pending.len() > MAX_FRAME {
                        return Err("Process frame exceeds 8 MiB");
                    }
                }
                #[allow(unreachable_code)]
                Ok::<(), &str>(())
            };
            let stream = async {
                tokio::select! { outcome = writing => outcome, outcome = reading => outcome }
            };
            let error = tokio::select! {
                _ = cancelled => "Process closed",
                result = tokio::time::timeout(Duration::from_secs(30 * 60), stream) => match result {
                    Ok(Err(error)) => error, Ok(Ok(())) => "Process closed", Err(_) => "Process reached its 30 minute limit",
                }
            };
            // EOF lets app-server terminate its background terminals, which can
            // own separate process groups. Keep draining output during shutdown
            // so a full pipe cannot prevent cleanup. Unresponsive commands still
            // hit a bounded deadline and are killed below.
            drop(stdin);
            let graceful = async {
                let mut sink = tokio::io::sink();
                tokio::select! {
                    result = child.wait() => result,
                    _ = tokio::io::copy(&mut stdout, &mut sink) => child.wait().await,
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(3), graceful).await;
            group.kill();
            let _ = child.start_kill();
            let _ = child.wait().await;
            if let Ok(mut table) = registry.0.lock() {
                table.remove(&connection_id);
            }
            let _ = on_event.send(ProcessEvent::Exit {
                error: error.into(),
            });
        });
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn plugin_host_process_send(
    manager: tauri::State<'_, PluginManager>,
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    revision: String,
    connection_id: String,
    text: String,
) -> Result<(), String> {
    if text.len() > MAX_FRAME || text.contains(['\n', '\r']) {
        return Err("Invalid process frame".into());
    }
    let owner = id.clone();
    let version = revision.clone();
    with_manager(manager, move |manager| manager.host_grants(&id, &revision)).await?;
    let input = {
        let table = processes
            .0
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        let process = table.get(&connection_id).ok_or("Process is closed")?;
        if process.owner != owner || process.revision != version {
            return Err("Process belongs to another plugin revision".into());
        }
        process.input.clone()
    };
    input
        .try_send(format!("{text}\n"))
        .map_err(|_| "Process input is closed or full".into())
}

#[tauri::command]
pub(crate) fn plugin_host_process_close(
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    revision: String,
    connection_id: String,
) -> Result<(), String> {
    let mut table = processes
        .0
        .lock()
        .map_err(|_| "Process registry unavailable")?;
    if table
        .get(&connection_id)
        .is_some_and(|process| process.owner != id || process.revision != revision)
    {
        return Err("Process belongs to another plugin revision".into());
    }
    table.remove(&connection_id);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::Manager as _;

    #[tokio::test]
    async fn duplex_process_checks_grants_and_cancels_a_blocked_writer() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("plugin");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::json!({
            "id":"test.process","name":"Process test","apiVersion":1,"host":{"commands":[
                {"id":"blocked","program":"sh","args":["-c","printf 'ready\\n'; dd bs=1 count=1 >/dev/null 2>&1; printf 'writing\\n'; exec sleep 600"]},
                {"id":"graceful","program":"sh","args":["-c","printf 'ready\\n'; cat >/dev/null; printf 'cleaned' > \"$1\"","sh",temp.path().join("cleaned")]}
            ]}
        }).to_string()).unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().join("home")), "test", false).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "test.process")
            .unwrap()
            .revision;
        let processes = HostProcesses::default();
        let app = tauri::test::mock_builder()
            .manage(PluginManager(Ok(manager.clone())))
            .manage(processes.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (events, mut received) = mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(text) = body {
                let _ = events.send(serde_json::from_str::<serde_json::Value>(&text).unwrap());
            }
            Ok(())
        });
        let open = || {
            plugin_host_process_open(
                app.state(),
                app.state(),
                "test.process".into(),
                revision.clone(),
                "blocked".into(),
                "connection".into(),
                channel.clone(),
            )
        };
        assert!(open().await.is_err(), "disabled plugin cannot launch");
        manager.change("enable", "test.process").unwrap();
        open().await.unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready["text"], "ready\n");
        assert!(plugin_host_process_send(
            app.state(),
            app.state(),
            "test.other".into(),
            revision.clone(),
            "connection".into(),
            "no".into()
        )
        .await
        .is_err());
        // Far larger than the pipe: the child reads only one byte. Closing must not wait for it.
        plugin_host_process_send(
            app.state(),
            app.state(),
            "test.process".into(),
            revision.clone(),
            "connection".into(),
            "x".repeat(MAX_FRAME),
        )
        .await
        .unwrap();
        assert!(plugin_host_process_close(
            app.state(),
            "test.other".into(),
            revision.clone(),
            "connection".into()
        )
        .is_err());
        let writing = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .expect("stdout must drain while stdin is blocked")
            .unwrap();
        assert_eq!(writing["text"], "writing\n");
        processes.revoke(Some("test.process"));
        let exit = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .expect("cancellation must interrupt a blocked stdin write")
            .unwrap();
        assert_eq!(exit["type"], "exit");
        assert!(processes.0.lock().unwrap().is_empty());

        // Closing stdin lets protocol servers clean up children in other process groups.
        plugin_host_process_open(
            app.state(),
            app.state(),
            "test.process".into(),
            revision.clone(),
            "graceful".into(),
            "graceful".into(),
            channel,
        )
        .await
        .unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready["text"], "ready\n");
        plugin_host_process_close(
            app.state(),
            "test.process".into(),
            revision,
            "graceful".into(),
        )
        .unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit["type"], "exit");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("cleaned")).unwrap(),
            "cleaned"
        );
    }
    /// Exercises the production Tauri transport, not the Node acceptance adapter.
    #[tokio::test]
    #[ignore = "requires Codex login and makes a real model call"]
    async fn real_codex_uses_native_transport_and_tools() {
        use serde_json::{json, Value};
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().join("home")), "test", false).unwrap();
        let source = temp.path().join("plugin");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(
            source.join("manifest.json"),
            include_str!("../../examples/plugins/codex-agent-plugin/manifest.json"),
        )
        .unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "buzz.codex-agent-plugin")
            .unwrap()
            .revision;
        manager.change("enable", "buzz.codex-agent-plugin").unwrap();
        let processes = HostProcesses::default();
        let app = tauri::test::mock_builder()
            .manage(PluginManager(Ok(manager)))
            .manage(processes.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (events, mut received) = mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(text) = body {
                let event: Value = serde_json::from_str(&text).unwrap();
                if event["type"] == "line" {
                    events
                        .send(
                            serde_json::from_str::<Value>(event["text"].as_str().unwrap()).unwrap(),
                        )
                        .unwrap();
                } else {
                    let _ = events.send(event);
                }
            }
            Ok(())
        });
        plugin_host_process_open(
            app.state(),
            app.state(),
            "buzz.codex-agent-plugin".into(),
            revision.clone(),
            "app-server".into(),
            "codex-live".into(),
            channel,
        )
        .await
        .unwrap();
        let send = |message: Value| {
            plugin_host_process_send(
                app.state(),
                app.state(),
                "buzz.codex-agent-plugin".into(),
                revision.clone(),
                "codex-live".into(),
                message.to_string(),
            )
        };
        async fn response(received: &mut mpsc::UnboundedReceiver<Value>, id: u64) -> Value {
            loop {
                let event = tokio::time::timeout(Duration::from_secs(60), received.recv())
                    .await
                    .unwrap()
                    .unwrap();
                if event["id"] == id {
                    assert!(event.get("error").is_none(), "request {id} failed");
                    return event["result"].clone();
                }
            }
        }
        send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"buzz_native_test","version":"0.1.0"},"capabilities":{"experimentalApi":true}}})).await.unwrap();
        response(&mut received, 1).await;
        send(json!({"method":"initialized"})).await.unwrap();
        send(json!({"id":2,"method":"config/read","params":{"cwd":temp.path()}}))
            .await
            .unwrap();
        let mut servers = response(&mut received, 2).await["config"]["mcp_servers"].clone();
        // Codex config/read includes null options, which TOML cannot represent.
        fn clean(value: &mut Value) {
            if let Some(object) = value.as_object_mut() {
                object.retain(|_, value| !value.is_null());
                for value in object.values_mut() {
                    clean(value);
                }
            }
        }
        clean(&mut servers);
        if let Some(servers) = servers.as_object_mut() {
            for server in servers.values_mut() {
                server["enabled"] = json!(false);
            }
        } else {
            servers = json!({});
        }
        send(json!({"id":3,"method":"thread/start","params":{"model": std::env::var("BUZZ_CODEX_TEST_MODEL").unwrap_or("gpt-5.6-luna".into()),"cwd":temp.path(),"approvalPolicy":"never","sandbox":"workspace-write","config":{"mcp_servers":servers,"features.plugins":false,"features.apps":false,"sandbox_workspace_write.network_access":false}}})).await.unwrap();
        let thread = response(&mut received, 3).await["thread"]["id"].clone();
        send(json!({"id":4,"method":"turn/start","params":{"threadId":thread,"effort":"low","input":[{"type":"text","text":"Use your bash tool to run exactly: printf 'NATIVE_TOOL_OK' > native-proof.txt; cat native-proof.txt . Then reply NATIVE_TOOL_OK. Do not use any other tools.","text_elements":[]}]}})).await.unwrap();
        response(&mut received, 4).await;
        let completed = tokio::time::timeout(Duration::from_secs(180), async {
            let mut command = false;
            let mut answer = false;
            loop {
                let event = received.recv().await.unwrap();
                if event["method"] == "item/completed" {
                    let item = &event["params"]["item"];
                    command |= item["type"] == "commandExecution" && item["exitCode"] == 0;
                    answer |= item["type"] == "agentMessage"
                        && item["text"]
                            .as_str()
                            .is_some_and(|text| text.contains("NATIVE_TOOL_OK"));
                }
                if event["method"] == "turn/completed" {
                    assert_eq!(event["params"]["turn"]["status"], "completed");
                    assert!(
                        command && answer,
                        "native command and final response must cross the Tauri channel"
                    );
                    break;
                }
            }
        })
        .await;
        if let Err(error) = completed {
            processes.revoke(None);
            panic!("Codex turn did not complete: {error}");
        }
        assert_eq!(
            std::fs::read_to_string(temp.path().join("native-proof.txt")).unwrap(),
            "NATIVE_TOOL_OK"
        );
        send(json!({"id":5,"method":"turn/start","params":{"threadId":thread,"effort":"low","input":[{"type":"text","text":"Cancellation fixture: run bash exactly `echo $$ > background-pid; while [ ! -f background-release ]; do sleep 0.1; done; touch background-must-not-exist`. Keep polling this command; do not create the release file or finish the turn. The test driver will cancel you.","text_elements":[]}]}})).await.unwrap();
        response(&mut received, 5).await;
        let started = tokio::time::timeout(Duration::from_secs(60), async {
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            while !temp.path().join("background-pid").exists() {
                tick.tick().await;
            }
        })
        .await;
        // Exercise lifecycle revocation without a cooperative turn/interrupt.
        processes.revoke(None);
        started.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while received.recv().await.unwrap()["type"] != "exit" {}
        })
        .await
        .expect("native shutdown must complete");
        let pid: i32 = std::fs::read_to_string(temp.path().join("background-pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::fs::write(
            temp.path().join("background-release"),
            "release after cancellation",
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            while unsafe { libc::kill(pid, 0) } == 0 {
                tick.tick().await;
            }
        })
        .await
        .expect("Codex background shell must not survive app-server close");
        assert!(!temp.path().join("background-must-not-exist").exists());
    }
}
