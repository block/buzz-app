use super::*;
#[test]
fn catalog_keeps_exact_ids_and_provider_boundaries_and_redacts_errors() {
    let response = json!({"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"custom","id":"namespace/model.v1"}]}});
    assert_eq!(
        parse_response(&response).unwrap(),
        ["custom/namespace/model.v1"]
    );
    for bad in [
        json!({"success":false,"error":"secret"}),
        json!({"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"bad/provider","id":"model"}]}}),
    ] {
        let error = parse_response(&bad).unwrap_err();
        assert!(!error.contains("secret"));
    }
}
#[cfg(unix)]
fn fixture(script: &str) -> (tempfile::TempDir, PiContext) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let command = dir.path().join("pi");
    std::fs::write(&command, format!("#!/bin/sh\n{script}")).unwrap();
    std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
    let context = PiContext {
        command,
        workspace: dir.path().into(),
        args: vec![],
        environment: Default::default(),
        path: "/usr/bin:/bin".into(),
    };
    (dir, context)
}
#[cfg(unix)]
#[tokio::test]
async fn reads_rpc_and_reports_exit_failure() {
    let (_dir, context) = fixture("read request\ncase \"$request\" in *get_available_models*) printf '%s\\n' '{\"id\":\"catalog\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{\"models\":[{\"provider\":\"p\",\"id\":\"exact/id\"}]}}';; esac\n");
    assert_eq!(fetch(context).await.unwrap(), ["p/exact/id"]);
    let (_dir, context) = fixture("exit 1\n");
    assert!(fetch(context).await.is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn cancellation_kills_lookup_after_observed_start() {
    let (dir, context) = fixture("sleep 300 &\nhelper=$!\nprintf '%s %s\\n' \"$$\" \"$helper\" > started\nread request\nwait\n");
    let task = tokio::spawn(fetch(context));
    let pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(dir.path().join("started")) {
                let pids: Vec<i32> = text
                    .split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
                if pids.len() == 2 {
                    break pids;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while pid.iter().any(|pid| unsafe { libc::kill(*pid, 0) } == 0) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires explicitly selected installed Pi/ACP and local configuration; no inference"]
async fn installed_pi_catalog_uses_production_context() {
    use buzz_agent_controller::{AgentEdit, Controller, HarnessEdit};
    use std::collections::BTreeMap;
    let adapter = std::env::var("BUZZ_TEST_PI_ADAPTER").expect("set BUZZ_TEST_PI_ADAPTER");
    let dir = tempfile::tempdir().unwrap();
    let context = Controller::draft_pi_model_context(AgentEdit {
        name: "Probe".into(),
        system_prompt: String::new(),
        workspace: dir.path().display().to_string(),
        harness: HarnessEdit {
            command: adapter,
            args: vec!["--".into(), "--thinking".into(), "high".into()],
            model: String::new(),
            provider: String::new(),
            databricks: None,
        },
        environment: BTreeMap::new(),
    })
    .unwrap();
    let models = fetch(context).await.unwrap();
    assert!(!models.is_empty());
    println!(
        "Production Pi catalog: {} models, {} providers",
        models.len(),
        models
            .iter()
            .filter_map(|m| m.split('/').next())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    );
}
