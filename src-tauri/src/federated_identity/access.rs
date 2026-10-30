//! Distinct plugin authority grants. Granted calls go to the adapter origin
//! with the native session as a Bearer token; the renderer never sees it.
use super::FederatedIdentity;
use crate::{with_manager, PluginManager};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

#[derive(Default)]
pub(crate) struct Registrations(Mutex<HashMap<String, (String, String)>>);
impl Registrations {
    pub(crate) fn retire(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, (plugin, _)| plugin != id);
    }
    pub(crate) fn clear(&self) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    path: String,
    #[serde(default = "method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}
fn method() -> String {
    "GET".into()
}

#[tauri::command]
pub(crate) async fn federated_identity_register(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, FederatedIdentity>,
    registrations: tauri::State<'_, Registrations>,
    id: String,
    revision: String,
    registration: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&registration).map_err(|_| "Invalid plugin registration")?;
    let owner = (id.clone(), revision.clone());
    {
        let mut live = registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.len() >= 128 || live.contains_key(&registration) {
            return Err("Plugin registration unavailable".into());
        }
        // Reserve before awaiting admission. Unload may remove this reservation,
        // and no completed admission can resurrect it.
        live.insert(registration.clone(), owner.clone());
    }
    let admitted = async {
        let grants =
            with_manager(manager, move |manager| manager.host_grants(&id, &revision)).await?;
        let grant = grants
            .federated_identity
            .ok_or("Plugin has no authenticated authority grant")?;
        if host.0.config.as_ref().map(|config| config.id.as_str()) != Some(grant.authority.as_str())
        {
            return Err("Plugin authority is not configured".into());
        }
        if registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&registration)
            != Some(&owner)
        {
            return Err("Plugin registration retired".into());
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = admitted {
        registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&registration);
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn federated_identity_unregister(
    registrations: tauri::State<'_, Registrations>,
    registration: String,
) {
    registrations
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&registration);
}
/// One registration's call: it must stay live from admission until the
/// session token is read.
struct Caller<'a> {
    registrations: &'a Registrations,
    registration: String,
    owner: (String, String),
}
impl Caller<'_> {
    fn live(&self) -> bool {
        self.registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&self.registration)
            == Some(&self.owner)
    }
    /// The plugin's grant for the configured authority.
    async fn grant<'h>(
        &self,
        manager: tauri::State<'_, PluginManager>,
        host: &'h FederatedIdentity,
    ) -> Result<
        (
            buzzodz_plugins::FederatedIdentityGrant,
            &'h super::config::Config,
        ),
        String,
    > {
        if !self.live() {
            return Err("Plugin registration retired".into());
        }
        let (plugin, artifact) = self.owner.clone();
        let grants = with_manager(manager, move |manager| {
            manager.host_grants(&plugin, &artifact)
        })
        .await?;
        let grant = grants
            .federated_identity
            .ok_or("Plugin has no authenticated authority grant")?;
        let config = host
            .0
            .config
            .as_ref()
            .ok_or("Federated identity is not configured")?;
        if grant.authority != config.id {
            return Err("Plugin authority mismatch".into());
        }
        Ok((grant, config))
    }
    /// Only the account the caller started under may answer: a session
    /// replaced since then refuses instead of acting for the new account.
    fn token(&self, host: &FederatedIdentity, session: &str) -> Result<String, String> {
        if !self.live() {
            return Err("Plugin registration retired".into());
        }
        host.with_session(|token, current, _| (current == session).then(|| token.to_string()))
            .ok_or("Sign in to your community first")?
            .ok_or_else(|| "Federated session changed".into())
    }
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn federated_identity_request(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, FederatedIdentity>,
    registrations: tauri::State<'_, Registrations>,
    id: String,
    revision: String,
    registration: String,
    session: String,
    request: Request,
) -> Result<crate::host_request::HostResponse, String> {
    let caller = Caller {
        registrations: &registrations,
        registration,
        owner: (id, revision),
    };
    let (grant, config) = caller.grant(manager, &host).await?;
    let destination = validate(config, &grant, &request)?;
    let token = caller.token(&host, &session)?;
    // A refusal here (including 401) belongs to this call only. Only the
    // adapter's session and assertion routes decide that the session ended,
    // so a 401 asks the session route once.
    let response = forward(
        destination,
        &format!("Bearer {token}"),
        &request.method,
        &request.headers,
        request.body,
        crate::host_request::DEADLINE,
    )
    .await?;
    if response.status == 401 {
        host.recheck(&session).await;
    }
    Ok(response)
}
/// A call to the Apps control plane's agent API, as `plugin_host_request`
/// would send it, but with the native session.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppsRequest {
    path: String,
    #[serde(default = "method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}
/// An app artifact for the control plane's deploy route.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppsUpload {
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    file: crate::host_request::UploadFile,
}
/// Sends a granted Apps call with the native session as `BBIdentity`, the
/// way `bl apps` authenticates; the control plane exchanges it itself.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn federated_identity_apps_request(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, FederatedIdentity>,
    registrations: tauri::State<'_, Registrations>,
    id: String,
    revision: String,
    registration: String,
    session: String,
    request: AppsRequest,
) -> Result<crate::host_request::HostResponse, String> {
    let deadline = crate::host_request::request_deadline(request.timeout_ms)?;
    let caller = Caller {
        registrations: &registrations,
        registration,
        owner: (id, revision),
    };
    let (grant, config) = caller.grant(manager, &host).await?;
    let destination = apps_destination(
        control_plane(config, &grant),
        &request.path,
        &request.method,
    )?;
    bounded(&request.headers, request.body.as_deref())?;
    let token = caller.token(&host, &session)?;
    let response = forward(
        destination,
        &format!("BBIdentity {token}"),
        &request.method,
        &request.headers,
        request.body,
        deadline,
    )
    .await?;
    // As for the identity origin, a 401 asks the session route once.
    if response.status == 401 {
        host.recheck(&session).await;
    }
    Ok(response)
}
/// Uploads an app artifact to its deploy route with the native session. The
/// file is only ever an archive `plugin_host_upload` would accept.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn federated_identity_apps_upload(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, FederatedIdentity>,
    registrations: tauri::State<'_, Registrations>,
    id: String,
    revision: String,
    registration: String,
    session: String,
    upload: AppsUpload,
) -> Result<crate::host_request::HostResponse, String> {
    let caller = Caller {
        registrations: &registrations,
        registration,
        owner: (id, revision),
    };
    let operation = async {
        let (grant, config) = caller.grant(manager, &host).await?;
        if !deploy_route(&upload.path) {
            return Err("Apps upload is not allowed".to_string());
        }
        let destination = apps_destination(control_plane(config, &grant), &upload.path, "POST")?;
        bounded(&upload.headers, None)?;
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let path = crate::host_request::archive_path(&upload.file.path, home.as_deref())?;
        let token = caller.token(&host, &session)?;
        let response = crate::host_request::send_upload(
            destination,
            authorized(&upload.headers, &format!("BBIdentity {token}"))?,
            &BTreeMap::new(),
            &upload.file,
            &path,
        )
        .await?;
        if response.status == 401 {
            host.recheck(&session).await;
        }
        Ok(response)
    };
    tokio::time::timeout(crate::host_request::UPLOAD_DEADLINE, operation)
        .await
        .map_err(|_| "Apps upload timed out")?
}
/// The Apps control plane paired with the authority's origin, when granted.
fn control_plane<'a>(
    config: &super::config::Config,
    grant: &buzzodz_plugins::FederatedIdentityGrant,
) -> Option<&'a str> {
    grant
        .apps_control_plane
        .then(|| buzzodz_plugins::apps_control_plane(&config.identity_origin))
        .flatten()
}
/// `path` on `control_plane`, when it is under the agent API.
fn apps_destination(
    control_plane: Option<&str>,
    path: &str,
    method: &str,
) -> Result<url::Url, String> {
    let origin = control_plane.ok_or("Apps control plane is not granted")?;
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if path.len() > 2048
        || !super::config::canonical_path(route)
        || !route.starts_with("/v1/agent/")
        || query.contains('#')
        || !matches!(method, "GET" | "POST" | "PUT" | "DELETE")
    {
        return Err("Apps request is not allowed".into());
    }
    let destination = url::Url::parse(origin)
        .and_then(|base| base.join(path))
        .map_err(|_| "Invalid Apps destination")?;
    if destination.origin().ascii_serialization() != origin {
        return Err("Invalid Apps destination".into());
    }
    Ok(destination)
}
/// `/v1/agent/apps/<app>/deploy`, the only route an artifact goes to.
fn deploy_route(path: &str) -> bool {
    path.strip_prefix("/v1/agent/apps/")
        .and_then(|rest| rest.strip_suffix("/deploy"))
        .is_some_and(|app| !app.is_empty() && !app.contains(['/', '?']))
}
/// `headers` with `authorization` added as a sensitive value.
fn authorized(
    headers: &BTreeMap<String, String>,
    authorization: &str,
) -> Result<reqwest::header::HeaderMap, String> {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        map.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid API header")?,
            reqwest::header::HeaderValue::from_str(value).map_err(|_| "Invalid API header")?,
        );
    }
    let mut value =
        reqwest::header::HeaderValue::from_str(authorization).map_err(|_| "Invalid session")?;
    value.set_sensitive(true);
    map.insert(reqwest::header::AUTHORIZATION, value);
    Ok(map)
}
async fn forward(
    destination: url::Url,
    authorization: &str,
    method: &str,
    headers: &BTreeMap<String, String>,
    body: Option<String>,
    deadline: std::time::Duration,
) -> Result<crate::host_request::HostResponse, String> {
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid API method")?;
    crate::host_request::send_request(
        destination,
        method,
        authorized(headers, authorization)?,
        body,
        deadline,
    )
    .await
}
fn validate(
    config: &super::config::Config,
    grant: &buzzodz_plugins::FederatedIdentityGrant,
    request: &Request,
) -> Result<url::Url, String> {
    let path = &request.path;
    if path.len() > 2048
        || !super::config::canonical_path(path)
        || path.contains('%')
        || !path.starts_with(&config.api_base_path)
        || !grant
            .operations
            .iter()
            .any(|op| op.path == *path && op.method == request.method)
    {
        return Err("Authenticated operation is not granted".into());
    }
    let destination = url::Url::parse(&config.identity_origin)
        .and_then(|base| base.join(path))
        .map_err(|_| "Invalid API destination")?;
    if destination.origin().ascii_serialization() != config.identity_origin {
        return Err("Invalid API destination".into());
    }
    for route in [
        "/v1/login/start",
        "/v1/login/exchange",
        "/v1/session",
        "/v1/identity/assertions",
    ] {
        if destination.path() == config.endpoint(route).path() {
            return Err("Adapter endpoints are reserved".into());
        }
    }
    bounded(&request.headers, request.body.as_deref())?;
    Ok(destination)
}
/// Refuses an oversized call, or a header the forwarder sets or forbids.
fn bounded(headers: &BTreeMap<String, String>, body: Option<&str>) -> Result<(), String> {
    if body.is_some_and(|body| body.len() > 1024 * 1024)
        || headers.len() > 32
        || headers
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > 8192
    {
        return Err("Authenticated request is too large".into());
    }
    for (name, value) in headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Invalid API header")?;
        if matches!(
            name.as_str(),
            "authorization"
                | "nostr-authorization"
                | "nostr-federated-identity"
                | "x-bb-session-credential"
                | "cookie"
                | "host"
                | "connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
        ) || name.as_str().starts_with("proxy-")
        {
            return Err("Authenticated header is reserved".into());
        }
        reqwest::header::HeaderValue::from_str(value).map_err(|_| "Invalid API header")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager as _;
    #[tokio::test]
    async fn native_grants_require_current_enabled_artifact_and_live_registration() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), r#"{"id":"example.fi","name":"Example","apiVersion":1,"host":{"networkOrigins":["https://identity.example"],"federatedIdentity":{"authority":"test","operations":[{"method":"GET","path":"/api/list"}]}}}"#).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.fi")
            .unwrap()
            .revision;
        let host =
            super::super::tests::host(std::sync::Arc::new(super::super::tests::Memory::default()));
        let app = tauri::test::mock_builder()
            .manage(crate::PluginManager(Ok(manager.clone())))
            .manage(host)
            .manage(Registrations::default())
            .build(crate::app_context())
            .unwrap();
        let register = |revision: String, registration: String| {
            federated_identity_register(
                app.state(),
                app.state(),
                app.state(),
                "example.fi".into(),
                revision,
                registration,
            )
        };
        let token = uuid::Uuid::new_v4().to_string();
        assert!(register(revision.clone(), token.clone()).await.is_err());
        manager.change("enable", "example.fi").unwrap();
        assert!(register("stale".into(), token.clone()).await.is_err());
        register(revision.clone(), token.clone()).await.unwrap();
        let request = |path: &str, headers: BTreeMap<String, String>| {
            federated_identity_request(
                app.state(),
                app.state(),
                app.state(),
                "example.fi".into(),
                revision.clone(),
                token.clone(),
                String::new(),
                Request {
                    path: path.into(),
                    method: "GET".into(),
                    headers,
                    body: None,
                },
            )
        };
        // Reaching this refusal proves all admission guards passed; with no
        // session nothing is sent.
        assert!(request("/api/list", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("Sign in"));
        assert!(request("/api/other", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("not granted"));
        let apps = || {
            federated_identity_apps_request(
                app.state(),
                app.state(),
                app.state(),
                "example.fi".into(),
                revision.clone(),
                token.clone(),
                String::new(),
                AppsRequest {
                    path: "/v1/agent/contract".into(),
                    method: "GET".into(),
                    headers: BTreeMap::new(),
                    body: None,
                    timeout_ms: None,
                },
            )
        };
        // Without the Apps grant, the control plane is out of reach.
        assert!(apps().await.unwrap_err().contains("not granted"));
        for header in [
            "Authorization",
            "Nostr-Federated-Identity",
            "X-BB-Session-Credential",
            "Cookie",
        ] {
            assert!(request(
                "/api/list",
                BTreeMap::from([(header.into(), "Bearer fixture".into())])
            )
            .await
            .unwrap_err()
            .contains("reserved"));
        }
        {
            let host = app.state::<FederatedIdentity>();
            let mut state = host.state();
            let session = super::super::tests::record();
            state.snapshot.revision = session.record.revision.clone();
            state.session = Some(session);
        }
        // A call started under another session revision never gets its token.
        assert!(request("/api/list", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("changed"));
        app.state::<Registrations>().retire("example.fi");
        assert!(request("/api/list", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("retired"));
        assert!(apps().await.unwrap_err().contains("retired"));
        register(revision.clone(), token.clone()).await.unwrap();
        manager.change("disable", "example.fi").unwrap();
        assert!(request("/api/list", BTreeMap::new()).await.is_err());
    }
    #[tokio::test]
    async fn a_granted_401_asks_the_session_route_once_before_answering() {
        use super::super::tests::{adapter_with_status, at_adapter, record, Memory};
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), r#"{"id":"example.fi","name":"Example","apiVersion":1,"host":{"federatedIdentity":{"authority":"test","operations":[{"method":"GET","path":"/api/list"}]}}}"#).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.fi")
            .unwrap()
            .revision;
        manager.change("enable", "example.fi").unwrap();
        let (base, server) = adapter_with_status(vec![
            (401, serde_json::json!({})),
            (401, serde_json::json!({"error":"session_expired"})),
        ])
        .await;
        let store = std::sync::Arc::new(Memory::default());
        let mut host = at_adapter(store.clone(), base.clone());
        // Plain loopback wire fixture only, as `at_adapter` is.
        std::sync::Arc::get_mut(&mut host.0)
            .unwrap()
            .config
            .as_mut()
            .unwrap()
            .identity_origin = url::Url::parse(&base)
            .unwrap()
            .origin()
            .ascii_serialization();
        let session = record();
        *store.raw.lock().unwrap() = Some(session.raw.clone());
        {
            let mut state = host.state();
            state.snapshot.revision = session.record.revision.clone();
            state.snapshot.status = super::super::Status::SignedIn;
            state.session = Some(session.clone());
        }
        let app = tauri::test::mock_builder()
            .manage(crate::PluginManager(Ok(manager)))
            .manage(host)
            .manage(Registrations::default())
            .build(crate::app_context())
            .unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        federated_identity_register(
            app.state(),
            app.state(),
            app.state(),
            "example.fi".into(),
            revision.clone(),
            token.clone(),
        )
        .await
        .unwrap();
        let response = federated_identity_request(
            app.state(),
            app.state(),
            app.state(),
            "example.fi".into(),
            revision,
            token,
            session.record.revision.clone(),
            Request {
                path: "/api/list".into(),
                method: "GET".into(),
                headers: BTreeMap::new(),
                body: None,
            },
        )
        .await
        .unwrap();
        // The caller still gets its own 401; the adapter ended the session.
        assert_eq!(response.status, 401);
        let host = app.state::<FederatedIdentity>();
        assert!(!host.current(&session.record.revision));
        assert!(host.snapshot().status == super::super::Status::ReauthenticationRequired);
        let seen = server.await.unwrap();
        assert_eq!(seen[0].target, "GET /api/list HTTP/1.1");
        assert_eq!(seen[1].target, "GET /mount/v1/session HTTP/1.1");
    }
    #[tokio::test]
    async fn forwarding_adds_only_the_native_bearer_and_returns_refusals() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let count = socket.read(&mut buffer).unwrap();
            let text = String::from_utf8_lossy(&buffer[..count]).to_lowercase();
            socket
                .write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 2\r\n\r\n{}")
                .unwrap();
            text
        });
        let response = forward(
            url::Url::parse(&format!("http://{address}/api/v1/buzz/communities/list")).unwrap(),
            "Bearer fixture-session-token",
            "POST",
            &BTreeMap::from([("content-type".into(), "application/json".into())]),
            Some("{}".into()),
            crate::host_request::DEADLINE,
        )
        .await
        .unwrap();
        // A 401 comes back as this call's response, not as a session change.
        assert_eq!(serde_json::to_value(&response).unwrap()["status"], 401);
        let sent = server.join().unwrap();
        assert!(sent.starts_with("post /api/v1/buzz/communities/list "));
        assert!(sent.contains("authorization: bearer fixture-session-token"));
        assert!(!sent.contains("cookie") && !sent.contains("x-bb-"));
    }
    #[test]
    fn apps_calls_stay_on_the_control_planes_agent_api() {
        let plane = Some("https://compose.example");
        assert_eq!(
            apps_destination(plane, "/v1/agent/apps/a/ready?version_id=v 1", "GET")
                .unwrap()
                .as_str(),
            "https://compose.example/v1/agent/apps/a/ready?version_id=v%201"
        );
        assert!(apps_destination(None, "/v1/agent/contract", "GET").is_err());
        for path in [
            "/v1/auth/me",
            "/v1/agent/../auth/me",
            "/v1/agent//x",
            "//evil.example/v1/agent/x",
            "/v1/agent/a%2F..",
            "/v1/agent/a?b#c",
            "https://evil.example/v1/agent/x",
        ] {
            assert!(apps_destination(plane, path, "GET").is_err(), "{path}");
        }
        assert!(apps_destination(plane, "/v1/agent/contract", "PATCH").is_err());
        assert!(deploy_route("/v1/agent/apps/a/deploy"));
        for path in [
            "/v1/agent/apps//deploy",
            "/v1/agent/apps/a/b/deploy",
            "/v1/agent/apps/a?x/deploy",
            "/v1/agent/apps/a/ready",
        ] {
            assert!(!deploy_route(path), "{path}");
        }
    }
}
