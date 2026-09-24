use super::*;
use crate::config::{agent_id, HarnessEdit};
use crate::Secret;
use serde_json::json;
use std::fs;
use std::time::{Duration, Instant};
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
struct Memory;
impl Credentials for Memory {
    fn read_legacy(&self, _: crate::LegacySource, _: &str) -> Result<Secret> {
        panic!("Runtime must never import")
    }
    fn read(&self, _: &str, key: &str) -> Result<Option<Secret>> {
        Secret::parse(KEY, key).map(Some)
    }
    fn add(&self, _: &str, _: &Secret) -> Result<()> {
        panic!("Runtime must never write keys")
    }
}
fn agent(workspace: &Path) -> Agent {
    let relay_url = "wss://relay.example".to_owned();
    Agent {
        id: agent_id(PUB, &relay_url),
        pubkey: PUB.into(),
        relay_url,
        name: "Test agent".into(),
        system_prompt: "test prompt".into(),
        workspace: workspace.display().to_string(),
        harness: HarnessEdit {
            databricks: None,
            command: "buzz-agent".into(),
            args: vec![],
            model: "test-model".into(),
            provider: "test-provider".into(),
        },
        environment: BTreeMap::from([("PROVIDER_TEST_SETTING".into(), "explicit-value".into())]),
        revision: 1,
        enabled: false,
        credential_id: "test".into(),
        auth_tag: Some(crate::secret::test_attestation(PUB)),
        imported: json!({"record":{"respond_to":"owner-only","parallelism":2,"effort_level":"high"}}),
        extra: BTreeMap::new(),
    }
}
#[cfg(unix)]
fn bundle(directory: &Path) -> RuntimeBundle {
    use std::os::unix::fs::PermissionsExt;
    for name in [
        "buzz-acp",
        "buzz-agent",
        "buzz-dev-mcp",
        "buzz",
        "git-credential-nostr",
    ] {
        let path = directory.join(name);
        fs::write(&path, r#"#!/bin/sh
printf '%s\n' "$BUZZ_ACP_LAZY_POOL" "$BUZZ_ACP_IDLE_POOL_SLEEP" "$BUZZ_ACP_SYSTEM_PROMPT" "$BUZZ_ACP_MODEL" "$BUZZ_ACP_AGENT_ARGS" "$BUZZ_RELAY_URL" "$BUZZ_ACP_RESPOND_TO" "$BUZZ_MANAGED_AGENT" "$BUZZ_ACP_REPLAY_FLOOR" "$PROVIDER_TEST_SETTING" >> starts
printf '%s\n' "$BUZZ_AGENT_CONFIG_DIR" "$DATABRICKS_HOST" "$DATABRICKS_MODEL_FILTER" "${DATABRICKS_TOKEN-unset}" "$TMPDIR" "$PATH" > runtime-env
trap 'exit 0' TERM INT
while :; do /bin/sleep 0.1; done
"#).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let files: BTreeMap<_, _> = [
        "buzz-acp",
        "buzz-agent",
        "buzz-dev-mcp",
        "buzz",
        "git-credential-nostr",
    ]
    .into_iter()
    .map(|name| {
        use sha2::{Digest, Sha256};
        (
            name,
            format!(
                "{:x}",
                Sha256::digest(fs::read(directory.join(name)).unwrap())
            ),
        )
    })
    .collect();
    let source: serde_json::Value =
        serde_json::from_str(include_str!("../../../../runtime/agent-runtime.json")).unwrap();
    fs::write(directory.join("manifest.json"), serde_json::to_vec(&json!({"version":1,"revision":source["revision"],"target":env!("BUZZ_RUNTIME_TARGET"),"files":files})).unwrap()).unwrap();
    RuntimeBundle::new(directory.into()).unwrap()
}
fn wait_for_contents<T>(path: &Path, parse: impl Fn(&str) -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = fs::read_to_string(path).ok().and_then(|text| parse(&text)) {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "fixture did not publish complete output"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn fixture_worker(text: &str) -> Option<(i32, i32)> {
    let (leader, worker) = text.split_once(' ')?;
    let leader = leader.parse().ok()?;
    let worker = worker.parse().ok()?;
    (leader > 1 && worker > 1 && leader != worker).then_some((leader, worker))
}

// Independent of the production teardown being mutation-tested. The fixture
// records both PIDs in its private temp directory; verify session ownership
// before cleanup, including when an assertion unwinds.
#[cfg(unix)]
struct FixtureWorkerCleanup(PathBuf);
#[cfg(unix)]
impl Drop for FixtureWorkerCleanup {
    fn drop(&mut self) {
        if let Some((leader, worker)) = fs::read_to_string(&self.0)
            .ok()
            .and_then(|text| fixture_worker(&text))
        {
            if unsafe { libc::getsid(worker) } == leader {
                unsafe { libc::kill(worker, libc::SIGKILL) };
            }
        }
    }
}
#[test]
#[cfg(unix)]
fn actual_spawn_save_restart_stop_and_restore_contract() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let store_root = dir.path().join("config");
    let mut store = Store::open(store_root.clone()).unwrap();
    let a = agent(dir.path());
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let snapshot = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(snapshot.agents[0].status, ProcessStatus::Running));
    let first = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then(|| text.to_owned())
    });
    assert_eq!(first, "true\n900\ntest prompt\ntest-model\n\nwss://relay.example\nowner-only\n\n\nexplicit-value\n");
    controller.action(&a.id, Action::Start).unwrap();
    assert_eq!(controller.running.len(), 1);
    let edit = AgentEdit {
        name: "Edited".into(),
        system_prompt: "changed prompt".into(),
        workspace: a.workspace.clone(),
        harness: a.harness.clone(),
        environment: BTreeMap::new(),
    };
    let saved = controller.save(&a.id, 1, edit).unwrap();
    assert_eq!(saved.agents[0].revision, 2);
    assert_eq!(saved.agents[0].running_revision, Some(1));
    assert_eq!(
        fs::read_to_string(dir.path().join("starts")).unwrap(),
        first
    );
    let restarted = controller.action(&a.id, Action::Restart).unwrap();
    assert_eq!(restarted.agents[0].running_revision, Some(2));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fs::read_to_string(dir.path().join("starts"))
        .unwrap()
        .contains("changed prompt")
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    controller.shutdown().unwrap();
    assert!(controller.store.agents().unwrap()[0].enabled);
    let restored = controller.restore().unwrap();
    assert!(matches!(restored.agents[0].status, ProcessStatus::Running));
    let stopped = controller.action(&a.id, Action::Stop).unwrap();
    assert!(!stopped.agents[0].enabled);
    assert!(matches!(stopped.agents[0].status, ProcessStatus::Stopped));
    drop(controller);
    let mut controller = Controller::new(
        Store::open(store_root).unwrap(),
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let restored = controller.restore().unwrap();
    assert!(!restored.agents[0].enabled);
    assert!(controller.running.is_empty());
}
#[test]
#[cfg(unix)]
fn exact_command_has_no_ambient_identity_and_launch_failure_is_truthful() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let runtime = bundle(tools.path());
    let command = runtime
        .command_with_defaults(
            &a,
            &Secret::parse(KEY, PUB).unwrap(),
            &crate::BuildDefaults::default(),
        )
        .unwrap();
    let env: BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
        })
        .collect();
    assert_eq!(env["BUZZ_PRIVATE_KEY"], KEY);
    assert_eq!(env["NOSTR_PRIVATE_KEY"], KEY);
    assert_eq!(env["BUZZ_AUTH_TAG"], crate::secret::test_attestation(PUB));
    assert_eq!(env["BUZZ_ACP_AGENTS"], "2");
    assert_eq!(env["BUZZ_ACP_EFFORT_LEVEL"], "high");
    for absent in [
        "BUZZ_MANAGED_AGENT",
        "BUZZ_MANAGED_AGENT_START_NONCE",
        "BUZZ_ACP_REPLAY_FLOOR",
        "BUZZ_API_TOKEN",
        "GIT_CONFIG_COUNT",
    ] {
        assert!(!env.contains_key(absent));
    }
    assert_eq!(command.get_current_dir(), Some(dir.path()));
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Err("Runtime bundle is missing".into()),
        dir.path().join("ownership"),
    );
    let failed = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(failed.agents[0].status, ProcessStatus::Failed));
    assert!(failed.agents[0].enabled);
    assert!(controller.running.is_empty());
    let stopped = controller.action(&a.id, Action::Stop).unwrap();
    assert!(!stopped.agents[0].enabled);
}
#[test]
#[cfg(unix)]
fn teardown_reaps_a_worker_in_a_separate_process_group() {
    // Python is an isolated fixture only, not a production runtime dependency.
    if !Path::new("/usr/bin/python3").is_file() {
        panic!("Fixture requires /usr/bin/python3");
    }
    let dir = tempfile::tempdir().unwrap();
    let mut command = Command::new("/usr/bin/python3");
    command
        .args([
            "-c",
            r#"import os, subprocess, time, signal
signal.signal(signal.SIGTERM, signal.SIG_IGN)
# A stopped orphan group may receive SIGHUP when its leader dies. Ignore it so
# killing only the leader cannot accidentally satisfy the containment assertion.
signal.signal(signal.SIGHUP, signal.SIG_IGN)
worker = subprocess.Popen(['/bin/sleep', '60'], preexec_fn=os.setpgrp)
with open('worker.tmp', 'w') as f: f.write(str(os.getpid()) + ' ' + str(worker.pid))
os.rename('worker.tmp', 'worker')
while True: time.sleep(.1)
"#,
        ])
        .current_dir(dir.path())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut process = Process::spawn(&mut command).unwrap();
    let cleanup = FixtureWorkerCleanup(dir.path().join("worker"));
    let (leader, pid) = wait_for_contents(&cleanup.0, fixture_worker);
    assert_eq!(unsafe { libc::getsid(pid) }, leader);
    assert_eq!(unsafe { libc::getpgid(pid) }, pid);
    process.stop().unwrap();
    assert!(!process.alive().unwrap());
    // No live worker; a transient zombie awaiting init's reap is already exited.
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "worker survived: {state}"
    );
}

#[test]
fn attestation_cannot_change_owner_identity_or_conditions() {
    let valid = crate::secret::test_attestation(PUB);
    assert!(crate::secret::validate_attestation(&valid, PUB).is_ok());
    assert!(crate::secret::validate_attestation(&valid, &"ab".repeat(32)).is_err());
    let mut tag: Vec<String> = serde_json::from_str(&valid).unwrap();
    tag[2] = "kind=9".into();
    assert!(
        crate::secret::validate_attestation(&serde_json::to_string(&tag).unwrap(), PUB).is_err()
    );
    assert!(crate::secret::validate_attestation("not-a-tag", PUB).is_err());
}

#[test]
#[cfg(unix)]
fn start_refuses_an_attestation_for_a_different_agent() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut a = agent(dir.path());
    a.auth_tag = Some(crate::secret::test_attestation(&"ab".repeat(32)));
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let failed = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(failed.agents[0].status, ProcessStatus::Failed));
    assert_eq!(
        failed.agents[0].error.as_deref(),
        Some("Owner attestation does not authorize this agent key")
    );
    assert_eq!(failed.agents[0].running_revision, None);
    assert!(controller.running.is_empty());
    assert!(!dir.path().join("starts").exists());
}

#[test]
#[cfg(unix)]
fn stop_reaches_owned_process_when_store_is_malformed_or_row_disappears() {
    for contents in ["{malformed", r#"{"version":1,"agents":[]}"#] {
        let dir = tempfile::tempdir().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let mut store = Store::open(config.clone()).unwrap();
        let a = agent(dir.path());
        store.insert(vec![a.clone()]).unwrap();
        let mut controller = Controller::new(
            store,
            Arc::new(Memory),
            Ok(bundle(tools.path())),
            dir.path().join("ownership"),
        );
        controller.action(&a.id, Action::Start).unwrap();
        wait_for_contents(&dir.path().join("starts"), |text| {
            (text.lines().count() == 10).then_some(())
        });
        fs::write(config.join("agents.json"), contents).unwrap();
        assert!(
            controller.action(&a.id, Action::Stop).is_err(),
            "must report failed durable disable"
        );
        assert!(
            controller.running.is_empty(),
            "Stop must reach owned process despite invalid storage"
        );
        assert_eq!(
            fs::read_to_string(config.join("agents.json")).unwrap(),
            contents
        );
    }
}

#[test]
#[cfg(unix)]
fn explicit_provider_environment_wins_and_blank_selectors_do_not_erase_it() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let runtime = bundle(tools.path());
    fs::copy(tools.path().join("buzz-agent"), tools.path().join("goose")).unwrap();
    for (worker, model_key, provider_key) in [
        ("buzz-agent", "BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER"),
        ("goose", "GOOSE_MODEL", "GOOSE_PROVIDER"),
    ] {
        for selectors in ["", "conflicting-selector"] {
            let mut a = agent(dir.path());
            if worker == "goose" {
                a.harness.command = tools.path().join(worker).display().to_string();
            }
            a.harness.provider = selectors.into();
            a.harness.model = selectors.into();
            a.environment
                .insert(provider_key.into(), "databricks".into());
            a.environment
                .insert(model_key.into(), "fixture-model".into());
            let command = runtime
                .command_with_defaults(
                    &a,
                    &Secret::parse(KEY, PUB).unwrap(),
                    &crate::BuildDefaults::default(),
                )
                .unwrap();
            let env: BTreeMap<_, _> = command
                .get_envs()
                .filter_map(|(k, v)| {
                    v.map(|v| {
                        (
                            k.to_string_lossy().into_owned(),
                            v.to_string_lossy().into_owned(),
                        )
                    })
                })
                .collect();
            assert_eq!(env[provider_key], "databricks");
            assert_eq!(env[model_key], "fixture-model");
            assert_eq!(env["BUZZ_ACP_MODEL"], "fixture-model");
        }
    }
}

#[test]
#[cfg(unix)]
fn blank_selectors_without_overrides_leave_harness_defaults_intact() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let runtime = bundle(tools.path());
    let mut a = agent(dir.path());
    a.harness.provider.clear();
    a.harness.model.clear();
    let command = runtime
        .command_with_defaults(
            &a,
            &Secret::parse(KEY, PUB).unwrap(),
            &crate::BuildDefaults::default(),
        )
        .unwrap();
    let env: BTreeMap<_, _> = command.get_envs().collect();
    for key in ["BUZZ_AGENT_PROVIDER", "BUZZ_AGENT_MODEL", "BUZZ_ACP_MODEL"] {
        assert!(!env.contains_key(std::ffi::OsStr::new(key)));
    }
}

#[test]
#[cfg(unix)]
fn start_and_restart_reject_missing_saved_identities() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut controller = Controller::new(
        Store::open(dir.path().join("config")).unwrap(),
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    for action in [Action::Start, Action::Restart] {
        assert!(controller.action("missing", action).is_err());
    }
    assert!(controller.running.is_empty());
}

#[test]
#[cfg(unix)]
fn shared_cache_spawn_capture_disconnect_snapshot_and_private_temp_cleanup() {
    use crate::connection::DatabricksSettings;
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut a = agent(dir.path());
    a.harness.provider = "databricks_v2".into();
    a.harness.databricks = Some(DatabricksSettings {
        host: "https://EXAMPLE.com:443/".into(),
        filter: "foo*".into(),
    });
    // TMPDIR and PATH can be supplied by settings, but the app's private runtime
    // storage and bundled tools are authoritative.
    a.environment
        .insert("TMPDIR".into(), "/unusable-user-override".into());
    let config = dir.path().join("config");
    let mut store = Store::open(config.clone()).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let runtime = bundle(tools.path());
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(runtime),
        dir.path().join("ownership"),
    );
    let started = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(started.agents[0].status, ProcessStatus::Running));
    let env = wait_for_contents(&dir.path().join("runtime-env"), |text| {
        (text.lines().count() == 6).then(|| text.lines().map(str::to_owned).collect::<Vec<_>>())
    });
    assert_eq!(env[0], config.to_str().unwrap());
    assert_eq!(env[1], "https://example.com");
    assert_eq!(env[2], "foo*");
    assert_eq!(env[3], "unset");
    assert!(env[5].starts_with(tools.path().to_str().unwrap()));
    let run = &controller.running[&a.id];
    assert_eq!(run.databricks_host.as_deref(), Some("https://example.com"));
    let temp = run.temporary.as_ref().unwrap().path().to_owned();
    assert!(temp.starts_with(config.join("runs")));
    assert_eq!(env[4], temp.to_str().unwrap());
    let cache = config.join("buzz-agent/oauth/databricks");
    assert!(cache.is_dir());
    let edit = AgentEdit {
        name: a.name.clone(),
        system_prompt: a.system_prompt.clone(),
        workspace: a.workspace.clone(),
        harness: HarnessEdit {
            databricks: Some(DatabricksSettings {
                host: "https://other.example.com".into(),
                filter: "".into(),
            }),
            ..a.harness.clone()
        },
        environment: BTreeMap::new(),
    };
    controller.save(&a.id, 1, edit).unwrap();
    assert!(controller
        .disconnect("https://example.com")
        .unwrap_err()
        .contains("Stop agents"));
    controller.disconnect("https://other.example.com").unwrap();
    controller.action(&a.id, Action::Stop).unwrap();
    assert!(!temp.exists());
    controller.disconnect("https://example.com").unwrap();
}

#[test]
#[cfg(unix)]
fn bundle_rejects_a_revision_different_from_the_runtime_spec() {
    let tools = tempfile::tempdir().unwrap();
    bundle(tools.path());
    let path = tools.path().join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["revision"] = json!("0".repeat(40));
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(matches!(
        RuntimeBundle::new(tools.path().into()),
        Err(error) if error == "Runtime target/revision does not match this app"
    ));
}

#[test]
#[cfg(unix)]
fn manifest_integrity_and_exact_identity_exclusion_across_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let mut first = Store::open(dir.path().join("first")).unwrap();
    first.insert(vec![a.clone()]).unwrap();
    let mut second = Store::open(dir.path().join("second")).unwrap();
    second.insert(vec![a.clone()]).unwrap();
    let shared = dir.path().join("ownership");
    let mut first = Controller::new(
        first,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        shared.clone(),
    );
    let mut second = Controller::new(
        second,
        Arc::new(Memory),
        Ok(RuntimeBundle::new(tools.path().into()).unwrap()),
        shared,
    );
    first.action(&a.id, Action::Start).unwrap();
    let blocked = second.action(&a.id, Action::Start).unwrap();
    assert!(blocked.agents[0]
        .error
        .as_deref()
        .unwrap()
        .contains("Another buzz-app profile"));
    first.action(&a.id, Action::Stop).unwrap();
    assert!(matches!(
        second.action(&a.id, Action::Start).unwrap().agents[0].status,
        ProcessStatus::Running
    ));
    second.action(&a.id, Action::Stop).unwrap();
    fs::write(tools.path().join("buzz-agent"), "tampered").unwrap();
    let failed = second.action(&a.id, Action::Start).unwrap();
    assert!(failed.agents[0]
        .error
        .as_deref()
        .unwrap()
        .contains("integrity"));
    assert!(second.running.is_empty());
    assert!(RuntimeBundle::new(tools.path().into()).is_err());
}

#[test]
#[cfg(unix)]
#[ignore = "requires immutable staged runtime resources; run explicitly after build-agent-runtime"]
fn actual_bundled_acp_lazy_listener_start_restart_stop_and_quit_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/resources/agent-runtime")
        .canonicalize()
        .unwrap();
    let mut a = agent(dir.path());
    a.harness.provider = "databricks_v2".into();
    a.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://workspace.example.invalid".into(),
        filter: "".into(),
    });
    // Bind/retain a closed-to-WS listener locally: no external relay or live agent.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    a.relay_url = format!("wss://127.0.0.1:{}", listener.local_addr().unwrap().port());
    a.id = agent_id(PUB, &a.relay_url);
    let config = dir.path().join("config");
    let mut store = Store::open(config.clone()).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        RuntimeBundle::new(tools),
        dir.path().join("ownership"),
    );
    for action in [Action::Start, Action::Restart] {
        let result = controller.action(&a.id, action).unwrap();
        assert!(
            matches!(result.agents[0].status, ProcessStatus::Running),
            "{:?}",
            result.agents[0].error
        );
        std::thread::sleep(Duration::from_millis(250));
        let result = controller.snapshot().unwrap();
        assert!(
            matches!(result.agents[0].status, ProcessStatus::Running),
            "{:?}",
            result.agents[0].error
        );
    }
    let temp = controller.running[&a.id]
        .temporary
        .as_ref()
        .unwrap()
        .path()
        .to_owned();
    assert!(temp.exists());
    controller.action(&a.id, Action::Stop).unwrap();
    assert!(!temp.exists());
    assert!(!controller.store.agents().unwrap()[0].enabled);
    controller.action(&a.id, Action::Start).unwrap();
    let temp = controller.running[&a.id]
        .temporary
        .as_ref()
        .unwrap()
        .path()
        .to_owned();
    controller.shutdown().unwrap();
    assert!(!temp.exists());
    assert!(controller.store.agents().unwrap()[0].enabled);
    assert!(controller.running.is_empty());
}

#[test]
#[cfg(unix)]
fn mention_start_forwards_replay_floor_without_persisting_or_restoring_it() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let a = agent(dir.path());
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let key = Secret::parse(KEY, PUB).unwrap();
    let result = controller
        .action_with_key(&a.id, Action::Start, 1, &key, Some(1234567890))
        .unwrap();
    assert!(result.agents[0].enabled);
    assert!(matches!(result.agents[0].status, ProcessStatus::Running));
    let output = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then(|| text.to_owned())
    });
    assert_eq!(output.lines().nth(8), Some("1234567890"));
    assert!(!fs::read_to_string(dir.path().join("config/agents.json"))
        .unwrap()
        .contains("1234567890"));
    controller.shutdown().unwrap();
    controller.restore().unwrap();
    let output = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 20).then(|| text.to_owned())
    });
    assert_eq!(output.lines().nth(18), Some(""));
    controller.action(&a.id, Action::Stop).unwrap();
}

fn deployment_defaults() -> crate::BuildDefaults {
    crate::BuildDefaults {
        host: "https://build.example.com".into(),
        filter: "team-*".into(),
        model: "build-model".into(),
        provider: "databricks_v2".into(),
        owner_only: true,
    }
}

#[cfg(unix)]
#[test]
fn build_floor_agrees_at_command_oauth_and_discovery_without_rewriting_saved_agent() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = bundle(dir.path());
    let mut agent = agent(dir.path());
    agent.harness.provider.clear();
    agent.harness.model.clear();
    agent.imported["record"]["respond_to"] = json!("anyone");
    let before = serde_json::to_value(&agent).unwrap();
    let defaults = deployment_defaults();
    let key = Secret::parse(KEY, PUB).unwrap();
    let command = bundle
        .command_with_defaults(&agent, &key, &defaults)
        .unwrap();
    let env: BTreeMap<_, _> = command
        .get_envs()
        .map(|(k, v)| (k.to_str().unwrap(), v.and_then(|v| v.to_str())))
        .collect();
    assert_eq!(env["BUZZ_AGENT_PROVIDER"], Some("databricks_v2"));
    assert_eq!(env["BUZZ_AGENT_MODEL"], Some("build-model"));
    assert_eq!(env["BUZZ_ACP_MODEL"], Some("build-model"));
    assert_eq!(env["BUZZ_ACP_RESPOND_TO"], Some("owner-only"));
    assert_eq!(env["BUZZ_ACP_ALLOWED_RESPOND_TO"], Some("owner-only"));
    assert_eq!(
        env.get("BUZZ_ACP_RESPOND_TO_ALLOWLIST").copied().flatten(),
        None
    );
    let settings = databricks_with_defaults(&agent, &defaults)
        .unwrap()
        .unwrap();
    let context =
        model_context_with_defaults(&agent.harness, &agent.environment, &defaults).unwrap();
    assert_eq!(context.host.as_deref(), Some(settings.host.as_str()));
    assert_eq!(context.filter.as_deref(), Some(settings.filter.as_str()));
    assert_eq!(settings.host, defaults.host);
    assert_eq!(serde_json::to_value(&agent).unwrap(), before);
    // Default-on is a presence capability; unmarked builds retain imported policy.
    let public = crate::BuildDefaults::default();
    let command = bundle.command_with_defaults(&agent, &key, &public).unwrap();
    assert!(command
        .get_envs()
        .any(|(k, v)| k == "BUZZ_ACP_RESPOND_TO" && v == Some(std::ffi::OsStr::new("anyone"))));
}

#[test]
fn saved_selectors_and_environment_override_build_floor_including_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = agent(dir.path());
    let defaults = deployment_defaults();
    agent.harness.provider = "databricks_v2".into();
    agent.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://saved.example.com".into(),
        filter: "".into(),
    });
    let harness = defaults.resolve(&agent.harness, &agent.environment);
    assert_eq!(harness.model, "test-model");
    assert_eq!(
        databricks_with_defaults(&agent, &defaults)
            .unwrap()
            .unwrap()
            .host,
        "https://saved.example.com"
    );
    agent.environment.insert(
        "DATABRICKS_HOST".into(),
        "https://override.example.com".into(),
    );
    let context =
        model_context_with_defaults(&agent.harness, &agent.environment, &defaults).unwrap();
    assert_eq!(
        context.host.as_deref(),
        Some("https://override.example.com")
    );
    assert_eq!(context.filter.as_deref(), Some(""));
    agent
        .environment
        .insert("BUZZ_AGENT_MODEL".into(), "".into());
    assert!(defaults
        .resolve(&agent.harness, &agent.environment)
        .model
        .is_empty());
    agent
        .environment
        .insert("DATABRICKS_HOST".into(), "".into());
    assert!(databricks_with_defaults(&agent, &defaults).is_err());
    agent
        .environment
        .insert("BUZZ_AGENT_PROVIDER".into(), "".into());
    assert!(databricks_with_defaults(&agent, &defaults)
        .unwrap()
        .is_none());
    assert!(model_context_with_defaults(&agent.harness, &agent.environment, &defaults).is_err());
    agent.environment.remove("BUZZ_AGENT_PROVIDER");
    agent
        .environment
        .insert("DATABRICKS_TOKEN".into(), "SYNTHETIC".into());
    assert!(databricks_with_defaults(&agent, &defaults).is_err());
    assert!(model_context_with_defaults(&agent.harness, &agent.environment, &defaults).is_err());
}

#[test]
fn external_harnesses_never_receive_buzz_agent_build_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = agent(dir.path());
    agent.harness.command = "/usr/local/bin/goose".into();
    agent.harness.provider.clear();
    agent.harness.model.clear();
    let harness = deployment_defaults().resolve(&agent.harness, &agent.environment);
    assert!(harness.provider.is_empty());
    assert!(harness.model.is_empty());
    assert!(harness.databricks.is_none());
}

#[test]
#[cfg(unix)]
fn goose_model_context_uses_effective_draft_provider_without_projecting_secrets() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let goose = dir.path().join("goose");
    fs::write(&goose, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&goose, fs::Permissions::from_mode(0o700)).unwrap();
    let edit = |override_provider: Option<&str>| AgentEdit {
        name: "Goose".into(),
        system_prompt: String::new(),
        workspace: dir.path().display().to_string(),
        harness: HarnessEdit {
            command: goose.display().to_string(),
            args: vec!["acp".into()],
            model: "short-name".into(),
            provider: "databricks_v2".into(),
            databricks: None,
        },
        environment: BTreeMap::from([
            (
                "DATABRICKS_HOST".into(),
                Some("https://workspace.example".into()),
            ),
            ("GOOSE_MODEL".into(), Some("effective-model".into())),
            (
                "GOOSE_PROVIDER".into(),
                override_provider.map(str::to_owned),
            ),
        ]),
    };
    let context = Controller::draft_goose_model_context(edit(None)).unwrap();
    assert_eq!(context.command, goose);
    assert!(context.model_overridden);
    assert_eq!(
        context.environment["DATABRICKS_HOST"],
        "https://workspace.example"
    );
    assert!(!context.environment.contains_key("GOOSE_PROVIDER"));
    assert!(Controller::draft_goose_model_context(edit(Some("openai"))).is_err());
}

#[test]
fn discovery_accepts_only_v2_from_saved_environment_or_build_provider() {
    let dir = tempfile::tempdir().unwrap();
    for provider in ["databricks_v2", "databricks-v2", "databricks"] {
        for source in ["saved", "environment", "build"] {
            let mut agent = agent(dir.path());
            let mut defaults = deployment_defaults();
            agent.harness.provider.clear();
            match source {
                "saved" => agent.harness.provider = provider.into(),
                "environment" => {
                    agent
                        .environment
                        .insert("BUZZ_AGENT_PROVIDER".into(), provider.into());
                }
                _ => defaults.provider = provider.into(),
            }
            let context =
                model_context_with_defaults(&agent.harness, &agent.environment, &defaults);
            assert_eq!(
                context.is_ok(),
                provider != "databricks",
                "{source}: {provider}"
            );
            // Legacy manual selection still resolves the same OAuth workspace for Start.
            assert_eq!(
                databricks_with_defaults(&agent, &defaults)
                    .unwrap()
                    .unwrap()
                    .host,
                defaults.host
            );
        }
    }
}

#[test]
#[cfg(unix)]
fn pi_selection_and_extensions_survive_save_reopen_and_reach_adapter() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let runtime = bundle(tools.path());
    let adapter = tools.path().join("buzz-pi-acp");
    fs::write(&adapter, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
    let extension = tools.path().join("extension with spaces.ts");
    fs::write(&extension, "export default function() {};").unwrap();
    let mut a = agent(dir.path());
    a.harness.command = adapter.display().to_string();
    a.imported["record"]["respond_to"] = json!("anyone");
    a.harness.provider = "custom".into();
    a.harness.model = "namespace/exact.id".into();
    a.harness.args = vec![
        "--".into(),
        "--extension".into(),
        extension.display().to_string(),
    ];
    for tool in ["pi", "node"] {
        fs::copy(&adapter, tools.path().join(tool)).unwrap();
    }
    a.environment.insert(
        "PI_CODING_AGENT_DIR".into(),
        dir.path().display().to_string(),
    );
    let root = dir.path().join("config");
    Store::open(root.clone())
        .unwrap()
        .insert(vec![a.clone()])
        .unwrap();
    let store = Store::open(root).unwrap();
    let saved = store.agents().unwrap().remove(0);
    let key = Secret::parse(KEY, PUB).unwrap();
    let command = runtime
        .command_with_defaults(&saved, &key, &deployment_defaults())
        .unwrap();
    let env: BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(k, v)| v.map(|v| (k.to_str().unwrap(), v.to_str().unwrap())))
        .collect();
    assert_eq!(env["BUZZ_ACP_MODEL"], "custom/namespace/exact.id");
    assert_eq!(env["BUZZ_ACP_RESPOND_TO"], "owner-only");
    assert_eq!(env["BUZZ_ACP_ALLOWED_RESPOND_TO"], "owner-only");
    for key in [
        "BUZZ_AGENT_PROVIDER",
        "BUZZ_AGENT_MODEL",
        "DATABRICKS_HOST",
        "DATABRICKS_MODEL_FILTER",
    ] {
        assert!(!env.contains_key(key));
    }
    assert_eq!(
        env["BUZZ_ACP_AGENT_ARGS"],
        format!(
            "--,--extension,{},--provider,custom,--model,namespace/exact.id",
            extension.display()
        )
    );
    assert!(!env.contains_key("GOOSE_MODEL"));
    let controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(runtime),
        dir.path().join("ownership"),
    );
    let edit = AgentEdit {
        name: a.name.clone(),
        system_prompt: a.system_prompt.clone(),
        workspace: a.workspace.clone(),
        harness: a.harness.clone(),
        environment: BTreeMap::new(),
    };
    let context = controller.pi_model_context(&a.id, 1, edit.clone()).unwrap();
    assert_eq!(context.args, a.harness.args[1..]);
    assert_eq!(
        context.environment["PI_CODING_AGENT_DIR"],
        dir.path().display().to_string()
    );
    assert!(controller.pi_model_context(&a.id, 2, edit.clone()).is_err());
    let mut patch = edit.clone();
    patch.environment.insert(
        "PI_CODING_AGENT_DIR".into(),
        Some("/override/config".into()),
    );
    let context = controller
        .pi_model_context(&a.id, 1, patch.clone())
        .unwrap();
    assert_eq!(
        context.environment["PI_CODING_AGENT_DIR"],
        "/override/config"
    );
    patch.environment.insert("PI_CODING_AGENT_DIR".into(), None);
    assert!(!controller
        .pi_model_context(&a.id, 1, patch)
        .unwrap()
        .environment
        .contains_key("PI_CODING_AGENT_DIR"));
    // Draft resolution did not mutate the saved override.
    assert_eq!(
        controller.store.agents().unwrap()[0].environment["PI_CODING_AGENT_DIR"],
        a.environment["PI_CODING_AGENT_DIR"]
    );
    for (provider, model) in [
        ("custom".to_owned(), "a,b".to_owned()),
        ("custom".to_owned(), "-model".to_owned()),
        ("custom,other".to_owned(), "model".to_owned()),
        ("-provider".to_owned(), "model".to_owned()),
        ("bad/provider".to_owned(), "model".to_owned()),
        ("p".repeat(129), "model".to_owned()),
        ("custom".to_owned(), "m".repeat(513)),
    ] {
        let mut invalid = saved.clone();
        invalid.harness.provider = provider;
        invalid.harness.model = model;
        assert!(controller
            .bundle
            .as_ref()
            .unwrap()
            .command(&invalid, &key)
            .is_err());
    }
    let mut configured = saved.clone();
    configured.harness.model.clear();
    assert!(controller
        .bundle
        .as_ref()
        .unwrap()
        .command(&configured, &key)
        .unwrap_err()
        .contains("Choose a Pi model"));
    configured.harness.provider.clear();
    configured.harness.args = vec![
        "--".into(),
        "--thinking".into(),
        "high".into(),
        "--skill".into(),
        "/local/skill".into(),
        "--tools".into(),
        "read".into(),
    ];
    let launch = controller
        .bundle
        .as_ref()
        .unwrap()
        .command_with_defaults(&configured, &key, &deployment_defaults())
        .unwrap();
    assert!(launch.get_envs().all(|(key, _)| key != "BUZZ_ACP_MODEL"));
    assert_eq!(
        launch
            .get_envs()
            .find(|(k, _)| *k == "BUZZ_ACP_AGENT_ARGS")
            .unwrap()
            .1
            .unwrap(),
        "--,--thinking,high,--skill,/local/skill,--tools,read"
    );
    let mut advanced = edit;
    advanced.harness.args = configured.harness.args.clone();
    let context = Controller::draft_pi_model_context(advanced.clone()).unwrap();
    assert_eq!(
        context.catalog_args().unwrap(),
        configured.harness.args[1..]
    );
    advanced.harness.args = vec![
        "--".into(),
        "--provider".into(),
        "old".into(),
        "--model".into(),
        "invalid".into(),
    ];
    assert!(Controller::draft_pi_model_context(advanced.clone())
        .unwrap()
        .catalog_args()
        .unwrap()
        .is_empty());
    for unsupported in [
        vec!["--custom-extension-flag"],
        vec!["--extension=/local/extension.ts"],
        vec!["--api-key", "synthetic-key"],
        vec!["a prompt"],
    ] {
        advanced.harness.args = std::iter::once("--")
            .chain(unsupported)
            .map(str::to_owned)
            .collect();
        assert!(Controller::draft_pi_model_context(advanced.clone())
            .unwrap()
            .catalog_args()
            .is_err());
        configured.harness.args = advanced.harness.args.clone();
        assert!(controller
            .bundle
            .as_ref()
            .unwrap()
            .command(&configured, &key)
            .is_ok());
    }
}
