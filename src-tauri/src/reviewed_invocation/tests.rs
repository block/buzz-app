use super::*;
#[cfg(target_os = "macos")]
use buzzodz_plugins::ReviewedInvocation;
#[cfg(target_os = "macos")]
fn granted(
    manager: &Manager,
    id: &str,
    revision: &str,
    operation: &str,
) -> Result<ReviewedInvocation, String> {
    manager
        .admit_reviewed_invocation(id, revision, operation)
        .map(|(grant, _)| grant)
}

fn request() -> Request {
    Request {
        operation: "synthetic".into(),
        body: "Exact original prompt".into(),
        version: None,
        effect: None,
        disclosure: None,
        expected_media: None,
        destination: Destination {
            community: "fixture-community".into(),
            viewer: "fixture-viewer".into(),
            channel: "fixture-channel-a".into(),
            root: None,
            source_root: None,
        },
    }
}
#[test]
fn request_and_destination_are_frozen_digest_inputs() {
    let original = request();
    original.validate().unwrap();
    let mut changed = original.clone();
    changed.destination.channel = "fixture-channel-b".into();
    assert_ne!(original.digest(None), changed.digest(None));
    changed = original.clone();
    changed.body.push('!');
    assert_ne!(original.digest(None), changed.digest(None));
    changed = original;
    changed.operation = "other".into();
    assert_ne!(request().digest(None), changed.digest(None));
    for destination in ["", "https://example.test/?token=secret", "has\ncontrol"] {
        changed.destination.channel = destination.into();
        assert!(changed.validate().is_err());
    }
    changed = request();
    changed.body = "x".repeat(32 * 1024 + 1);
    assert!(changed.validate().is_err());
}
fn expecting(media: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "operation": "create", "body": "{}", "version": 1,
        "effect": {"kind":"credential-http", "method":"POST", "url":"https://fixture.test/v1/tasks", "headers":{}, "slot":"key"},
        "disclosure": {"version":"fixture/1", "text":"Offline"},
        "destination": {"community":"fixture-community", "viewer":"fixture-viewer", "channel":"fixture-channel-a"},
        "expectedMedia": media,
    })
}
fn media() -> serde_json::Value {
    serde_json::json!({"version":1, "kind":"video", "container":"mp4", "codec":"h264",
        "width":1280, "height":720, "durationMs":5000, "toleranceMs":50, "maxBytes":16 * 1024 * 1024})
}
#[test]
fn expected_media_is_a_closed_bounded_digest_input() {
    let parse = |value| serde_json::from_value::<Request>(value);
    let frozen = parse(expecting(media())).unwrap();
    frozen.validate().unwrap();
    let mut legacy = expecting(media());
    legacy.as_object_mut().unwrap().remove("expectedMedia");
    let legacy = parse(legacy).unwrap();
    legacy.validate().unwrap();
    assert!(!String::from_utf8(serde_json::to_vec(&legacy).unwrap())
        .unwrap()
        .contains("expectedMedia"));
    assert_ne!(frozen.digest(None), legacy.digest(None));
    for (field, value) in [
        ("width", serde_json::json!(1281)),
        ("height", serde_json::json!(0)),
        ("width", serde_json::json!(4096)),
        ("durationMs", serde_json::json!(0)),
        ("durationMs", serde_json::json!(600_001)),
        ("toleranceMs", serde_json::json!(101)),
        ("maxBytes", serde_json::json!(16 * 1024 * 1024 + 1)),
        ("kind", serde_json::json!("audio")),
        ("container", serde_json::json!("mov")),
        ("codec", serde_json::json!("hevc")),
        ("version", serde_json::json!(2)),
    ] {
        let mut changed = media();
        changed[field] = value;
        assert!(
            parse(expecting(changed)).map_or(true, |r| r.validate().is_err()),
            "{field}"
        );
    }
    // Portrait inside the envelope, and tolerance below a short duration.
    let mut portrait = media();
    (portrait["width"], portrait["height"]) = (720.into(), 1280.into());
    parse(expecting(portrait.clone()))
        .unwrap()
        .validate()
        .unwrap();
    assert_ne!(
        parse(expecting(portrait)).unwrap().digest(None),
        frozen.digest(None)
    );
    let mut short = media();
    (short["durationMs"], short["toleranceMs"]) = (50.into(), 50.into());
    assert!(parse(expecting(short)).unwrap().validate().is_err());
    for (field, value) in [
        ("width", serde_json::json!(1280.5)),
        ("maxBytes", serde_json::json!(-1)),
        ("strictDecode", serde_json::json!(false)),
        ("url", serde_json::json!("https://fixture.test/out.mp4")),
    ] {
        let mut changed = media();
        changed[field] = value;
        assert!(parse(expecting(changed)).is_err(), "{field}");
    }
    let mut synthetic = serde_json::to_value(request()).unwrap();
    synthetic["expectedMedia"] = media();
    assert!(parse(synthetic).unwrap().validate().is_err());
}
#[test]
fn retirement_cannot_be_renewed_and_consumption_precedes_dispatch() {
    let state = Invocations::default();
    let call = uuid::Uuid::new_v4().to_string();
    state.cancel(&call);
    assert!(state.reserve(&call, "example.plugin").is_err());
    let call = uuid::Uuid::new_v4().to_string();
    state.reserve(&call, "example.plugin").unwrap();
    assert!(state
        .reserve(&uuid::Uuid::new_v4().to_string(), "other.plugin")
        .is_err());
    let attempts = std::sync::atomic::AtomicUsize::new(0);
    let dispatch = || {
        attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err::<(), _>(UNKNOWN.into())
    };
    assert!(state.consume(&call, dispatch).is_err());
    assert!(!state.live(&call));
    assert!(state.consume(&call, dispatch).is_err());
    assert!(state.reserve(&call, "example.plugin").is_err());
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(state
        .reserve("before-owner-return", "example.plugin")
        .is_err());
    state.end_review(&call);
    for retire_all in [false, true] {
        let call = uuid::Uuid::new_v4().to_string();
        state.reserve(&call, "example.plugin").unwrap();
        if retire_all {
            state.clear();
        } else {
            state.retire("example.plugin");
        }
        assert!(state.consume(&call, dispatch).is_err());
        state.end_review(&call);
    }
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
}
#[test]
fn concurrent_dispatch_has_one_winner() {
    let state = Invocations::default();
    let call = uuid::Uuid::new_v4().to_string();
    state.reserve(&call, "example.plugin").unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let (state, call, barrier) = (state.clone(), call.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                state.consume(&call, || Ok(())).is_ok()
            })
        })
        .collect();
    barrier.wait();
    assert_eq!(
        threads
            .into_iter()
            .map(|t| usize::from(t.join().unwrap()))
            .sum::<usize>(),
        1
    );
}
#[cfg(target_os = "macos")]
#[test]
fn grant_uses_actual_installed_current_enabled_artifact() {
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(root.path().join("data")), "test", false).unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    let manifest = serde_json::json!({ "id":"example.review", "name":"Review fixture", "apiVersion":1,
        "host":{"reviewedInvocations":[{"id":"synthetic","artifact":{"path":"/fixture/recipient","sha256":"ab".repeat(32)}}]} });
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.review")
        .unwrap()
        .revision;
    assert!(granted(&manager, "example.review", &revision, "synthetic").is_err());
    manager.change("enable", "example.review").unwrap();
    let grant = granted(&manager, "example.review", &revision, "synthetic").unwrap();
    assert_eq!(grant.artifact.unwrap().path, "/fixture/recipient");
    assert!(granted(&manager, "example.review", "bundled", "synthetic").is_err());
    assert!(granted(&manager, "example.review", &revision, "other").is_err());
    std::fs::write(
        source.join("plugin.js"),
        "export function apply() { /*new revision*/ }",
    )
    .unwrap();
    manager.change("disable", "example.review").unwrap();
    let next = manager
        .reload("example.review")
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.review")
        .unwrap()
        .revision;
    assert_ne!(revision, next);
    assert!(granted(&manager, "example.review", &revision, "synthetic").is_err());
    manager.change("enable", "example.review").unwrap();
    assert!(granted(&manager, "example.review", &next, "synthetic").is_ok());
    manager.change("disable", "example.review").unwrap();
    assert!(granted(&manager, "example.review", &next, "synthetic").is_err());
}
#[test]
fn support_reports_only_implemented_pieces_without_authority() {
    let value = serde_json::to_value(support()).unwrap();
    if cfg!(target_os = "macos") {
        assert_eq!(
            value,
            serde_json::json!({
                "version": 1,
                "synthetic": true,
                "credentialHttp": {
                    "version": 1,
                    "createResponse": true,
                    "continuation": true,
                    "expectedMedia": 1,
                    "result": true,
                    "delivery": true,
                    "resultUrl": 1,
                },
            })
        );
    } else {
        assert_eq!(
            value,
            serde_json::json!({ "version": 1, "synthetic": false, "credentialHttp": null })
        );
    }
}
#[test]
fn only_a_declared_pointer_at_a_200_public_https_url_selects_a_result() {
    let grant = |pointer: Option<&str>| -> ReviewedInvocation {
        serde_json::from_value(
            serde_json::json!({"id":"create", "credentialHttp":{"version":1, "slot":"key",
            "resultUrl": pointer.map(|p| serde_json::json!({"version":1, "jsonPointer":p}))}}),
        )
        .unwrap()
    };
    let body = |url: &str| serde_json::json!({"output":[url], "a/b":{"~":url}}).to_string();
    let url = "https://media.example.com/v.mp4?sig=a%2Fb&e=1";
    let declared = grant(Some("/output/0"));
    assert_eq!(select(&declared, (200, &body(url))).unwrap().as_str(), url);
    assert_eq!(
        select(&grant(Some("/a~1b/~0")), (200, &body(url)))
            .unwrap()
            .as_str(),
        url
    );
    assert!(
        select(&grant(None), (200, &body(url))).is_none(),
        "no pointer, no authority"
    );
    assert!(select(&declared, (201, &body(url))).is_none());
    assert!(select(&grant(Some("/output/1")), (200, &body(url))).is_none());
    for unsafe_url in [
        "http://media.example.com/v",
        "https://user@media.example.com/v",
        "https://media.example.com/v#f",
        "https://media.example.com/a b",
        "https://MEDIA.example.com/v",
        "https://localhost/v",
        "https://media.local/v",
        "https://intranet/v",
        "https://10.0.0.1/v",
        "https://[::1]/v",
        "https://169.254.169.254/latest",
    ] {
        assert!(
            select(&declared, (200, &body(unsafe_url))).is_none(),
            "{unsafe_url}"
        );
    }
    let long = format!("https://media.example.com/{}", "a".repeat(2048));
    assert!(select(&declared, (200, &body(&long))).is_none());
}
#[test]
fn no_runtime_recipient_arguments_secret_or_acceptance_fields() {
    for field in [
        "accepted",
        "secret",
        "fakeInput",
        "executable",
        "args",
        "env",
        "url",
        "script",
    ] {
        let mut value = serde_json::to_value(request()).unwrap();
        value[field] = serde_json::json!("unexpected");
        assert!(serde_json::from_value::<Request>(value).is_err(), "{field}");
    }
}

#[test]
fn bounded_lifetime_capacity_fails_closed() {
    let state = Invocations::default();
    for n in 0..128 {
        state.cancel(&format!("retired-{n}"));
    }
    state.clear();
    assert!(state.reserve("new-call", "example.plugin").is_err());
}

#[cfg(unix)]
fn output_process(output: &str, exit: &str) -> Execution {
    use std::os::unix::process::CommandExt as _;
    // Test-only transport peer, never a production recipient or consent surface.
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args([
            "-c",
            "cat >/dev/null; printf %s \"$1\"; exit \"$2\"",
            "peer",
            output,
            exit,
        ])
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let child = command.spawn().unwrap();
    let group = crate::host_command::ProcessGroupGuard {
        process_id: child.id().unwrap() as i32,
        armed: true,
    };
    Execution {
        child,
        _group: group,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn private_transport_accepts_only_bounded_matching_success_ack() {
    let attempt = uuid::Uuid::new_v4().to_string();
    let digest = request().digest(None);
    let good = serde_json::json!({"attempt": attempt, "digest": digest}).to_string();
    let cases = [
        (good.clone(), "0", true),
        (good, "1", false),
        (String::new(), "0", false), // lost acknowledgement
        ("x".repeat(1025), "0", false),
        (
            serde_json::json!({"attempt": "other", "digest": digest}).to_string(),
            "0",
            false,
        ),
        (
            serde_json::json!({"attempt": attempt, "digest": "other"}).to_string(),
            "0",
            false,
        ),
        (
            serde_json::json!({"attempt": attempt, "digest": digest, "input": "fake-private"})
                .to_string(),
            "0",
            false,
        ),
    ];
    for (output, status, expected) in cases {
        let state = Invocations::default();
        state.reserve(&attempt, "example.plugin").unwrap();
        let peer = state
            .consume(&attempt, || Ok(output_process(&output, status)))
            .unwrap();
        let mut wire = Zeroizing::new(b"fake-private".to_vec());
        assert_eq!(
            bounded_result(peer, &mut wire, &attempt, &digest).await,
            expected
        );
        assert!(wire.is_empty());
        assert!(!state.live(&attempt));
        assert!(state.reserve(&attempt, "example.plugin").is_err());
    }
}

#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn unresponsive_transport_times_out_without_restoring_authority() {
    use std::os::unix::process::CommandExt as _;
    let mut command = tokio::process::Command::new("/bin/sleep");
    command
        .arg("30")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let child = command.spawn().unwrap();
    let group = crate::host_command::ProcessGroupGuard {
        process_id: child.id().unwrap() as i32,
        armed: true,
    };
    let mut wire = Zeroizing::new(b"fake-private".to_vec());
    let start = tokio::time::Instant::now();
    assert!(
        !bounded_result(
            Execution {
                child,
                _group: group
            },
            &mut wire,
            "attempt",
            "digest"
        )
        .await
    );
    assert!(start.elapsed() >= EXECUTION_BUDGET);
}

#[cfg(target_os = "macos")]
#[test]
fn final_grant_check_holds_registry_lock_and_rejects_retired_revisions() {
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(root.path().join("data")), "test", false).unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
        "id":"example.review", "name":"Review fixture", "apiVersion":1,
        "host":{"reviewedInvocations":[{"id":"synthetic","artifact":{"path":"/fixture/recipient","sha256":"ab".repeat(32)}}]}
    })).unwrap()).unwrap();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.review")
        .unwrap()
        .revision;
    manager.change("enable", "example.review").unwrap();
    let (grant, witness) = manager
        .admit_reviewed_invocation("example.review", &revision, "synthetic")
        .unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(manager.storage_root().join("registry.lock"))
        .unwrap();
    let dispatched = manager
        .with_reviewed_invocation("example.review", &revision, &grant, &witness, || {
            assert!(
                lock.try_lock().is_err(),
                "dispatch must still hold the registry lock"
            );
            Ok(true)
        })
        .unwrap();
    assert!(dispatched);
    manager.change("disable", "example.review").unwrap();
    assert!(manager
        .with_reviewed_invocation::<()>("example.review", &revision, &grant, &witness, || panic!(
            "disabled dispatch"
        ))
        .is_err());
    let safe = Manager::open(Some(root.path().join("data")), "test", true).unwrap();
    assert!(safe
        .with_reviewed_invocation::<()>("example.review", &revision, &grant, &witness, || panic!(
            "safe mode dispatch"
        ))
        .is_err());
}

#[test]
fn real_ipc_rejects_stale_envelopes_disposed_calls_and_disabled_installed_plugins_without_review() {
    use tauri::{
        ipc::CallbackFn,
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        webview::InvokeRequest,
    };
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(root.path().join("data")), "test", false).unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    std::fs::write(
        source.join("manifest.json"),
        r#"{"id":"example.review","name":"Review fixture","apiVersion":1}"#,
    )
    .unwrap();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.review")
        .unwrap()
        .revision;
    let mut context = crate::app_context();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.path().into()),
    );
    let app = mock_builder()
        .manage(PluginManager(Ok(manager)))
        .manage(HostCalls::default())
        .manage(Invocations::default())
        .invoke_handler(crate::commands())
        .build(context)
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let ipc = |command: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: view.url().unwrap(),
                body: body.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let context: serde_json::Value = ipc("plugin_host_call_context", serde_json::json!({}))
        .unwrap()
        .deserialize()
        .unwrap();
    let call = uuid::Uuid::new_v4().to_string();
    let envelope = serde_json::json!({"boot":context["boot"], "page":context["page"], "activation":uuid::Uuid::new_v4().to_string(), "callId":call});
    let body = serde_json::json!({"id":"example.review", "revision":revision, "once":envelope, "request":request(), "onReview":"__CHANNEL__:9"});
    // Retirement enters through the actual generated command/permission boundary.
    ipc(
        "plugin_host_reviewed_retire",
        serde_json::json!({"callId":call}),
    )
    .unwrap();
    assert!(ipc("plugin_host_reviewed_invoke", body.clone()).is_err());
    assert!(ipc("plugin_host_reviewed_invoke", body.clone()).is_err());
    let mut disabled = body.clone();
    disabled["once"]["callId"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
    assert!(ipc("plugin_host_reviewed_invoke", disabled).is_err());
    app.state::<HostCalls>().page_load();
    assert!(ipc("plugin_host_reviewed_invoke", body).is_err());
    assert!(!app.state::<Invocations>().live(&call));
    // No fake native accept callback: every test path stops before presentation.
}

#[test]
fn retired_review_holds_successor_until_invocation_owner_returns() {
    let state = Invocations::default();
    state.reserve("original", "example.plugin").unwrap();
    assert!(state.begin_review("original"));
    state.cancel("original");
    assert!(state.reserve("successor", "example.plugin").is_err());
    assert!(state.consume("original", || Ok(())).is_err());
    state.end_review("original");
    state.reserve("successor", "example.plugin").unwrap();
    assert!(!state.begin_review("original"));
}

#[cfg(target_os = "macos")]
#[test]
fn retained_registry_witness_irreversibly_rejects_real_manager_transitions() {
    for transition in [
        "off-on",
        "reload",
        "remove-install",
        "recover-install",
        "unrelated-save",
        "missing",
        "unreadable",
    ] {
        let root = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(root.path().join("data")), "test", false).unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id":"example.review", "name":"Review fixture", "apiVersion":1,
            "host":{"reviewedInvocations":[{"id":"synthetic","artifact":{"path":"/fixture/recipient","sha256":"ab".repeat(32)}}]}
        })).unwrap()).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.review")
            .unwrap()
            .revision;
        manager.change("enable", "example.review").unwrap();
        let (grant, witness) = manager
            .admit_reviewed_invocation("example.review", &revision, "synthetic")
            .unwrap();
        manager
            .with_reviewed_invocation("example.review", &revision, &grant, &witness, || Ok(()))
            .unwrap();
        let registry = manager.storage_root().join("registry.json");
        let before = std::fs::read(&registry).unwrap();
        match transition {
            "off-on" => {
                manager.change("disable", "example.review").unwrap();
                manager.change("enable", "example.review").unwrap();
                assert_eq!(std::fs::read(&registry).unwrap(), before);
            }
            "reload" => {
                manager.change("disable", "example.review").unwrap();
                manager.reload("example.review").unwrap();
                manager.change("enable", "example.review").unwrap();
            }
            "remove-install" | "recover-install" => {
                if transition == "remove-install" {
                    manager.change("remove", "example.review").unwrap();
                } else {
                    manager.recover().unwrap();
                }
                manager.install(&source).unwrap();
                manager.change("enable", "example.review").unwrap();
            }
            "unrelated-save" => {
                manager.change("disable", "buzz.inbox").unwrap();
            }
            "missing" => {
                std::fs::remove_file(&registry).unwrap();
            }
            "unreadable" => {
                // A directory is deterministically unreadable as a registry even
                // for elevated test users; chmod-based tests are not.
                std::fs::remove_file(&registry).unwrap();
                std::fs::create_dir(&registry).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            manager
                .with_reviewed_invocation::<()>(
                    "example.review",
                    &revision,
                    &grant,
                    &witness,
                    || panic!("retired witness dispatched: {transition}")
                )
                .is_err(),
            "{transition}"
        );
        // A new admission may succeed, but the original witness never renews.
        if !matches!(transition, "missing" | "unreadable") {
            let (fresh_grant, fresh) = manager
                .admit_reviewed_invocation("example.review", &revision, "synthetic")
                .unwrap();
            manager
                .with_reviewed_invocation("example.review", &revision, &fresh_grant, &fresh, || {
                    Ok(())
                })
                .unwrap();
            assert!(manager
                .with_reviewed_invocation::<()>(
                    "example.review",
                    &revision,
                    &grant,
                    &witness,
                    || panic!("renewed old witness")
                )
                .is_err());
        }
    }
}

#[tokio::test(start_paused = true)]
async fn retirement_and_expiry_refuse_host_action_without_releasing_owner() {
    for transition in ["cancel", "drop", "plugin", "page", "expiry"] {
        let state = Invocations::default();
        state.reserve("review", "example.plugin").unwrap();
        assert!(state.begin_review("review"));
        let (send, _receive) = tokio::sync::oneshot::channel();
        state
            .offer(
                "review",
                Pending {
                    projection: projection("review"),
                    member: None,
                    started: Instant::now(),
                    action: Some(send),
                },
            )
            .unwrap();
        let signal = state.retirement_signal("review").unwrap();
        match transition {
            "cancel" => state.cancel("review"),
            "drop" => drop(Retirement(state.clone(), "review".into())),
            "plugin" => state.retire("example.plugin"),
            "page" => state.clear(),
            "expiry" => {}
            _ => unreachable!(),
        }
        let waiting =
            await_review_retirement(signal, state.clone(), "review".into(), REVIEW_BUDGET);
        tokio::pin!(waiting);
        if transition == "expiry" {
            // Poll once to install the timer, then advance the controlled clock.
            tokio::select! { biased;
                _ = &mut waiting => panic!("expired before deadline"),
                _ = std::future::ready(()) => {},
            }
            tokio::time::advance(REVIEW_BUDGET - Duration::from_millis(1)).await;
            assert!(state.live("review"));
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        // Retirement before waiter registration also completes: Notify retains
        // its permit. This is the production signal used to schedule AppKit cleanup.
        waiting.await;
        assert!(!state.live("review"));
        assert!(state
            .dispatch(
                "review",
                "example.plugin",
                "revision",
                &request().digest(None),
                &request().destination
            )
            .is_err());
        if transition == "drop" {
            // Dropping the invocation is now the terminal owner barrier; no modal
            // remains on AppKit's stack after this decision-source replacement.
            state.reserve("successor", "example.plugin").unwrap();
        } else {
            assert!(state.reserve("successor", "example.plugin").is_err());
            state.end_review("review");
            state.reserve("successor", "example.plugin").unwrap();
        }
    }
}

fn projection(call: &str) -> Projection {
    Projection {
        call_id: call.into(),
        plugin_id: "example.plugin".into(),
        revision: "revision".into(),
        request: request(),
        author: None,
        digest: request().digest(None),
        expires_at: 120_000,
        result_url: None,
    }
}
#[tokio::test]
async fn host_action_matches_frozen_record_and_has_only_one_winner() {
    let state = Invocations::default();
    state.reserve("review", "example.plugin").unwrap();
    assert!(state.begin_review("review"));
    let (send, receive) = tokio::sync::oneshot::channel();
    state
        .offer(
            "review",
            Pending {
                projection: projection("review"),
                member: None,
                started: Instant::now(),
                action: Some(send),
            },
        )
        .unwrap();
    let digest = request().digest(None);
    for (id, revision, digest) in [
        ("other", "revision", digest.as_str()),
        ("example.plugin", "stale", digest.as_str()),
        ("example.plugin", "revision", "changed"),
    ] {
        assert!(state
            .dispatch("review", id, revision, digest, &request().destination)
            .is_err());
    }
    for field in ["community", "viewer", "channel", "root"] {
        let mut destination = request().destination;
        match field {
            "community" => destination.community.push('x'),
            "viewer" => destination.viewer.push('x'),
            "channel" => destination.channel.push('x'),
            "root" => destination.root = Some("thread".into()),
            _ => unreachable!(),
        }
        assert!(state
            .dispatch(
                "review",
                "example.plugin",
                "revision",
                &digest,
                &destination
            )
            .is_err());
    }
    state
        .dispatch(
            "review",
            "example.plugin",
            "revision",
            &digest,
            &request().destination,
        )
        .unwrap();
    assert!(state
        .dispatch(
            "review",
            "example.plugin",
            "revision",
            &digest,
            &request().destination
        )
        .is_err());
    receive.await.unwrap();
    // Retirement after the action wins still prevents the effect at final consume.
    state.cancel("review");
    assert!(state
        .consume::<()>("review", || panic!("retired executor admission"))
        .is_err());
}

#[test]
fn author_is_a_digest_input_and_its_membership_cannot_be_rebound() {
    use crate::federated_identity::agent::AgentTokens;
    use buzz_agent_controller::{AppAgent, Secret};
    let key = Secret::generate().unwrap();
    let agent = AppAgent {
        pubkey: key.pubkey().into(),
        relay: "wss://relay.example".into(),
        owner: "a".repeat(64),
        auth: "[]".into(),
        agent_type: "p/t".into(),
        name: "Ada".into(),
        picture: None,
        profile: None,
        about: None,
        deleted: false,
        deleting: false,
        home: None,
        joining: false,
        protection: None,
        protection_revision: 0,
    };
    let author = |relay: &str| Author {
        pubkey: agent.pubkey.clone(),
        relay: relay.into(),
    };
    let digest = request().digest(Some(&author(&agent.relay)));
    assert_ne!(digest, request().digest(None));
    assert_ne!(
        digest,
        request().digest(Some(&author("wss://other.example")))
    );
    let frozen = Projection {
        author: Some(author(&agent.relay)),
        digest: digest.clone(),
        ..projection("review")
    };
    assert_eq!(
        serde_json::to_value(&frozen).unwrap()["author"],
        serde_json::json!({"pubkey": agent.pubkey, "relay": agent.relay})
    );
    for transition in ["live", "delete", "reimport"] {
        let tokens = AgentTokens::unconfigured();
        let stamp = tokens.stamp(&agent.pubkey, &agent.relay).unwrap();
        let member = tokens.fence(&agent, stamp).unwrap();
        let state = Invocations::default();
        state.reserve("review", "example.plugin").unwrap();
        assert!(state.begin_review("review"));
        let (send, _receive) = tokio::sync::oneshot::channel();
        state
            .offer(
                "review",
                Pending {
                    projection: frozen.clone(),
                    member: Some(member),
                    started: Instant::now(),
                    action: Some(send),
                },
            )
            .unwrap();
        if transition != "live" {
            tokens.forget_row(&agent.pubkey, &agent.relay).unwrap();
        }
        if transition == "reimport" {
            tokens.reopen_row(&agent.pubkey, &agent.relay).unwrap();
        }
        let dispatched = state.dispatch(
            "review",
            "example.plugin",
            "revision",
            &digest,
            &request().destination,
        );
        assert_eq!(dispatched.is_ok(), transition == "live", "{transition}");
    }
}

// Test-only pinned peer. Admission is observed outside the process, not inferred
// from an approval boolean. No provider, secret owner or real window is involved.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn retained_native_command_counts_actual_executor_admissions() {
    use std::os::unix::fs::PermissionsExt;
    for transition in [
        "approve",
        "unknown",
        "body",
        "digest",
        "destination",
        "root",
        "revision",
        "registry",
        "disable",
        "page",
        "retire",
        "drop",
        "expiry",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temporary.path()).unwrap();
        let admission = root.join("admissions");
        let call = uuid::Uuid::new_v4().to_string();
        let digest = request().digest(None);
        let ack = if transition == "unknown" {
            "{}".to_owned()
        } else {
            serde_json::json!({"attempt":call, "digest":digest}).to_string()
        };
        let script = format!(
            "#!/bin/sh\nprintf x >> '{}'\n/bin/cat >/dev/null\nprintf '%s' '{}'\n",
            admission.display(),
            ack
        );
        let executable = root.join("peer");
        std::fs::write(&executable, &script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let source = root.join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id":"example.review", "name":"Review fixture", "apiVersion":1,
            "host":{"reviewedInvocations":[{"id":"synthetic","artifact":{"path":executable,"sha256":format!("{:x}",Sha256::digest(script.as_bytes()))}}]}
        })).unwrap()).unwrap();
        let manager = Manager::open(Some(root.join("registry")), "test", false).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.review")
            .unwrap()
            .revision;
        manager.change("enable", "example.review").unwrap();
        let mut context = crate::app_context();
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(root.clone()),
        );
        let app = tauri::test::mock_builder()
            .manage(PluginManager(Ok(manager)))
            .manage(HostCalls::default())
            .manage(Invocations::default())
            .build(context)
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let envelope = serde_json::json!({
            "boot":serde_json::to_value(crate::host_request::plugin_host_call_context(view.as_ref().clone(), app.state()).unwrap()).unwrap()["boot"],
            "page":0, "activation":uuid::Uuid::new_v4().to_string(), "callId":call,
        });
        let handle = app.handle().clone();
        let shown = Arc::new(tokio::sync::Notify::new());
        let notified = shown.clone();
        let (action_call, action_revision, action_digest) =
            (call.clone(), revision.clone(), digest.clone());
        let channel = tauri::ipc::Channel::new(move |body| {
            let shown: serde_json::Value = body.deserialize().unwrap();
            assert_eq!(shown["request"], serde_json::to_value(request()).unwrap());
            assert_eq!(shown["digest"], action_digest);
            let state = handle.state::<Invocations>();
            if transition == "drop" || transition == "expiry" {
                notified.notify_one();
                return Ok(());
            }
            if transition == "registry" || transition == "disable" {
                let manager = handle.state::<PluginManager>();
                let manager = manager.0.as_ref().unwrap();
                manager.change("disable", "example.review").unwrap();
                if transition == "registry" {
                    manager.change("enable", "example.review").unwrap();
                }
            }
            if transition == "page" {
                handle.state::<HostCalls>().page_load();
            }
            if transition == "retire" {
                state.cancel(&action_call);
            }
            let mut destination = request().destination;
            if transition == "destination" {
                destination.channel.push('x');
            }
            if transition == "root" {
                destination.root = Some("thread".into());
            }
            let attempted_digest = if transition == "body" {
                let mut altered = request();
                altered.body.push('!');
                altered.digest(None)
            } else if transition == "digest" {
                "cd".repeat(32)
            } else {
                action_digest.clone()
            };
            let attempted_revision = if transition == "revision" {
                "stale"
            } else {
                &action_revision
            };
            let result = state.dispatch(
                &action_call,
                "example.review",
                attempted_revision,
                &attempted_digest,
                &destination,
            );
            let rejected = matches!(
                transition,
                "body" | "digest" | "destination" | "root" | "revision" | "retire"
            );
            assert_eq!(result.is_err(), rejected, "{transition}");
            if rejected {
                state.cancel(&action_call);
            }
            // Same-task duplicate signal cannot wake a second operation.
            assert!(state
                .dispatch(
                    &action_call,
                    "example.review",
                    &action_revision,
                    &action_digest,
                    &request().destination
                )
                .is_err());
            Ok(())
        });
        if transition == "expiry" {
            tokio::time::pause();
        }
        let invocation = plugin_host_reviewed_invoke(
            app.handle().clone(),
            view.as_ref().clone(),
            app.state(),
            app.state(),
            app.state(),
            "example.review".into(),
            revision.clone(),
            serde_json::from_value(envelope.clone()).unwrap(),
            request(),
            None,
            channel,
            None,
        );
        let result = if transition == "drop" || transition == "expiry" {
            let mut invocation = Box::pin(invocation);
            tokio::select! { biased;
                _ = &mut invocation => panic!("owner returned before review"),
                _ = shown.notified() => {},
            }
            if transition == "drop" {
                drop(invocation);
                assert!(!app.state::<Invocations>().live(&call));
                None
            } else {
                tokio::time::advance(REVIEW_BUDGET - Duration::from_millis(1)).await;
                assert!(app.state::<Invocations>().live(&call));
                tokio::time::advance(Duration::from_millis(1)).await;
                let receipt = invocation.await;
                tokio::time::resume();
                assert!(!app.state::<Invocations>().live(&call));
                Some(receipt)
            }
        } else {
            Some(invocation.await)
        };
        let count = std::fs::read(&admission).unwrap_or_default().len();
        assert_eq!(
            count,
            usize::from(matches!(transition, "approve" | "unknown")),
            "{transition}"
        );
        if let Some(Ok(receipt)) = result {
            assert_eq!(receipt.digest, digest);
            assert_eq!(receipt.destination, request().destination);
            assert_eq!(
                receipt.outcome,
                if transition == "approve" {
                    "submitted"
                } else if transition == "unknown" {
                    "unknown"
                } else {
                    "cancelled"
                }
            );
        } else if !matches!(transition, "drop" | "registry" | "disable" | "page") {
            panic!("unexpected failure: {transition}");
        }
        // Replaying the exact protected envelope cannot admit another process.
        assert!(app
            .state::<HostCalls>()
            .consume(
                "main",
                "reviewed-invocation",
                "example.review",
                &revision,
                &serde_json::from_value(envelope).unwrap(),
                Sha256::digest(digest.as_bytes()).into()
            )
            .is_err());
        assert_eq!(std::fs::read(&admission).unwrap_or_default().len(), count);
    }
}

#[test]
fn destination_root_absence_is_distinct_and_null_or_empty_is_invalid() {
    let original = request();
    let mut with_root = original.clone();
    with_root.destination.root = Some("thread".into());
    assert_ne!(original.digest(None), with_root.digest(None));
    with_root.destination.root = Some(String::new());
    assert!(with_root.validate().is_err());
    let mut value = serde_json::to_value(original).unwrap();
    value["destination"]["root"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[test]
fn destination_source_root_needs_its_task_and_null_or_empty_is_invalid() {
    let mut task = request();
    task.destination.root = Some("task".into());
    let mut routed = task.clone();
    routed.destination.source_root = Some("source".into());
    assert!(routed.validate().is_ok());
    assert_ne!(task.digest(None), routed.digest(None));
    let mut orphan = routed.clone();
    orphan.destination.root = None;
    assert!(orphan.validate().is_err());
    routed.destination.source_root = Some(String::new());
    assert!(routed.validate().is_err());
    let mut value = serde_json::to_value(task).unwrap();
    value["destination"]["sourceRoot"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[cfg(not(target_os = "macos"))]
#[test]
fn native_admission_is_unavailable_on_unsupported_platforms() {
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(root.path().join("data")), "test", false).unwrap();
    assert!(manager
        .admit_reviewed_invocation("example.review", &"ab".repeat(32), "synthetic")
        .is_err());
}

#[tokio::test]
async fn retirement_acknowledges_owner_return_not_only_closed_admission() {
    for presented in [false, true] {
        let state = Invocations::default();
        state.reserve("original", "example.plugin").unwrap();
        if presented {
            assert!(state.begin_review("original"));
        }
        let owner = Retirement(state.clone(), "original".into());
        let retirement = state.cancel_and_wait("original");
        tokio::pin!(retirement);
        tokio::select! { biased;
            _ = &mut retirement => panic!("acknowledged before owner returned"),
            _ = std::future::ready(()) => {},
        }
        assert!(!state.live("original"));
        assert!(state.consume("original", || Ok(())).is_err());
        assert!(state.reserve("successor", "example.plugin").is_err());
        drop(owner);
        retirement.await.unwrap();
        // Also covers completion before a second waiter subscribes.
        state.cancel_and_wait("original").await.unwrap();
        state.reserve("successor", "example.plugin").unwrap();
    }
    let state = Invocations::default();
    state.cancel_and_wait("never-reserved").await.unwrap();
    assert!(state.reserve("never-reserved", "example.plugin").is_err());
    state.reserve("new", "example.plugin").unwrap();
}

#[tokio::test]
async fn a_dropped_retirement_waiter_does_not_release_the_native_owner() {
    let state = Invocations::default();
    state.reserve("original", "example.plugin").unwrap();
    let owner = Retirement(state.clone(), "original".into());
    {
        let retirement = state.cancel_and_wait("original");
        tokio::pin!(retirement);
        tokio::select! { biased;
            _ = &mut retirement => panic!("acknowledged before owner returned"),
            _ = std::future::ready(()) => {},
        }
    }
    assert!(!state.try_live("original"));
    assert!(state.reserve("successor", "example.plugin").is_err());
    drop(owner);
    state.cancel_and_wait("original").await.unwrap();
    state.reserve("successor", "example.plugin").unwrap();
}

#[tokio::test]
async fn plugin_retirement_keeps_successors_out_until_the_owner_returns() {
    let state = Invocations::default();
    let owner = state.own("original", "example.plugin").unwrap();
    let retirement = state.retire_plugin_and_wait("example.plugin");
    tokio::pin!(retirement);
    tokio::select! { biased;
        _ = &mut retirement => panic!("acknowledged before owner returned"),
        _ = std::future::ready(()) => {},
    }
    assert!(!state.try_live("original"));
    assert!(state.own("successor", "example.plugin").is_err());
    drop(owner);
    retirement.await.unwrap();
    let _successor = state.own("successor", "example.plugin").unwrap();
    assert!(state.try_live("successor"));
}

#[test]
fn promotion_liveness_never_waits_for_the_invocation_mutex() {
    let state = Invocations::default();
    let _owner = state.own("original", "example.plugin").unwrap();
    assert!(state.try_live("original"));
    let _held = state.0.lock().unwrap();
    assert!(!state.try_live("original"));
}

#[test]
fn promotion_admission_is_one_shot_and_does_not_complete_the_owner() {
    let state = Invocations::default();
    let owner = state.own("saving", "example.plugin").unwrap();
    assert!(state.try_consume("saving"));
    assert!(!state.try_consume("saving"));
    assert!(state.own("successor", "example.plugin").is_err());
    drop(owner);
    let successor = state.own("successor", "example.plugin").unwrap();
    state.cancel("successor");
    assert!(!state.try_consume("successor"));
    drop(successor);
    let _held = state.own("held", "example.plugin").unwrap();
    let _lock = state.0.lock().unwrap();
    assert!(!state.try_consume("held"));
}

#[test]
fn a_parent_read_names_the_end_it_passed_the_window_first_on_a_tie() {
    let now = tokio::time::Instant::now();
    let (before, after) = (
        now - Duration::from_millis(1),
        now + Duration::from_millis(1),
    );
    assert_eq!(expired(after, after, now), None);
    assert_eq!(expired(now, now, now), Some(ReadFailure::Admission));
    assert_eq!(expired(before, before, now), Some(ReadFailure::Admission));
    assert_eq!(expired(before, after, now), Some(ReadFailure::Admission));
    assert_eq!(expired(after, now, now), Some(ReadFailure::Timeout));
    assert_eq!(expired(now, before, now), Some(ReadFailure::Timeout));
}
