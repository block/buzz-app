//! Loopback-only fixtures. Production refuses loopback; these tests swap in a
//! resolver and address rule so the real request path can reach a local TLS
//! server that presents a certificate for `admin.test`.

use super::attachment::{fetch, AttachmentRef, Use};
use super::net::{admin_origin, public, Lookup, Net, Resolve};
use super::*;
use base64::engine::general_purpose::STANDARD;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const RELAY: &str = "https://relay.test";

#[derive(Clone)]
enum Reply {
    Raw(Vec<u8>),
    /// Read the request, then drop the connection without answering.
    Drop,
}

fn reply(status: &str, content_type: &str, body: &str) -> Reply {
    Reply::Raw(
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes(),
    )
}

#[derive(Debug, Clone)]
struct Seen {
    head: String,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    }
    fn target(&self) -> String {
        self.head.split_whitespace().nth(1).unwrap().to_owned()
    }
}

struct Fixture {
    port: u16,
    root: reqwest::Certificate,
    seen: Arc<Mutex<Vec<Seen>>>,
}

async fn fixture(replies: Vec<Reply>) -> Fixture {
    let cert = rcgen::generate_simple_self_signed(vec!["admin.test".into()]).unwrap();
    let root = reqwest::Certificate::from_der(cert.cert.der()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.cert.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into()),
    )
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for reply in replies {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut tls) = acceptor.accept(tcp).await else {
                continue;
            };
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let split = loop {
                let n = tls.read(&mut chunk).await.unwrap();
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at;
                }
            };
            let head = String::from_utf8_lossy(&buffer[..split]).to_string();
            let mut seen = Seen {
                head,
                body: buffer[split + 4..].to_vec(),
            };
            let length: usize = seen
                .header("content-length")
                .map_or(0, |v| v.parse().unwrap());
            while seen.body.len() < length {
                let n = tls.read(&mut chunk).await.unwrap();
                seen.body.extend_from_slice(&chunk[..n]);
            }
            log.lock().unwrap().push(seen);
            if let Reply::Raw(bytes) = reply {
                tls.write_all(&bytes).await.unwrap();
                let _ = tls.shutdown().await;
            }
        }
    });
    Fixture { port, root, seen }
}

/// Answers each lookup from a script; `None` is a DNS failure.
struct Script(Mutex<Vec<Option<Vec<IpAddr>>>>);

impl Resolve for Script {
    fn lookup<'a>(&'a self, _host: &'a str, port: u16) -> Lookup<'a> {
        let answer = self.0.lock().unwrap().remove(0);
        Box::pin(async move {
            answer
                .map(|ips| {
                    ips.into_iter()
                        .map(|ip| SocketAddr::new(ip, port))
                        .collect()
                })
                .ok_or_else(|| std::io::Error::other("no such host"))
        })
    }
}

fn loopback_only(ip: IpAddr) -> bool {
    ip.is_loopback()
}

fn net(fixture: &Fixture, answers: Vec<Option<Vec<IpAddr>>>) -> Net {
    let mut net = Net::custom(Arc::new(Script(Mutex::new(answers))), loopback_only);
    net.root = Some(fixture.root.clone());
    net
}

fn lo() -> Option<Vec<IpAddr>> {
    Some(vec!["127.0.0.1".parse().unwrap()])
}

/// The fixture's origin passes the production syntax rule; only the address
/// rule is relaxed in tests.
fn origin(fixture: &Fixture) -> String {
    format!("https://admin.test:{}", fixture.port)
}

async fn context(host: &IdentityHost, fixture: &Fixture) -> Context {
    Context {
        relay: RELAY.into(),
        origin: origin(fixture),
        signer: host.viewer().await.unwrap(),
    }
}

fn request(value: Value) -> StaffRequest {
    serde_json::from_value(value).unwrap()
}

fn ban(request_id: &str) -> StaffRequest {
    request(json!({
        "route": "directAction", "communityHost": "community.example",
        "action": "ban", "target": "ab".repeat(32), "requestId": request_id,
        "reason": "spam",
    }))
}

const ID: &str = "0f5b8f2e-3c1a-4c7e-9a43-2b6f0d1e9a11";

async fn run(
    net: &Net,
    host: &IdentityHost,
    fixture: &Fixture,
    request: &StaffRequest,
) -> Result<Value, Failure> {
    let ctx = context(host, fixture).await;
    execute(net, host, &ctx, Some(origin(fixture)), request).await
}

#[tokio::test]
async fn answer_changing_from_allowed_to_private_is_refused_at_the_request() {
    let fixture = fixture(vec![reply("200 OK", "application/json", "{}"); 2]).await;
    let net = net(
        &fixture,
        vec![lo(), Some(vec!["10.0.0.7".parse().unwrap()])],
    );
    let host = IdentityHost::fixture();
    let probe = request(json!({ "route": "probe" }));
    assert!(run(&net, &host, &fixture, &probe).await.is_ok());
    let failure = run(&net, &host, &fixture, &probe).await.unwrap_err();
    assert_eq!(failure.category, Category::NotSent);
    assert!(failure.not_sent);
    assert_eq!(fixture.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn any_disallowed_answer_in_a_mixed_set_is_refused() {
    let fixture = fixture(vec![]).await;
    let mixed = Some(vec![
        "127.0.0.1".parse().unwrap(),
        "192.168.1.2".parse().unwrap(),
    ]);
    let net = net(&fixture, vec![mixed]);
    let host = IdentityHost::fixture();
    let failure = run(&net, &host, &fixture, &request(json!({ "route": "probe" })))
        .await
        .unwrap_err();
    assert!(failure.not_sent);
}

#[tokio::test]
async fn dns_failure_and_empty_answers_are_refused() {
    let fixture = fixture(vec![]).await;
    let net = net(&fixture, vec![None, Some(vec![])]);
    let host = IdentityHost::fixture();
    let probe = request(json!({ "route": "probe" }));
    for _ in 0..2 {
        let failure = run(&net, &host, &fixture, &probe).await.unwrap_err();
        assert_eq!(failure.category, Category::NotSent);
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn system_proxy_settings_cannot_redirect_the_connection() {
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let hits = Arc::new(Mutex::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while proxy.accept().await.is_ok() {
            *counter.lock().unwrap() += 1;
        }
    });
    let fixture = fixture(vec![reply("200 OK", "application/json", "{}")]).await;
    let net = net(&fixture, vec![lo()]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    // Proxy variables are read when a client is built; restore them at once.
    let names = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
    let saved: Vec<_> = names.iter().map(std::env::var_os).collect();
    names.iter().for_each(|n| std::env::set_var(n, &proxy_url));
    let client = net.client(&admin_origin(&ctx.origin).unwrap()).await;
    for (name, value) in names.iter().zip(saved) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    let response = client
        .unwrap()
        .get(format!("{}/api/admin/v1/probe", ctx.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(*hits.lock().unwrap(), 0);
    assert_eq!(fixture.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn signature_binds_the_exact_url_method_and_body() {
    let fixture = fixture(vec![
        reply("200 OK", "application/json", r#"{"state":"pending"}"#),
        reply(
            "200 OK",
            "application/json",
            r#"{"items":[],"nextCursor":null}"#,
        ),
    ])
    .await;
    let net = net(&fixture, vec![lo(), lo()]);
    let host = IdentityHost::fixture();
    run(&net, &host, &fixture, &ban(ID)).await.unwrap();
    let search = request(json!({
        "route": "searchMembers", "communityHost": "community.example", "q": "a b&c",
    }));
    run(&net, &host, &fixture, &search).await.unwrap();
    let seen = fixture.seen.lock().unwrap().clone();
    for (seen, method) in seen.iter().zip(["POST", "GET"]) {
        let token = seen.header("authorization").unwrap();
        let event: nostr::event::Event = serde_json::from_slice(
            &STANDARD
                .decode(token.strip_prefix("Nostr ").unwrap())
                .unwrap(),
        )
        .unwrap();
        event.verify().unwrap();
        assert_eq!(event.kind.as_u16(), 27235);
        assert_eq!(event.pubkey.to_hex(), host.viewer().await.unwrap());
        let tag = |name: &str| {
            event.tags.iter().find_map(|t| {
                let t = t.as_slice();
                (t[0] == name).then(|| t[1].clone())
            })
        };
        assert_eq!(
            tag("u").unwrap(),
            format!("{}{}", origin(&fixture), seen.target())
        );
        assert_eq!(tag("method").unwrap(), method);
        assert_eq!(
            tag("payload").unwrap(),
            format!("{:x}", Sha256::digest(&seen.body))
        );
        assert!(tag("nonce").is_some());
    }
    assert_eq!(
        seen[0].target(),
        format!(
            "/api/admin/v1/members/{}/ban?communityHost=community.example",
            "ab".repeat(32)
        )
    );
    let body: Value = serde_json::from_slice(&seen[0].body).unwrap();
    assert_eq!(body, json!({ "requestId": ID, "reason": "spam" }));
    assert_eq!(
        seen[1].target(),
        "/api/admin/v1/members/search?communityHost=community.example&q=a+b%26c"
    );
    assert!(seen[1].body.is_empty());
}

#[tokio::test]
async fn a_lost_write_response_is_ambiguous_and_the_retry_keeps_its_request_id() {
    let fixture = fixture(vec![
        Reply::Drop,
        reply("502 Bad Gateway", "application/json", ""),
        Reply::Raw(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 40\r\n\r\n{\"state\"".to_vec()),
        reply("200 OK", "application/json", r#"{"state":"succeeded","actionId":"a","replayed":true}"#),
    ])
    .await;
    let net = net(&fixture, vec![lo(), lo(), lo(), lo()]);
    let host = IdentityHost::fixture();
    let write = ban(ID);
    for _ in 0..3 {
        let failure = run(&net, &host, &fixture, &write).await.unwrap_err();
        assert_eq!(failure.category, Category::Ambiguous);
        assert!(!failure.not_sent);
    }
    let value = run(&net, &host, &fixture, &write).await.unwrap();
    assert_eq!(value["replayed"], true);
    let ids: Vec<Value> = fixture
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|s| serde_json::from_slice::<Value>(&s.body).unwrap()["requestId"].clone())
        .collect();
    assert_eq!(ids, vec![json!(ID); 4]);
}

#[tokio::test]
async fn only_a_complete_empty_404_or_405_is_unsupported() {
    let coded = r#"{"error":{"code":"not_found","message":"No such member","requestId":"x"}}"#;
    let fixture = fixture(vec![
        reply("404 Not Found", "text/plain", ""),
        reply("405 Method Not Allowed", "text/plain", ""),
        reply("404 Not Found", "application/json", coded),
        Reply::Raw(b"HTTP/1.1 404 Not Found\r\ncontent-length: 50\r\n\r\n{".to_vec()),
        reply(
            "409 Conflict",
            "application/json",
            r#"{"error":{"code":"request_id_conflict","message":"m","requestId":"x"}}"#,
        ),
        reply("403 Forbidden", "application/json", ""),
        reply("401 Unauthorized", "application/json", ""),
        reply("500 Internal Server Error", "application/json", ""),
        reply("200 OK", "text/html", "<html>sign in</html>"),
        Reply::Raw(
            b"HTTP/1.1 302 Found\r\nlocation: https://evil.example/\r\ncontent-length: 0\r\n\r\n"
                .to_vec(),
        ),
    ])
    .await;
    let net = net(&fixture, vec![lo(); 10]);
    let host = IdentityHost::fixture();
    let read = request(json!({
        "route": "getMember", "communityHost": "community.example", "pubkey": "cd".repeat(32),
    }));
    let mut results = Vec::new();
    for _ in 0..10 {
        let f = run(&net, &host, &fixture, &read).await.unwrap_err();
        results.push((f.category, f.body_complete, f.body_empty, f.code));
    }
    use Category::*;
    assert_eq!(
        results,
        vec![
            (Unsupported, true, true, None),
            (Unsupported, true, true, None),
            (Rejected, true, false, Some("not_found".into())),
            (Ambiguous, false, false, None),
            (Rejected, true, false, Some("request_id_conflict".into())),
            (Forbidden, true, true, None),
            (Unauthorized, true, true, None),
            (Ambiguous, true, true, None),
            (Intercepted, false, false, None),
            (Intercepted, false, false, None),
        ]
    );
    assert_eq!(
        fixture.seen.lock().unwrap().len(),
        10,
        "no redirect was followed"
    );
}

#[tokio::test]
async fn a_changed_context_is_refused_before_sending() {
    let fixture = fixture(vec![]).await;
    let net = net(&fixture, vec![lo(); 4]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    let write = ban(ID);
    let moved = execute(
        &net,
        &host,
        &ctx,
        Some("https://other.example".into()),
        &write,
    )
    .await;
    let gone = execute(&net, &host, &ctx, None, &write).await;
    let other = Context {
        signer: "ef".repeat(32),
        ..context(&host, &fixture).await
    };
    let switched = execute(&net, &host, &other, Some(origin(&fixture)), &write).await;
    let local = Context {
        origin: "https://localhost".into(),
        ..context(&host, &fixture).await
    };
    let refused = execute(
        &net,
        &host,
        &local,
        Some("https://localhost".into()),
        &write,
    )
    .await;
    for result in [moved, gone, switched, refused] {
        assert!(result.unwrap_err().not_sent);
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn attachment_fetch_checks_type_size_and_hash() {
    let bytes = b"\x89PNG fake";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let png = || {
        let mut raw = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: {}\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        raw.extend_from_slice(bytes);
        Reply::Raw(raw)
    };
    let fixture = fixture(vec![png(), png(), reply("200 OK", "application/pdf", "x")]).await;
    let net = net(&fixture, vec![lo(); 3]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    let found = Some(origin(&fixture));
    let attachment = |sha256: &str, mime: &str| AttachmentRef {
        feedback_id: ID.into(),
        sha256: sha256.into(),
        mime: mime.into(),
        size: bytes.len(),
    };
    let ok = fetch(
        &net,
        &host,
        &ctx,
        found.clone(),
        &attachment(&hash, "image/png"),
        Use::Preview,
    )
    .await;
    assert_eq!(ok.unwrap(), bytes);
    let wrong = fetch(
        &net,
        &host,
        &ctx,
        found.clone(),
        &attachment(&"0".repeat(64), "image/png"),
        Use::Save,
    )
    .await;
    assert_eq!(
        wrong.unwrap_err().code.as_deref(),
        Some("attachment_hash_mismatch")
    );
    let typed = fetch(
        &net,
        &host,
        &ctx,
        found.clone(),
        &attachment(&hash, "image/png"),
        Use::Save,
    )
    .await;
    assert_eq!(
        typed.unwrap_err().code.as_deref(),
        Some("attachment_mime_mismatch")
    );
    let preview = fetch(
        &net,
        &host,
        &ctx,
        found,
        &attachment(&hash, "application/pdf"),
        Use::Preview,
    )
    .await;
    assert!(preview.unwrap_err().not_sent, "non-images are save-only");
    let seen = fixture.seen.lock().unwrap();
    assert_eq!(
        seen[0].target(),
        format!("/api/admin/v1/feedback/{ID}/attachments/{hash}")
    );
}

#[test]
fn admin_origin_accepts_only_public_https_origins() {
    for ok in [
        "https://admin.example.com",
        "https://admin.example.com:8443/",
        "https://8.8.8.8",
    ] {
        assert!(admin_origin(ok).is_ok(), "{ok}");
    }
    for bad in [
        "http://admin.example.com",
        "https://localhost",
        "https://relay.localhost",
        "https://printer.local",
        "https://intranet",
        "https://127.0.0.1",
        "https://10.1.2.3",
        "https://[::1]",
        "https://[fd00::1]",
        "https://[::ffff:192.168.0.1]",
        "https://user@admin.example.com",
        "https://admin.example.com/api",
        "https://admin.example.com?x",
    ] {
        assert!(admin_origin(bad).is_err(), "{bad}");
    }
}

#[test]
fn public_addresses_exclude_every_special_range() {
    for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
        assert!(public(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "0.1.2.3",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.0.0.8",
        "192.0.2.1",
        "192.168.0.1",
        "198.18.0.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "64:ff9b::a00:1",
        "2001:db8::1",
        "2001::1",
        "2002:a00:1::",
        "::ffff:10.0.0.1",
    ] {
        assert!(!public(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn advertised_admin_api_is_validated() {
    assert_eq!(
        advertised(&json!({ "admin_api": "https://admin.example.com" })).as_deref(),
        Some("https://admin.example.com")
    );
    for info in [
        json!({}),
        json!({ "admin_api": "http://admin.example.com" }),
        json!({ "admin_api": 7 }),
    ] {
        assert_eq!(advertised(&info), None);
    }
}

#[test]
fn routes_build_exact_urls_and_bodies() {
    let origin = admin_origin("https://admin.example.com").unwrap();
    let built = |value: Value| request(value).build(&origin);
    let resolve = built(json!({
        "route": "resolveReport", "id": ID, "action": "timeout", "requestId": ID, "expirationSecs": 60,
    }))
    .unwrap();
    assert_eq!(resolve.method, "POST");
    assert_eq!(
        resolve.url.as_str(),
        format!("https://admin.example.com/api/admin/v1/reports/{ID}/resolve")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&resolve.body).unwrap(),
        json!({ "action": "timeout", "requestId": ID, "expirationSecs": 60 })
    );
    let list = built(json!({ "route": "listReports", "query": { "status": "open", "scope": "all", "limit": 50 } })).unwrap();
    assert_eq!(list.url.query(), Some("status=open&limit=50&scope=all"));
    let lift = built(json!({ "route": "liftRestriction", "communityHost": "c.example:8443", "kind": "timeout", "pubkey": "ab".repeat(32) })).unwrap();
    assert_eq!(
        (lift.method, lift.url.path()),
        (
            "DELETE",
            format!("/api/admin/v1/members/{}/timeout", "ab".repeat(32)).as_str()
        )
    );
    let feedback =
        built(json!({ "route": "setFeedbackStatus", "id": ID, "status": "archived" })).unwrap();
    assert_eq!(
        (feedback.method, feedback.body),
        ("PATCH", br#"{"status":"archived"}"#.to_vec())
    );
    for bad in [
        json!({ "route": "resolveReport", "id": ID, "action": "ban", "requestId": ID, "expirationSecs": 60 }),
        json!({ "route": "resolveReport", "id": ID, "action": "timeout", "requestId": ID }),
        json!({ "route": "resolveReport", "id": ID, "action": "ban", "requestId": "not-a-uuid" }),
        json!({ "route": "getReport", "id": "../probe" }),
        json!({ "route": "getMember", "communityHost": "c.example/x", "pubkey": "ab".repeat(32) }),
        json!({ "route": "getMember", "communityHost": "c.example", "pubkey": "AB".repeat(32) }),
        json!({ "route": "listRestrictions", "communityHost": "c.example", "limit": 201 }),
        json!({ "route": "searchMembers", "communityHost": "c.example", "q": "" }),
        json!({ "route": "directAction", "communityHost": "c.example", "action": "timeout", "target": "ab".repeat(32), "requestId": ID }),
        json!({ "route": "directAction", "communityHost": "c.example", "action": "delete", "target": "ab".repeat(32), "requestId": ID, "expirationSecs": 5 }),
    ] {
        assert!(built(bad.clone()).is_err(), "{bad}");
    }
    assert!(
        serde_json::from_value::<StaffRequest>(json!({ "route": "probe", "path": "/x" })).is_err()
    );
    assert!(serde_json::from_value::<StaffRequest>(json!({ "route": "rawHttp" })).is_err());
}
