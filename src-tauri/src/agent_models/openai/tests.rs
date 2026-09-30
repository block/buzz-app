use super::*;
use crate::{
    agent_models::{EffortOptions, ModelHost},
    agents::tests::{fixture_with_models, invoke, seed, use_credentials},
};
use buzz_agent_controller::Credentials;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
};

const KEY: &str = "synthetic-openai-key-never-a-real-secret";
const CATALOG: &str = r#"{"object":"list","data":[{"id":"test-model","object":"model"}]}"#;

#[derive(Default)]
struct Keys;
impl Credentials for Keys {
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        Err("unused".into())
    }
    fn read_legacy(
        &self,
        _: buzz_agent_controller::LegacySource,
        _: &str,
    ) -> Result<buzz_agent_controller::Secret, String> {
        Err("unused".into())
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<buzz_agent_controller::Secret>, String> {
        Err("unused".into())
    }
    fn add(&self, _: &str, _: &buzz_agent_controller::Secret) -> Result<(), String> {
        Err("unused".into())
    }
}

fn server(status: u16, body: String, requests: usize) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/models", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        for _ in 0..requests {
            let until = std::time::Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(
                    std::time::Instant::now() < until,
                    "fixture request deadline"
                );
                std::thread::sleep(Duration::from_millis(1));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|s| s == b"\r\n\r\n") {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                assert!(request.len() < 8192);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /v1/models "));
            assert!(request
                .to_ascii_lowercase()
                .contains(&format!("authorization: bearer {KEY}")));
            let _ = write!(stream, "HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    (endpoint, thread)
}

fn request(path: &std::path::Path, key: Option<&str>) -> Value {
    json!({"integration":{"kind":"openai","settings":key.map(|key|json!({"apiKey":key})).unwrap_or(json!({}))},
        "action":if key.is_some() {"connect"} else {"refresh"},
        "edit":{"name":"Test", "systemPrompt":"", "workspace":path.to_str().unwrap(),
        "environment":{},"harness":{"command":"buzz-agent","provider":"openai","args":[],"model":"test-model",
        "configuration":{"mode":"advanced","effort":{"kind":"default"}}}}})
}

#[test]
fn production_ipc_submits_refreshes_and_validates_creation_without_returning_key() {
    let (endpoint, server) = server(200, CATALOG.into(), 3);
    let (dir, host, _app, view) = fixture_with_models(|dir| {
        let mut host = ModelHost::new(Ok(dir.join("store")));
        host.openai_endpoint = endpoint;
        host
    });
    let keys = Arc::new(Keys);
    use_credentials(&host, keys.clone());
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let response = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":request(dir.path(), Some(KEY))}),
    )
    .unwrap();
    assert!(!response.to_string().contains(KEY));
    assert_eq!(response["models"][0]["effort"]["status"], "default");
    let mut refresh = request(dir.path(), None);
    refresh["edit"]["environment"]["OPENAI_COMPAT_API_KEY"] = json!(KEY);
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    assert!(invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":refresh})
    )
    .is_ok());
    assert!(!dir.path().join("store/agents.json").exists());
    // A removed model cannot authorize native identity creation even with a valid key.
    refresh["edit"]["harness"]["model"] = json!("absent-model");
    let result = invoke(&view, "agent_control_create_prepare", json!({"edit":refresh["edit"],"requestId":uuid::Uuid::new_v4().to_string(),"destination":"wss://relay.example","owner":"ab".repeat(32)})).unwrap_err();
    assert_eq!(result["code"], "model");
    assert!(!result.to_string().contains(KEY));
    assert!(!dir.path().join("store/agents.json").exists());
    server.join().unwrap();
}

#[test]
fn ipc_failures_do_not_store_keys_or_leak_response_bodies() {
    for (status, body, code) in [
        (401, KEY.to_owned(), "authentication"),
        (403, KEY.to_owned(), "authentication"),
        (429, KEY.to_owned(), "unavailable"),
        (200, KEY.to_owned(), "unavailable"),
        (200, "x".repeat(2 * 1024 * 1024 + 1), "unavailable"),
        (
            200,
            json!({"object":"list","data":[{"object":"model","id":KEY}]}).to_string(),
            "unavailable",
        ),
    ] {
        let (endpoint, server) = server(status, body, 1);
        let (dir, host, _app, view) = fixture_with_models(|dir| {
            let mut host = ModelHost::new(Ok(dir.join("store")));
            host.openai_endpoint = endpoint;
            host
        });
        let keys = Arc::new(Keys);
        use_credentials(&host, keys.clone());
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        let failure = invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":request(dir.path(), Some(KEY))}),
        )
        .unwrap_err();
        assert_eq!(failure["code"], code);
        assert!(!failure.to_string().contains(KEY));
        assert!(!dir.path().join("store/agents.json").exists());
        server.join().unwrap();
    }
}

#[test]
fn saved_override_and_stale_revision_are_rejected_before_credential_write() {
    let (dir, host, _app, view) = fixture_with_models(|dir| ModelHost::new(Ok(dir.join("store"))));
    let id = seed(dir.path());
    let keys = Arc::new(Keys);
    use_credentials(&host, keys.clone());
    let mut req = request(dir.path(), Some(KEY));
    req["id"] = json!(id);
    req["expectedRevision"] = json!(1);
    let mut edit = req["edit"].clone();
    edit["environment"] = json!({"OPENAI_COMPAT_BASE_URL":"https://other.example/v1"});
    invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit}),
    )
    .unwrap();
    for revision in [1, 2] {
        req["expectedRevision"] = json!(revision);
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        assert!(invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":req})
        )
        .is_err());
    }
}

#[tokio::test]
async fn empty_catalog_is_success_without_storage() {
    let (endpoint, server) = server(200, r#"{"object":"list","data":[]}"#.into(), 1);
    let result = execute(
        Context { api_key: None },
        Settings {
            api_key: Some(KEY.into()),
        },
        Operation::Connect,
        endpoint,
    )
    .await;
    assert!(result.unwrap().models.is_empty());
    server.join().unwrap();
    assert!(matches!(
        parse_models(CATALOG.as_bytes(), KEY).unwrap()[0].effort,
        EffortOptions::Default
    ));
}

#[tokio::test]
async fn cancellation_retires_http_work_and_late_success_cannot_save_a_key() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/models", listener.local_addr().unwrap());
    let host = ModelHost::new(Ok(std::path::PathBuf::from("/unused")));
    let ticket = host.begin().unwrap();
    let owner = host.clone();
    let work = tokio::spawn(async move {
        owner
            .run(
                ticket,
                execute(
                    Context { api_key: None },
                    Settings {
                        api_key: Some(KEY.into()),
                    },
                    Operation::Connect,
                    endpoint,
                ),
            )
            .await
    });
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut request = [0; 8192];
    assert!(stream.read(&mut request).await.unwrap() > 0);
    host.cancel(ticket).unwrap();
    assert!(work.await.unwrap().is_err());
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{CATALOG}",
                CATALOG.len()
            )
            .as_bytes(),
        )
        .await;
    let next = host.begin().unwrap();
    host.cancel(next).unwrap();
}

#[tokio::test]
async fn unreachable_endpoint_is_not_authentication_or_an_empty_catalog() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1/models", listener.local_addr().unwrap());
    drop(listener);
    let error = execute(
        Context { api_key: None },
        Settings {
            api_key: Some(KEY.into()),
        },
        Operation::Connect,
        endpoint,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["code"], "unavailable");
}

#[tokio::test]
async fn stalled_http_response_hits_the_production_deadline_without_saving_a_key() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/models", listener.local_addr().unwrap());
    let work = tokio::spawn(execute(
        Context { api_key: None },
        Settings {
            api_key: Some(KEY.into()),
        },
        Operation::Connect,
        endpoint,
    ));
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut request = [0; 8192];
    assert!(stream.read(&mut request).await.unwrap() > 0);
    // Keep the response withheld until the actual 20-second request deadline.
    let error = tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(serde_json::to_value(error).unwrap()["code"], "timeout");
}

#[test]
fn creation_and_discovery_share_inherited_openai_provider_and_key() {
    let (endpoint, server) = server(200, CATALOG.into(), 2);
    let (dir, host, _app, view) = fixture_with_models(|dir| {
        let mut models = ModelHost::new(Ok(dir.join("store")));
        models.openai_endpoint = endpoint;
        models
    });
    use_credentials(&host, Arc::new(Keys));
    invoke(
        &view,
        "agent_control_save_defaults",
        json!({"edit":{
            "harness":"buzz-agent", "provider":"openai", "model":"", "effort":"",
            "environment":{"OPENAI_COMPAT_API_KEY":KEY}
        }}),
    )
    .unwrap();
    let mut req = request(dir.path(), None);
    req["edit"]["harness"]["provider"] = json!("");
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let catalog = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":req}),
    )
    .unwrap();
    assert_eq!(catalog["models"][0]["id"], "test-model");
    let prepared = invoke(
        &view,
        "agent_control_create_prepare",
        json!({
            "edit":req["edit"], "requestId":uuid::Uuid::new_v4().to_string(),
            "destination":"wss://relay.example", "owner":"ab".repeat(32)
        }),
    )
    .unwrap();
    assert!(prepared["pubkey"].is_string());
    assert!(!prepared.to_string().contains(KEY));
    assert!(!dir.path().join("store/agents.json").exists());
    server.join().unwrap();
}
