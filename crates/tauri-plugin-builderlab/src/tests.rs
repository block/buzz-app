//! In-test fake kgoose, a raw-TCP browser and a file session store. Every test
//! selects `StorageSelection::File` under a tempdir; nothing touches a Keychain.
//! Items "written by bl" go through the crate's own API, so the real key
//! derivation and file layout are exercised.
use super::*;
use axum::{
    extract::{Request, State as RouteState},
    response::{IntoResponse, Response},
    Router,
};
use reqwest::StatusCode;
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    future::IntoFuture,
    io::Write,
    net::Ipv4Addr,
    sync::atomic::{AtomicUsize, Ordering::SeqCst},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const EXPIRES: &str = "2026-06-01T08:00:00Z";
const SERVICE_PATH: &str = "/api/goose";

#[derive(Clone)]
struct Captured {
    method: String,
    path: String,
    credential: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}
#[derive(Clone)]
struct Scripted {
    status: u16,
    body: String,
}
struct Gate {
    started: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}
#[derive(Default)]
struct Kgoose {
    requests: Mutex<Vec<Captured>>,
    scripts: Mutex<HashMap<String, VecDeque<Scripted>>>,
    gates: Mutex<HashMap<String, Gate>>,
    minted: AtomicUsize,
}
impl Kgoose {
    async fn start() -> (Arc<Kgoose>, Url) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fake = Arc::new(Kgoose::default());
        let router = Router::new().fallback(serve).with_state(fake.clone());
        tokio::spawn(axum::serve(listener, router).into_future());
        let url = Url::parse(&format!("http://127.0.0.1:{port}{SERVICE_PATH}")).unwrap();
        (fake, url)
    }
    /// Queues one response for `path`; unscripted requests get the defaults.
    fn script(&self, path: &str, status: u16, body: &str) {
        self.scripts
            .lock()
            .unwrap()
            .entry(path.into())
            .or_default()
            .push_back(Scripted {
                status,
                body: body.into(),
            });
    }
    /// Holds the next request to `path` after capturing it and choosing its
    /// response: `started` resolves on arrival; the answer waits for `release`.
    fn hold(&self, path: &str) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (started, arrived) = oneshot::channel();
        let (release, released) = oneshot::channel();
        self.gates.lock().unwrap().insert(
            path.into(),
            Gate {
                started,
                release: released,
            },
        );
        (arrived, release)
    }
    fn requests(&self, path: &str) -> Vec<Captured> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.path == path)
            .cloned()
            .collect()
    }
    fn credentials(&self, path: &str) -> Vec<String> {
        self.requests(path)
            .into_iter()
            .map(|request| request.credential.unwrap_or_default())
            .collect()
    }
}
async fn serve(RouteState(fake): RouteState<Arc<Kgoose>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, MAX_BODY)
        .await
        .unwrap_or_default();
    let path = parts.uri.path();
    let path = path.strip_prefix(SERVICE_PATH).unwrap_or(path).to_owned();
    let header = |name: &str| {
        parts
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    fake.requests.lock().unwrap().push(Captured {
        method: parts.method.to_string(),
        path: path.clone(),
        credential: header(SESSION_CREDENTIAL_HEADER),
        content_type: header("content-type"),
        body: body.to_vec(),
    });
    let scripted = fake
        .scripts
        .lock()
        .unwrap()
        .get_mut(&path)
        .and_then(VecDeque::pop_front);
    let gate = fake.gates.lock().unwrap().remove(&path);
    if let Some(Gate { started, release }) = gate {
        let _ = started.send(());
        let _ = release.await;
    }
    let Scripted { status, body } = scripted.unwrap_or_else(|| match path.as_str() {
        "/v1/auth/login/exchange" => Scripted {
            status: 200,
            body: json!({
                "session_credential": format!("minted-{}", fake.minted.fetch_add(1, SeqCst) + 1),
                "expires_at": EXPIRES,
            })
            .to_string(),
        },
        "/v1/auth/me" => Scripted {
            status: 200,
            body: json!({
                "subject": "user-1",
                "email": "dev@example.com",
                "name": "Dev",
                "expires_at": EXPIRES,
                "capabilities": { "can_delete_buzz_communities": true },
            })
            .to_string(),
        },
        "/v1/auth/logout" => Scripted {
            status: 302,
            body: String::new(),
        },
        _ => Scripted {
            status: 404,
            body: "Not found".into(),
        },
    });
    let status = StatusCode::from_u16(status).unwrap();
    let mut response = (status, body).into_response();
    if status.is_redirection() {
        // A client that followed this would show up as a request to /followed.
        let location = format!("http://{}{SERVICE_PATH}/followed", header("host").unwrap());
        response
            .headers_mut()
            .insert("location", location.parse().unwrap());
    }
    response
}

#[derive(Clone, Copy)]
enum Mode {
    /// Answers the callback over raw TCP with this code, as a browser would.
    Code(&'static str),
    /// Records the callback URL and does nothing; the test drives the listener.
    Silent,
    Fail,
}
struct Browser {
    mode: Mode,
    opened: AtomicUsize,
    return_to: Mutex<Option<oneshot::Sender<Url>>>,
}
impl Browser {
    fn new(mode: Mode) -> (Arc<Browser>, oneshot::Receiver<Url>) {
        let (sender, receiver) = oneshot::channel();
        let browser = Arc::new(Browser {
            mode,
            opened: AtomicUsize::new(0),
            return_to: Mutex::new(Some(sender)),
        });
        (browser, receiver)
    }
    fn opened(&self) -> usize {
        self.opened.load(SeqCst)
    }
}
impl BrowserOpener for Browser {
    fn open(&self, raw: &str) -> Result<(), String> {
        self.opened.fetch_add(1, SeqCst);
        let url = Url::parse(raw).unwrap();
        assert_eq!(url.path(), "/api/goose/v1/auth/login");
        let query: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query["type"], "cli");
        assert_eq!(query["product"], "buzz");
        let return_to = Url::parse(&query["returnTo"]).unwrap();
        assert_eq!(return_to.host_str(), Some("127.0.0.1"));
        let nonce = return_to.path().strip_prefix("/callback/").unwrap();
        assert!(nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit()));
        if let Some(sender) = self.return_to.lock().unwrap().take() {
            let _ = sender.send(return_to.clone());
        }
        let code = match self.mode {
            Mode::Code(code) => code,
            Mode::Silent => return Ok(()),
            Mode::Fail => return Err("Could not open the sign-in browser".into()),
        };
        // The response drains on a thread so the runtime serving it never blocks.
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", return_to.port().unwrap())).unwrap();
        write!(
            stream,
            "GET {}?code={code} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            return_to.path(),
            return_to.port().unwrap()
        )
        .unwrap();
        std::thread::spawn(move || {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut response = String::new();
            let _ = std::io::Read::read_to_string(&mut stream, &mut response);
        });
        Ok(())
    }
}
/// One raw HTTP/1.1 request to the loopback listener, returning the response.
async fn raw(port: u16, target: &str) -> String {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    stream
        .write_all(
            format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}
/// Graceful shutdown closes the port shortly after the command returns.
async fn closed(port: u16) {
    eventually(|| {
        Box::pin(async move {
            TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
        })
    })
    .await;
}
async fn eventually<F>(mut condition: impl FnMut() -> F)
where
    F: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !condition().await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never held"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
fn ready<T>(value: T) -> std::future::Ready<T> {
    std::future::ready(value)
}

struct Fixture {
    dir: tempfile::TempDir,
    kgoose: Arc<Kgoose>,
    host: BuilderlabHost,
    config: Arc<Config>,
}
fn test_config(service: &Url, dir: &Path) -> Config {
    let env = Env {
        bl_home: Some(dir.to_str().unwrap().into()),
        base_url: Some(service.to_string()),
        ..Default::default()
    };
    let mut config = Config::resolve(&env, dir).unwrap();
    config.storage = StorageSelection::File(dir.join("auth-sessions.json"));
    config
}
async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let (kgoose, service) = Kgoose::start().await;
    let host = BuilderlabHost::new(Ok(test_config(&service, dir.path())));
    let config = host.config().unwrap();
    Fixture {
        dir,
        kgoose,
        host,
        config,
    }
}
impl Fixture {
    fn store(&self) -> FileSessionCredentialStorage {
        FileSessionCredentialStorage::new(self.dir.path().join("auth-sessions.json"))
    }
    fn stored(&self) -> Option<StoredSessionCredential> {
        self.store().get(&self.config.key).unwrap()
    }
    fn stored_credential(&self) -> Option<String> {
        self.stored().map(|stored| stored.session_credential)
    }
    /// What `bl auth login` writes.
    fn seed(&self, credential: &str) {
        self.store()
            .set(
                &self.config.key,
                &StoredSessionCredential {
                    session_credential: credential.into(),
                    expires_at: Some(EXPIRES.into()),
                },
            )
            .unwrap();
    }
    fn pending(&self) -> bool {
        self.host.lock().unwrap().pending.is_some()
    }
    /// A login driven from the outside: the callback URL arrives once the
    /// browser opens, which is also when the login has registered as pending.
    fn login(&self, mode: Mode) -> (Arc<Browser>, oneshot::Receiver<Url>, Login) {
        let (browser, return_to) = Browser::new(mode);
        let host = self.host.clone();
        let opener = browser.clone();
        let task = tokio::spawn(async move { host.login(opener.as_ref()).await });
        (browser, return_to, task)
    }
}
type Login = tokio::task::JoinHandle<Result<Account, String>>;

#[tokio::test]
async fn login_round_trip_never_exposes_credential() {
    let f = fixture().await;
    let (browser, _) = Browser::new(Mode::Code("synthetic-code"));
    let account = f.host.login(browser.as_ref()).await.unwrap();
    assert_eq!(browser.opened(), 1);
    let exchange = &f.kgoose.requests("/v1/auth/login/exchange")[0];
    assert_eq!(exchange.method, "POST");
    assert_eq!(exchange.content_type.as_deref(), Some("application/json"));
    assert_eq!(
        serde_json::from_slice::<Value>(&exchange.body).unwrap(),
        json!({ "code": "synthetic-code" })
    );
    assert_eq!(f.kgoose.credentials("/v1/auth/me"), ["minted-1"]);
    let rendered = serde_json::to_value(&account).unwrap();
    assert!(!rendered.to_string().contains("minted-1"));
    assert_eq!(
        rendered,
        json!({
            "expiresAt": EXPIRES,
            "email": "dev@example.com",
            "name": "Dev",
            "capabilities": { "can_delete_buzz_communities": true },
            "profile": "default",
                "serviceUrl": f.config.service_url.as_str(),
        })
    );
    let stored = f.stored().unwrap();
    assert_eq!(stored.session_credential, "minted-1");
    assert_eq!(stored.expires_at.as_deref(), Some(EXPIRES));

    f.host.sign_out().await.unwrap();
    assert_eq!(f.kgoose.credentials("/v1/auth/logout"), ["minted-1"]);
    assert!(f.kgoose.requests("/followed").is_empty());
    assert!(f.stored().is_none());
    assert!(f.host.auth().await.unwrap().is_none());
}

/// Proves the resolved key equals what `bl` derives for the same inputs by
/// writing under `bl`'s derivation and reading under Buzz's key.
fn key_matches(config: &Config, dir: &Path, profile: &str, base: &str, path: &str) -> bool {
    let probe = dir.join("probe.json");
    let store = FileSessionCredentialStorage::new(probe.clone());
    store
        .set(
            &SessionStorageKey::from_profile_and_kgoose_base_url(profile, base, path),
            &StoredSessionCredential {
                session_credential: "probe".into(),
                expires_at: None,
            },
        )
        .unwrap();
    let found = store.get(&config.key).unwrap().is_some();
    std::fs::remove_file(probe).unwrap();
    found
}
fn bl_home(home: &Path, files: &[(&str, &str)]) {
    let bl = home.join(".bl");
    std::fs::create_dir_all(&bl).unwrap();
    for (name, contents) in files {
        std::fs::write(bl.join(name), contents).unwrap();
    }
}

#[test]
fn resolution_defaults_to_the_block_tenant_on_builderlab_xyz() {
    let home = tempfile::tempdir().unwrap();
    let config = Config::resolve(&Env::default(), home.path()).unwrap();
    assert_eq!(
        config.service_url.as_str(),
        "https://block.builderlab.xyz/api/goose"
    );
    assert_eq!(
        config.endpoint("/v1/auth/me").as_str(),
        "https://block.builderlab.xyz/api/goose/v1/auth/me"
    );
    assert!(key_matches(
        &config,
        home.path(),
        "default",
        "https://block.builderlab.xyz",
        "/api/goose"
    ));
    assert_eq!(config.bl_home, home.path().join(".bl"));
    // Keychain where `bl` has one; its own file layout everywhere else.
    let file = match &config.storage {
        StorageSelection::CrateDefault => None,
        StorageSelection::File(path) => Some(path.clone()),
    };
    let expected = (!cfg!(target_os = "macos")).then(|| home.path().join(".bl/auth-sessions.json"));
    assert_eq!(file, expected);
}

#[test]
fn resolution_mirrors_bl_for_staging_direct_and_custom_hosts() {
    let home = tempfile::tempdir().unwrap();
    bl_home(
        home.path(),
        &[("config.yaml", "org: test\ntargets: [agents]\n")],
    );
    let staging = Config::resolve(
        &Env {
            base_url: Some("https://blockstaging.build".into()),
            ..Default::default()
        },
        home.path(),
    )
    .unwrap();
    assert_eq!(
        staging.service_url.as_str(),
        "https://test.blockstaging.build/api/goose"
    );
    assert!(key_matches(
        &staging,
        home.path(),
        "default",
        "https://test.blockstaging.build",
        "/api/goose"
    ));
    // Direct kgoose hosts take /cash-app/goose and are never org-routed.
    let direct = Config::resolve(
        &Env {
            base_url: Some("https://kgoose.stage.sqprod.co".into()),
            ..Default::default()
        },
        home.path(),
    )
    .unwrap();
    assert_eq!(
        direct.service_url.as_str(),
        "https://kgoose.stage.sqprod.co/cash-app/goose"
    );
    // An explicit service path is normalised with a leading slash.
    let custom = Config::resolve(
        &Env {
            service_path: Some("cash-app/goose".into()),
            ..Default::default()
        },
        home.path(),
    )
    .unwrap();
    assert_eq!(
        custom.service_url.as_str(),
        "https://test.builderlab.xyz/cash-app/goose"
    );
}

#[test]
fn resolution_takes_profile_from_env_then_skills_then_default() {
    let home = tempfile::tempdir().unwrap();
    let base = "https://block.builderlab.xyz";
    bl_home(
        home.path(),
        &[("skills.yaml", "current_profile: team\nprofiles: {}\n")],
    );
    let env = Config::resolve(
        &Env {
            profile: Some("work".into()),
            ..Default::default()
        },
        home.path(),
    )
    .unwrap();
    assert!(key_matches(&env, home.path(), "work", base, "/api/goose"));
    let skills = Config::resolve(&Env::default(), home.path()).unwrap();
    assert!(key_matches(
        &skills,
        home.path(),
        "team",
        base,
        "/api/goose"
    ));
    assert!(!key_matches(
        &skills,
        home.path(),
        "default",
        base,
        "/api/goose"
    ));
    bl_home(home.path(), &[("skills.yaml", "profiles: {}\n")]);
    let fallback = Config::resolve(&Env::default(), home.path()).unwrap();
    assert!(key_matches(
        &fallback,
        home.path(),
        "default",
        base,
        "/api/goose"
    ));
}

#[test]
fn resolution_reads_bl_home_from_env_and_falls_back_to_block_without_org() {
    let home = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::write(elsewhere.path().join("config.yaml"), "org: other\n").unwrap();
    let config = Config::resolve(
        &Env {
            bl_home: Some(elsewhere.path().to_str().unwrap().into()),
            ..Default::default()
        },
        home.path(),
    )
    .unwrap();
    assert_eq!(config.bl_home, elsewhere.path());
    assert_eq!(
        config.service_url.as_str(),
        "https://other.builderlab.xyz/api/goose"
    );
    bl_home(home.path(), &[("config.yaml", "targets: [agents]\n")]);
    let without_org = Config::resolve(&Env::default(), home.path()).unwrap();
    assert_eq!(
        without_org.service_url.as_str(),
        "https://block.builderlab.xyz/api/goose"
    );
}

#[test]
fn resolution_rejects_memory_storage_and_invalid_settings() {
    let home = tempfile::tempdir().unwrap();
    let with = |storage: Option<&str>, file: Option<&str>| Env {
        storage: storage.map(Into::into),
        storage_file: file.map(Into::into),
        ..Default::default()
    };
    assert_eq!(
        Config::resolve(&with(Some("memory"), None), home.path())
            .err()
            .as_deref(),
        Some(MEMORY_STORAGE)
    );
    // Any other explicit selection is the crate's to honour.
    for env in [with(Some("file"), None), with(None, Some("/tmp/x.json"))] {
        assert!(matches!(
            Config::resolve(&env, home.path()).unwrap().storage,
            StorageSelection::CrateDefault
        ));
    }
    for env in [
        Env {
            service_path: Some("  ".into()),
            ..Default::default()
        },
        Env {
            base_url: Some("not a url".into()),
            ..Default::default()
        },
    ] {
        assert_eq!(
            Config::resolve(&env, home.path()).err().as_deref(),
            Some(INVALID_SETTINGS)
        );
    }
    for base in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?secret=x",
        "https://example.com/#fragment",
    ] {
        let env = Env {
            base_url: Some(base.into()),
            ..Default::default()
        };
        assert_eq!(
            Config::resolve(&env, home.path()).err().as_deref(),
            Some(INVALID_SETTINGS),
            "{base}"
        );
    }
    let host = BuilderlabHost::new(Err(MEMORY_STORAGE.into()));
    assert_eq!(host.config().err().unwrap(), MEMORY_STORAGE);
}

const EXCHANGE: &str = "/v1/auth/login/exchange";
const ME: &str = "/v1/auth/me";
const LOGOUT: &str = "/v1/auth/logout";

#[tokio::test]
async fn listener_answers_the_browser_then_closes() {
    let f = fixture().await;
    let (_browser, return_to, task) = f.login(Mode::Silent);
    let url = return_to.await.unwrap();
    let port = url.port().unwrap();
    let foreign = raw(port, "/callback/00000000000000000000000000000000?code=x").await;
    assert!(foreign.starts_with("HTTP/1.1 404"), "{foreign}");
    assert!(raw(port, "/elsewhere").await.starts_with("HTTP/1.1 404"));
    let complete = raw(port, &format!("{}?code=typed", url.path())).await;
    assert!(complete.starts_with("HTTP/1.1 200"), "{complete}");
    assert!(complete.contains("Sign-in received. Return to the app to finish verification."));
    task.await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&f.kgoose.requests(EXCHANGE)[0].body).unwrap(),
        json!({ "code": "typed" })
    );
    closed(port).await;
}

#[tokio::test]
async fn error_callback_never_exposes_provider_detail() {
    let f = fixture().await;
    let (_browser, return_to, task) = f.login(Mode::Silent);
    let url = return_to.await.unwrap();
    let port = url.port().unwrap();
    let detail = format!("{}%0A{}", "x".repeat(150), "y".repeat(100));
    let failed = raw(
        port,
        &format!(
            "{}?error=access_denied&error_description={detail}",
            url.path()
        ),
    )
    .await;
    assert!(failed.starts_with("HTTP/1.1 400"), "{failed}");
    assert!(failed.contains("Sign-in could not complete. Return to the app to retry."));
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        "Browser sign-in could not complete. Try again."
    );
    assert!(f.kgoose.requests.lock().unwrap().is_empty());
    closed(port).await;
}

#[tokio::test]
async fn cancel_before_the_callback_closes_the_listener() {
    let f = fixture().await;
    let (browser, return_to, task) = f.login(Mode::Silent);
    let url = return_to.await.unwrap();
    assert!(f.pending());
    f.host.cancel().unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), CANCELED);
    closed(url.port().unwrap()).await;
    assert_eq!(browser.opened(), 1);
    assert!(f.kgoose.requests.lock().unwrap().is_empty());
    assert!(f.stored().is_none());
    assert!(!f.pending());
    f.host.cancel().unwrap();
}

#[tokio::test(start_paused = true)]
async fn login_times_out_after_ten_minutes_without_a_callback() {
    let f = fixture().await;
    let start = tokio::time::Instant::now();
    let (_browser, return_to, task) = f.login(Mode::Silent);
    let url = return_to.await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), TIMED_OUT);
    assert!(start.elapsed() >= LOGIN_TIMEOUT);
    closed(url.port().unwrap()).await;
    assert!(f.kgoose.requests.lock().unwrap().is_empty());
    assert!(!f.pending());
}

#[tokio::test]
async fn opener_failure_ends_the_login_cleanly() {
    let f = fixture().await;
    let (_browser, return_to, task) = f.login(Mode::Fail);
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        "Could not open the sign-in browser"
    );
    closed(return_to.await.unwrap().port().unwrap()).await;
    assert!(f.kgoose.requests.lock().unwrap().is_empty());
    assert!(!f.pending());
    let (browser, _) = Browser::new(Mode::Code("c"));
    f.host.login(browser.as_ref()).await.unwrap();
    assert_eq!(f.stored_credential().as_deref(), Some("minted-1"));
}

#[tokio::test]
async fn exchange_failures_map_to_fixed_strings() {
    let f = fixture().await;
    let cases = [
        (
            400,
            "plain text body",
            "Builderlab code exchange failed with HTTP 400",
        ),
        (
            401,
            r#"{"error":{"code":"invalid_code","message":"private detail"}}"#,
            "Builderlab code exchange failed with HTTP 401",
        ),
        (
            200,
            r#"{"session_credential":"","expires_at":"x"}"#,
            "Builderlab returned an invalid credential",
        ),
        (200, "not json", "invalid Builderlab code exchange response"),
    ];
    for (status, body, expected) in cases {
        f.kgoose.script(EXCHANGE, status, body);
        let (browser, _) = Browser::new(Mode::Code("c"));
        assert_eq!(f.host.login(browser.as_ref()).await.unwrap_err(), expected);
    }
    assert_eq!(f.kgoose.requests(EXCHANGE).len(), 4);
    assert!(f.kgoose.requests(ME).is_empty());
    assert!(f.stored().is_none());
    assert!(!f.pending());
}

#[tokio::test]
async fn session_check_failures_after_exchange_revoke_the_minted_session() {
    let f = fixture().await;
    let cases = [
        (
            500,
            "minted-1 echoed back",
            "Builderlab session check failed with HTTP 500",
        ),
        (302, "", "Builderlab session check failed with HTTP 302"),
        (401, "", "Builderlab session check failed with HTTP 401"),
        (200, "[]", "invalid Builderlab session response"),
    ];
    for (status, body, expected) in cases {
        f.kgoose.script(ME, status, body);
        let (browser, _) = Browser::new(Mode::Code("c"));
        assert_eq!(f.host.login(browser.as_ref()).await.unwrap_err(), expected);
    }
    assert_eq!(
        f.kgoose.credentials(LOGOUT),
        ["minted-1", "minted-2", "minted-3", "minted-4"]
    );
    assert!(f.kgoose.requests("/followed").is_empty());
    assert!(f.stored().is_none());
}

#[tokio::test]
async fn capabilities_require_a_strict_boolean() {
    let f = fixture().await;
    f.seed("bl-session");
    for body in [
        json!({ "subject": "user-1", "email": "dev@example.com", "capabilities": { "can_delete_buzz_communities": "true" } }),
        json!({ "subject": "user-1", "email": "dev@example.com" }),
    ] {
        f.kgoose.script(ME, 200, &body.to_string());
        let account = f.host.auth().await.unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(account).unwrap(),
            json!({
                "expiresAt": null,
                "email": "dev@example.com",
                "name": null,
                "capabilities": { "can_delete_buzz_communities": false },
                "profile": "default",
                "serviceUrl": f.config.service_url.as_str(),
            })
        );
    }
}

#[tokio::test]
async fn a_second_login_cancels_the_first() {
    let f = fixture().await;
    let (_first, return_to, first) = f.login(Mode::Silent);
    let url = return_to.await.unwrap();
    let (second, _) = Browser::new(Mode::Code("second"));
    f.host.login(second.as_ref()).await.unwrap();
    assert_eq!(first.await.unwrap().unwrap_err(), CANCELED);
    closed(url.port().unwrap()).await;
    assert_eq!(f.stored_credential().as_deref(), Some("minted-1"));
    assert_eq!(f.kgoose.requests(EXCHANGE).len(), 1);
    assert!(!f.pending());
}

#[tokio::test]
async fn late_cancel_revokes_the_minted_session_and_writes_nothing() {
    let f = fixture().await;
    let (arrived, release) = f.kgoose.hold(EXCHANGE);
    let (_browser, _, task) = f.login(Mode::Code("c"));
    arrived.await.unwrap();
    f.host.cancel().unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), CANCELED);
    assert!(f.kgoose.requests(LOGOUT).is_empty());
    release.send(()).unwrap();
    eventually(|| ready(f.kgoose.credentials(LOGOUT) == ["minted-1"])).await;
    assert_eq!(f.kgoose.credentials(ME), ["minted-1"]);
    assert!(f.stored().is_none());
}

#[tokio::test]
async fn sign_out_during_exchange_revokes_the_minted_session() {
    let f = fixture().await;
    let (arrived, release) = f.kgoose.hold(EXCHANGE);
    let (_browser, _, task) = f.login(Mode::Code("c"));
    arrived.await.unwrap();
    f.host.sign_out().await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), CANCELED);
    assert!(f.kgoose.requests(LOGOUT).is_empty());
    release.send(()).unwrap();
    eventually(|| ready(f.kgoose.credentials(LOGOUT) == ["minted-1"])).await;
    assert!(f.stored().is_none());
}

#[tokio::test]
async fn login_replaces_a_dead_item_and_revokes_one_rotated_in_meanwhile() {
    let f = fixture().await;
    f.seed("stale");
    f.kgoose.script(ME, 401, "");
    let (arrived, release) = f.kgoose.hold(EXCHANGE);
    let (browser, _, task) = f.login(Mode::Code("c"));
    arrived.await.unwrap();
    assert_eq!(browser.opened(), 1);
    // `bl auth login` lands while the exchange is in flight.
    f.seed("rotated");
    release.send(()).unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(f.stored_credential().as_deref(), Some("minted-1"));
    eventually(|| ready(f.kgoose.credentials(LOGOUT) == ["rotated"])).await;
    assert_eq!(f.kgoose.credentials(ME), ["stale", "minted-1"]);
}

#[tokio::test]
async fn stale_auth_reports_changed_and_leaves_the_new_session() {
    let f = fixture().await;
    f.seed("old");
    f.kgoose.script(ME, 401, "");
    let (arrived, release) = f.kgoose.hold(ME);
    let host = f.host.clone();
    let stale = tokio::spawn(async move { host.auth().await });
    arrived.await.unwrap();
    f.host.sign_out().await.unwrap();
    let (browser, _) = Browser::new(Mode::Code("c"));
    f.host.login(browser.as_ref()).await.unwrap();
    release.send(()).unwrap();
    assert_eq!(stale.await.unwrap().unwrap_err(), CHANGED);
    assert_eq!(f.stored_credential().as_deref(), Some("minted-1"));
    assert_eq!(f.kgoose.credentials(ME), ["old", "minted-1"]);
    assert_eq!(f.kgoose.credentials(LOGOUT), ["old"]);
}

/// Accepts and drops every connection: a deterministic transport failure.
async fn dead_service() -> Url {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            drop(stream);
        }
    });
    Url::parse(&format!("http://127.0.0.1:{port}{SERVICE_PATH}")).unwrap()
}

#[tokio::test]
async fn bl_items_are_reread_on_every_call_and_skip_the_browser() {
    let f = fixture().await;
    f.seed("one");
    assert_eq!(f.host.auth().await.unwrap().unwrap().profile, "default");
    f.seed("two");
    f.host.auth().await.unwrap().unwrap();
    let (browser, _) = Browser::new(Mode::Code("c"));
    f.host.login(browser.as_ref()).await.unwrap();
    assert_eq!(browser.opened(), 0);
    assert_eq!(f.kgoose.credentials(ME), ["one", "two", "two"]);
    assert!(f.kgoose.requests(EXCHANGE).is_empty());
    assert_eq!(f.stored_credential().as_deref(), Some("two"));
}

#[tokio::test]
async fn unauthenticated_deletes_only_the_item_it_checked() {
    let f = fixture().await;
    f.seed("dead");
    f.kgoose.script(ME, 401, "");
    assert!(f.host.auth().await.unwrap().is_none());
    assert!(f.stored().is_none());
    f.seed("dead-too");
    f.kgoose.script(ME, 403, "");
    let (arrived, release) = f.kgoose.hold(ME);
    let host = f.host.clone();
    let stale = tokio::spawn(async move { host.auth().await });
    arrived.await.unwrap();
    f.seed("rotated");
    release.send(()).unwrap();
    assert!(stale.await.unwrap().unwrap().is_none());
    assert_eq!(f.stored_credential().as_deref(), Some("rotated"));
    assert_eq!(f.kgoose.credentials(ME), ["dead", "dead-too"]);
}

#[tokio::test]
async fn sign_out_deletes_locally_whatever_logout_answers() {
    let f = fixture().await;
    for status in [200, 302, 500] {
        f.seed(&format!("s{status}"));
        f.kgoose.script(LOGOUT, status, "");
        f.host.sign_out().await.unwrap();
        assert!(f.stored().is_none());
    }
    assert_eq!(f.kgoose.credentials(LOGOUT), ["s200", "s302", "s500"]);
    assert!(f.kgoose.requests("/followed").is_empty());
    f.host.sign_out().await.unwrap();
    assert_eq!(f.kgoose.requests(LOGOUT).len(), 3);
}

#[tokio::test]
async fn unreachable_service_keeps_the_item_but_not_through_sign_out() {
    let dir = tempfile::tempdir().unwrap();
    let host = BuilderlabHost::new(Ok(test_config(&dead_service().await, dir.path())));
    let f = Fixture {
        config: host.config().unwrap(),
        host,
        kgoose: Arc::new(Kgoose::default()),
        dir,
    };
    f.seed("kept");
    assert_eq!(
        f.host.auth().await.unwrap_err(),
        "Builderlab session check failed"
    );
    let (browser, _) = Browser::new(Mode::Code("c"));
    assert_eq!(
        f.host.login(browser.as_ref()).await.unwrap_err(),
        "Builderlab session check failed"
    );
    assert_eq!(browser.opened(), 0);

    assert_eq!(f.stored_credential().as_deref(), Some("kept"));
    f.host.sign_out().await.unwrap();
    assert!(f.stored().is_none());
}

#[tokio::test]
async fn blank_item_is_deleted_without_a_network_call() {
    let f = fixture().await;
    f.store()
        .set(
            &f.config.key,
            &StoredSessionCredential {
                session_credential: "  ".into(),
                expires_at: None,
            },
        )
        .unwrap();
    assert!(f.host.auth().await.unwrap().is_none());
    assert!(f.stored().is_none());
    assert!(f.kgoose.requests.lock().unwrap().is_empty());
}

#[test]
fn storage_errors_map_keychain_codes_to_fixed_strings() {
    let mapped = |op, error: &str| storage_error(op, error);
    for code in ["-128", "-25293", "-25308"] {
        assert_eq!(
            mapped(Op::Read, &format!("keyring item: OSStatus {code}")),
            KEYCHAIN_DENIED
        );
    }
    assert_eq!(mapped(Op::Update, "OSStatus -25300"), KEYCHAIN_FAILED);
    assert_eq!(
        mapped(Op::Read, "read /Users/me/.bl/auth-sessions.json: denied"),
        STORE_READ
    );
    assert_eq!(mapped(Op::Update, "write failed"), STORE_UPDATE);
}

#[tokio::test]
async fn corrupt_store_fails_every_operation_with_the_read_string() {
    let f = fixture().await;
    std::fs::write(f.dir.path().join("auth-sessions.json"), "{not json").unwrap();
    assert_eq!(f.host.auth().await.unwrap_err(), STORE_READ);
    assert_eq!(f.host.sign_out().await.unwrap_err(), STORE_READ);
    let (browser, _) = Browser::new(Mode::Code("c"));
    assert_eq!(
        f.host.login(browser.as_ref()).await.unwrap_err(),
        STORE_READ
    );

    assert!(f.kgoose.requests.lock().unwrap().is_empty());
    assert!(!f.pending());
}

#[cfg(unix)]
#[tokio::test]
async fn read_only_store_fails_writes_and_revokes_what_was_minted() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture().await;
    f.seed("a");
    let path = f.dir.path().join("auth-sessions.json");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
    if std::fs::OpenOptions::new().write(true).open(&path).is_ok() {
        return; // root ignores file modes; nothing to prove here
    }
    assert_eq!(f.host.sign_out().await.unwrap_err(), STORE_UPDATE);
    assert_eq!(f.stored_credential().as_deref(), Some("a"));
    f.kgoose.script(ME, 401, "");
    let (browser, _) = Browser::new(Mode::Code("c"));
    assert_eq!(
        f.host.login(browser.as_ref()).await.unwrap_err(),
        STORE_UPDATE
    );
    assert_eq!(browser.opened(), 1);
    assert_eq!(f.kgoose.credentials(LOGOUT), ["a", "minted-1"]);
    assert_eq!(f.stored_credential().as_deref(), Some("a"));
    assert!(!f.pending());
}

#[path = "storage_tests.rs"]
mod storage_tests;

#[test]
fn relocated_skills_file_selects_the_shared_profile() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("elsewhere.yaml");
    std::fs::write(&path, "current_profile: relocated\n").unwrap();
    let mut env = Env {
        skills_config: Some(path.to_string_lossy().into_owned()),
        ..Default::default()
    };
    let config = Config::resolve(&env, dir.path()).unwrap();
    assert!(key_matches(
        &config,
        dir.path(),
        "relocated",
        "https://block.builderlab.xyz",
        "/api/goose"
    ));
    env.profile = Some("explicit".into());
    assert_eq!(
        Config::resolve(&env, dir.path()).unwrap().profile,
        "explicit"
    );
}

#[tokio::test]
async fn malformed_exchange_credentials_and_missing_subject_are_rejected() {
    let f = fixture().await;
    for credential in [
        "".into(),
        "x".repeat(4097),
        "has space".into(),
        "non-ascii-🔑".into(),
        "line\nbreak".into(),
    ] {
        f.kgoose.script(
            EXCHANGE,
            200,
            &json!({"session_credential":credential}).to_string(),
        );
        let (browser, _) = Browser::new(Mode::Code("c"));
        assert_eq!(
            f.host.login(browser.as_ref()).await.unwrap_err(),
            "Builderlab returned an invalid credential"
        );
        assert!(f.stored().is_none());
    }
    assert!(f.kgoose.requests(ME).is_empty());
    for subject in [Value::Null, json!(" "), json!(42)] {
        f.kgoose
            .script(ME, 200, &json!({"subject":subject}).to_string());
        let (browser, _) = Browser::new(Mode::Code("c"));
        assert_eq!(
            f.host.login(browser.as_ref()).await.unwrap_err(),
            "invalid Builderlab session response"
        );
    }
    assert_eq!(
        f.kgoose.credentials(LOGOUT),
        ["minted-1", "minted-2", "minted-3"]
    );
    assert!(f.stored().is_none());
}

#[tokio::test]
async fn cut_off_and_stalled_me_bodies_preserve_the_cli_session() {
    for stall in [false, true] {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = oneshot::channel();
        let (release, held) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"subject\":")
                .await
                .unwrap();
            sent.send(()).unwrap();
            if stall {
                let _ = held.await;
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let url = Url::parse(&format!("http://{address}{SERVICE_PATH}")).unwrap();
        let host = BuilderlabHost::new(Ok(test_config(&url, dir.path())));
        let f = Fixture {
            config: host.config().unwrap(),
            host,
            dir,
            kgoose: Arc::new(Kgoose::default()),
        };
        f.seed("kept");
        let host = f.host.clone();
        let checked = tokio::spawn(async move { host.auth().await });
        received.await.unwrap();
        if stall {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(31)).await;
        }
        assert_eq!(
            checked.await.unwrap().unwrap_err(),
            "Builderlab session check failed"
        );
        if stall {
            tokio::time::resume();
        }
        drop(release);
        server.await.unwrap();
        assert_eq!(f.stored_credential().as_deref(), Some("kept"));
    }
}

#[tokio::test]
async fn an_exchange_survives_a_dropped_ipc_caller_and_restores_from_storage() {
    let f = fixture().await;
    let (started, release) = f.kgoose.hold(EXCHANGE);
    let (_, _, login) = f.login(Mode::Code("c"));
    started.await.unwrap();
    login.abort();
    assert!(login.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    eventually(|| ready(!f.pending())).await;
    assert_eq!(f.stored_credential().as_deref(), Some("minted-1"));
    assert!(f.host.auth().await.unwrap().is_some());
    assert!(f.kgoose.credentials(LOGOUT).is_empty());
}

#[tokio::test]
async fn logout_timeout_still_removes_the_local_session() {
    let f = fixture().await;
    f.seed("saved");
    let (started, release) = f.kgoose.hold(LOGOUT);
    let host = f.host.clone();
    let logout = tokio::spawn(async move { host.sign_out().await });
    started.await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    logout.await.unwrap().unwrap();
    tokio::time::resume();
    drop(release);
    assert!(f.stored().is_none());
}
