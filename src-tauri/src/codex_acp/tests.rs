use super::*;
use std::time::Duration;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

fn tool(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn make_context(adapter_body: &str) -> (tempfile::TempDir, CodexContext) {
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

#[test]
fn production_transport_initializes_exact_identity_and_retires() {
    let (_root, context) = make_context(
        r#"#!/bin/sh
IFS= read -r request
case "$request" in
  *'"method":"initialize"'*) ;;
  *) exit 2 ;;
esac
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'
sleep 60
"#,
    );
    assert_eq!(
        initialize(&context, "1.10.0", &|| true, &mut Vec::new()),
        Ok(())
    );
}

#[test]
fn production_transport_rejects_unsolicited_client_requests() {
    let (_root, context) = make_context(
        r#"#!/bin/sh
IFS= read -r request
printf '%s\n' '{"jsonrpc":"2.0","id":90,"method":"fs/read_text_file","params":{"path":"private"}}'
sleep 60
"#,
    );
    assert_eq!(
        initialize(&context, "1.10.0", &|| true, &mut Vec::new()),
        Err(Failure::Incompatible)
    );
}

fn limits(deadline: Duration, output_bytes: usize) -> Limits {
    Limits {
        deadline,
        output_bytes,
        request_bytes: 16 * 1024,
        messages: 32,
    }
}

#[test]
fn production_transport_bounds_timeout_cancellation_and_output() {
    let (_root, context) = make_context("#!/bin/sh\nread -r request\nsleep 60\n");
    let timeout = run(
        &context,
        limits(Duration::from_millis(50), 4096),
        &|| true,
        &mut Vec::new(),
        |client| client.initialize("1.10.0", &|| true),
    );
    assert_eq!(timeout, Err(Failure::Timeout));

    let (_root, context) = make_context("#!/bin/sh\nread -r request\nsleep 60\n");
    let cancelled = run(
        &context,
        limits(Duration::from_secs(1), 4096),
        &|| false,
        &mut Vec::new(),
        |client| client.initialize("1.10.0", &|| false),
    );
    assert_eq!(cancelled, Err(Failure::Cancelled));

    let (_root, context) =
        make_context("#!/bin/sh\nread -r request\nprintf '12345678901234567890\\n'\nexit 0\n");
    let overflow = run(
        &context,
        limits(Duration::from_secs(1), 8),
        &|| true,
        &mut Vec::new(),
        |client| client.initialize("1.10.0", &|| true),
    );
    assert_eq!(overflow, Err(Failure::OutputLimit));
}

#[test]
fn actual_codex_error_shapes_are_sanitized_without_guessing() {
    assert_eq!(
        typed_codex_error(Some(&json!("usageLimitExceeded"))),
        Some(Failure::Quota)
    );
    assert_eq!(
        typed_codex_error(Some(&json!("sessionBudgetExceeded"))),
        Some(Failure::Limit)
    );
    assert_eq!(
        typed_codex_error(Some(&json!({
            "httpConnectionFailed": {"httpStatusCode": 401}
        }))),
        Some(Failure::Authentication)
    );
    assert_eq!(
        typed_codex_error(Some(&json!({
            "httpConnectionFailed": {"httpStatusCode": 503}
        }))),
        Some(Failure::Network)
    );
    assert_eq!(typed_codex_error(Some(&json!("unknown"))), None);
}

#[test]
fn failed_transport_close_retains_the_live_process_for_retry() {
    let (_root, context) = make_context("#!/bin/sh\nexec sleep 60\n");
    let client = Client::start(&context, Limits::readiness()).unwrap();
    let mut retained = Vec::new();
    assert_eq!(
        client.close_with(&mut retained, |_| Err("synthetic stop failure".into())),
        Err(Failure::Cleanup)
    );
    assert_eq!(retained.len(), 1);
    assert!(retained[0].alive().unwrap());
    retained[0].stop().unwrap();
    assert!(!retained[0].alive().unwrap());
}
