use super::*;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

fn tool(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn context(adapter_body: &str) -> (tempfile::TempDir, CodexContext) {
    let root = tempfile::tempdir().unwrap();
    let adapter = root.path().join("codex-acp");
    let cli = root.path().join("codex");
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    tool(&adapter, adapter_body);
    tool(&cli, "#!/bin/sh\nexit 0\n");
    let context = CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).unwrap();
    (root, context)
}

const INIT: &str = r#"printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'"#;

#[tokio::test]
async fn production_discovery_projects_catalog_and_selected_model_effort() {
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session","configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"alpha","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}},{{"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"medium","options":[{{"value":"low","name":"Low"}},{{"value":"medium","name":"Medium"}}]}}]}}}}'
read -r change
case "$change" in *'"method":"session/set_config_option"'*'"value":"beta"'*) ;; *) exit 4 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"beta","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}},{{"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"high","options":[{{"value":"medium","name":"Medium"}},{{"value":"high","name":"High"}}]}}]}}}}'
read -r close
case "$close" in *'"method":"session/close"'*) ;; *) exit 5 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
read -r done
"#
    ));
    let result = discover(&context, Some("beta")).await.unwrap();
    assert_eq!(
        result.models.unwrap(),
        vec![
            Entry {
                id: "alpha".into(),
                name: "Alpha".into()
            },
            Entry {
                id: "beta".into(),
                name: "Beta".into()
            },
        ]
    );
    assert_eq!(result.resolved_model.as_deref(), Some("alpha"));
    assert_eq!(result.resolved_effort.as_deref(), Some("medium"));
    let effort = result.effort.unwrap();
    assert_eq!(effort.model, "beta");
    assert_eq!(effort.current.as_deref(), Some("high"));
    assert_eq!(effort.options[0].id, "medium");
}

#[tokio::test]
async fn absent_catalog_is_unknown_and_present_empty_catalog_is_known() {
    for (config, expected) in [
        ("", None),
        (
            r#","configOptions":[{"id":"model","category":"model","type":"select","currentValue":"","options":[]}]"#,
            Some(Vec::new()),
        ),
    ] {
        let (_root, context) = context(&format!(
            r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session"{config}}}}}'
read -r close
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{}}}}'
read -r done
"#
        ));
        assert_eq!(discover(&context, None).await.unwrap().models, expected);
    }
}

#[test]
fn malformed_grouped_duplicate_and_oversized_metadata_are_rejected() {
    let without_effort = parse_options(Some(&json!([{
        "id":"model", "category":"model", "type":"select", "currentValue":"alpha",
        "options":[{"value":"alpha", "name":"Alpha"}]
    }])))
    .unwrap();
    assert!(without_effort.effort.is_none());

    let grouped = json!({
        "id":"model", "category":"model", "type":"select", "currentValue":"alpha",
        "options":[{"value":"alpha", "name":"Alpha", "group":"private"}]
    });
    assert_eq!(
        parse_options(Some(&json!([grouped]))).unwrap_err(),
        INCOMPATIBLE.to_owned()
    );
    let duplicate = json!({
        "id":"model", "category":"model", "type":"select", "currentValue":"alpha",
        "options":[{"value":"alpha", "name":"A"}, {"value":"alpha", "name":"B"}]
    });
    assert_eq!(
        parse_options(Some(&json!([duplicate]))).unwrap_err(),
        INCOMPATIBLE.to_owned()
    );
    let options: Vec<_> = (0..=MAX_MODELS)
        .map(|index| json!({"value":format!("m{index}"), "name":"Model"}))
        .collect();
    assert_eq!(
        parse_options(Some(&json!([{
            "id":"model", "category":"model", "type":"select",
            "currentValue":"m0", "options":options
        }])))
        .unwrap_err(),
        TOO_LARGE.to_owned()
    );
}

#[tokio::test]
async fn rejected_or_unconfirmed_model_selection_is_not_exposed() {
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session","configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"alpha","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}}]}}}}'
read -r change
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"alpha","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}}]}}}}'
sleep 60
"#
    ));
    assert_eq!(
        discover(&context, Some("beta")).await,
        Err(INCOMPATIBLE.into())
    );
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("ps")
        .args(["-p", pid, "-o", "stat="])
        .output()
        .is_ok_and(|output| {
            output.status.success() && !output.stdout.is_empty() && !output.stdout.starts_with(b"Z")
        })
}

#[tokio::test]
async fn production_discovery_retires_adapter_and_descendant() {
    let marker_root = tempfile::tempdir().unwrap();
    let marker = marker_root.path().join("processes");
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session"}}}}'
read -r close
sleep 60 & helper=$!
printf '%s %s\n' "$$" "$helper" > '{}'
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{}}}}'
wait
"#,
        marker.display()
    ));
    assert!(discover(&context, None).await.is_ok());
    let contents = std::fs::read_to_string(marker).unwrap();
    let pids: Vec<_> = contents.split_whitespace().collect();
    assert_eq!(pids.len(), 2);
    // The group is killed on drop; wait for the kernel to retire both members.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while pids.iter().any(|pid| alive(pid)) {
        assert!(
            std::time::Instant::now() < deadline,
            "Codex discovery left a process"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[test]
fn only_unauthorized_errors_ask_for_codex_sign_in() {
    let sign_in = "Sign in with the selected Codex CLI, then retry";
    assert_eq!(
        rejected(&json!({"data":{"codexErrorInfo":"unauthorized"}})),
        sign_in
    );
    assert_eq!(
        rejected(
            &json!({"data":{"codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":401}}}})
        ),
        sign_in
    );
    assert_eq!(
        rejected(&json!({"data":{"codexErrorInfo":"usageLimitExceeded"}})),
        "Codex rejected the model discovery request"
    );
}

#[tokio::test]
async fn cancelled_discovery_kills_adapter_and_descendant() {
    let marker_root = tempfile::tempdir().unwrap();
    let marker = marker_root.path().join("processes");
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
sleep 60 & helper=$!
printf '%s %s\n' "$$" "$helper" > '{0}.tmp'
mv '{0}.tmp' '{0}'
wait
"#,
        marker.display()
    ));
    let running = tokio::spawn(async move { discover(&context, None).await });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "adapter did not start"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    let contents = std::fs::read_to_string(marker).unwrap();
    let pids: Vec<_> = contents.split_whitespace().collect();
    assert_eq!(pids.len(), 2);
    while pids.iter().any(|pid| alive(pid)) {
        assert!(
            std::time::Instant::now() < deadline,
            "cancelled discovery left a process"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
