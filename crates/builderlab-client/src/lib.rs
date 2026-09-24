use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::time::SystemTime;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;
use zeroize::Zeroizing;

const KEYCHAIN_SERVICE: &str = "com.squareup.builderbot.cli-auth";
const PROFILE: &str = "default";
const SERVICE_PATH: &str = "/api/goose";
const LIST_AGENTS_ENDPOINT_PATH: &str = "/v3/beekeeper/list-agents";
const AUTH_ME_ENDPOINT_PATH: &str = "/v1/auth/me";
const SESSION_HEADER: &str = "X-BB-Session-Credential";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SessionStatus {
    NotConfigured,
    LoggedOut,
    Available,
    Error { message: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListAgentsResponse {
    pub agents: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListAgentsError {
    InvalidConfiguration(String),
    Unauthenticated,
    KeychainUnavailable,
    Transport,
    HttpStatus(u16),
    InvalidResponse,
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeychainError {
    Unavailable,
}

pub trait Keychain: Send + Sync {
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainError>;
}

pub struct SystemKeychain;

#[cfg(target_os = "macos")]
impl Keychain for SystemKeychain {
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainError> {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|_| KeychainError::Unavailable)?;
        if !output.status.success() {
            return Ok(None);
        }
        Ok(Some(Zeroizing::new(output.stdout)))
    }
}

#[cfg(not(target_os = "macos"))]
impl Keychain for SystemKeychain {
    fn read(
        &self,
        _service: &str,
        _account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainError> {
        Err(KeychainError::Unavailable)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpError;

pub trait HttpTransport: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a str,
        credential: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>>;

    fn post<'a>(
        &'a self,
        url: &'a str,
        credential: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>>;
}

pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, String> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map(|client| Self { client })
            .map_err(|_| "Could not initialize BuilderLab networking".into())
    }
}

impl HttpTransport for ReqwestTransport {
    fn get<'a>(
        &'a self,
        url: &'a str,
        credential: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>> {
        Box::pin(async move {
            let response = self
                .client
                .get(url)
                .header("Accept", "application/json")
                .header(SESSION_HEADER, credential)
                .send()
                .await
                .map_err(|_| HttpError)?;
            let status = response.status().as_u16();
            let body = response.bytes().await.map_err(|_| HttpError)?.to_vec();
            Ok(HttpResponse { status, body })
        })
    }

    fn post<'a>(
        &'a self,
        url: &'a str,
        credential: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>> {
        Box::pin(async move {
            let response = self
                .client
                .post(url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header(SESSION_HEADER, credential)
                .json(body)
                .send()
                .await
                .map_err(|_| HttpError)?;
            let status = response.status().as_u16();
            let body = response.bytes().await.map_err(|_| HttpError)?.to_vec();
            Ok(HttpResponse { status, body })
        })
    }
}

pub async fn get_auth_status() -> SessionStatus {
    let url = match builderlab_url_from_env() {
        Ok(url) => url,
        Err(status) => return status,
    };
    let transport = match ReqwestTransport::new() {
        Ok(transport) => transport,
        Err(message) => return SessionStatus::Error { message },
    };
    check_auth_me_session(&SystemKeychain, &transport, &url, SystemTime::now()).await
}

fn builderlab_url_from_env() -> Result<String, SessionStatus> {
    let Some(raw_url) = std::env::var_os("BUILDERLAB_URL") else {
        return Err(SessionStatus::NotConfigured);
    };
    Ok(raw_url.to_string_lossy().into_owned())
}

pub async fn list_agents(
    keychain: &dyn Keychain,
    transport: &dyn HttpTransport,
    base: &str,
    now: SystemTime,
) -> Result<ListAgentsResponse, ListAgentsError> {
    let response = authenticated_request(
        keychain,
        transport,
        base,
        LIST_AGENTS_ENDPOINT_PATH,
        now,
        RequestMethod::Post(serde_json::json!({ "include_instructions": true })),
    )
    .await
    .map_err(ListAgentsError::from)?;
    parse_list_agents_response(&response.body).ok_or(ListAgentsError::InvalidResponse)
}

enum RequestMethod {
    Get,
    Post(Value),
}

#[derive(Debug, PartialEq, Eq)]
enum SessionRequestError {
    InvalidConfiguration(String),
    Unauthenticated,
    KeychainUnavailable,
    Transport,
    HttpStatus(u16),
}

impl From<SessionRequestError> for ListAgentsError {
    fn from(error: SessionRequestError) -> Self {
        match error {
            SessionRequestError::InvalidConfiguration(message) => {
                Self::InvalidConfiguration(message)
            }
            SessionRequestError::Unauthenticated => Self::Unauthenticated,
            SessionRequestError::KeychainUnavailable => Self::KeychainUnavailable,
            SessionRequestError::Transport => Self::Transport,
            SessionRequestError::HttpStatus(status) => Self::HttpStatus(status),
        }
    }
}

impl SessionRequestError {
    fn into_status(self) -> SessionStatus {
        match self {
            Self::InvalidConfiguration(message) => SessionStatus::Error { message },
            Self::Unauthenticated => SessionStatus::LoggedOut,
            Self::KeychainUnavailable => SessionStatus::Error {
                message: "BuilderLab login is unavailable on this platform".into(),
            },
            Self::Transport => SessionStatus::Error {
                message: "Could not connect to BuilderLab".into(),
            },
            Self::HttpStatus(_) => SessionStatus::Error {
                message: "BuilderLab rejected the session check".into(),
            },
        }
    }
}

async fn authenticated_request(
    keychain: &dyn Keychain,
    transport: &dyn HttpTransport,
    base: &str,
    endpoint_path: &str,
    now: SystemTime,
    method: RequestMethod,
) -> Result<HttpResponse, SessionRequestError> {
    let base = service_url(base).map_err(SessionRequestError::InvalidConfiguration)?;
    let account = format!("{PROFILE}@{base}");
    let credential = session_credential(keychain, &account, now).map_err(|error| match error {
        CredentialLookupError::LoggedOut => SessionRequestError::Unauthenticated,
        CredentialLookupError::KeychainUnavailable => SessionRequestError::KeychainUnavailable,
    })?;
    let endpoint = format!("{base}{endpoint_path}");
    let response = match method {
        RequestMethod::Get => transport.get(&endpoint, &credential).await,
        RequestMethod::Post(body) => transport.post(&endpoint, &credential, &body).await,
    }
    .map_err(|HttpError| SessionRequestError::Transport)?;
    if matches!(response.status, 401 | 403) {
        return Err(SessionRequestError::Unauthenticated);
    }
    if !StatusCode::from_u16(response.status)
        .map(|status| status.is_success())
        .unwrap_or(false)
    {
        return Err(SessionRequestError::HttpStatus(response.status));
    }
    Ok(response)
}

#[derive(Debug, PartialEq, Eq)]
enum CredentialLookupError {
    LoggedOut,
    KeychainUnavailable,
}

fn session_credential(
    keychain: &dyn Keychain,
    account: &str,
    now: SystemTime,
) -> Result<Zeroizing<String>, CredentialLookupError> {
    match keychain.read(KEYCHAIN_SERVICE, account) {
        Ok(Some(value)) => {
            parse_credential(&value, now).map_err(|_| CredentialLookupError::LoggedOut)
        }
        Ok(None) => Err(CredentialLookupError::LoggedOut),
        Err(KeychainError::Unavailable) => Err(CredentialLookupError::KeychainUnavailable),
    }
}

pub async fn check_auth_me_session(
    keychain: &dyn Keychain,
    transport: &dyn HttpTransport,
    base: &str,
    now: SystemTime,
) -> SessionStatus {
    let response = match authenticated_request(
        keychain,
        transport,
        base,
        AUTH_ME_ENDPOINT_PATH,
        now,
        RequestMethod::Get,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return error.into_status(),
    };
    if valid_auth_me_response(&response.body) {
        SessionStatus::Available
    } else {
        SessionStatus::Error {
            message: "BuilderLab returned an invalid session response".into(),
        }
    }
}

fn service_url(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value)
        .map_err(|_| "BUILDERLAB_URL must be a credential-free HTTPS origin".to_owned())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("BUILDERLAB_URL must be a credential-free HTTPS origin".into());
    }
    if !matches!(url.path(), "" | "/") {
        return Err("BUILDERLAB_URL must be an HTTPS origin without a path".into());
    }
    url.set_path(SERVICE_PATH);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

#[derive(Debug, PartialEq, Eq)]
enum CredentialError {
    Invalid,
    Expired,
}

fn parse_credential(bytes: &[u8], now: SystemTime) -> Result<Zeroizing<String>, CredentialError> {
    let value = Zeroizing::new(String::from_utf8_lossy(bytes).trim().to_owned());
    let credential = if let Ok(parsed) = serde_json::from_str::<Value>(&value) {
        if let Some(expires_at) = parsed
            .get("expiresAt")
            .or_else(|| parsed.get("expires_at"))
            .and_then(Value::as_str)
            .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        {
            let now = OffsetDateTime::from(now);
            if expires_at <= now {
                return Err(CredentialError::Expired);
            }
        }
        parsed
            .get("sessionCredential")
            .or_else(|| parsed.get("session_credential"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        value.to_string()
    };
    let credential = Zeroizing::new(credential);
    if credential.len() < 32
        || credential.len() > 512
        || !credential
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(CredentialError::Invalid);
    }
    Ok(credential)
}

fn parse_list_agents_response(body: &[u8]) -> Option<ListAgentsResponse> {
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        return None;
    };
    let Some(object) = parsed.as_object() else {
        return None;
    };
    let status_valid = object.get("status").is_some_and(|status| {
        status == 1 || status == "SUCCESS" || status == "LIST_AGENTS_STATUS_SUCCESS"
    });
    let agents = match object.get("agents") {
        Some(Value::Array(agents)) => agents.clone(),
        None => Vec::new(),
        Some(_) => return None,
    };
    status_valid.then_some(ListAgentsResponse { agents })
}

fn valid_auth_me_response(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("subject")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|subject| !subject.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    const BASE: &str = "https://app.builderlab.xyz";
    const TEST_CREDENTIAL: &str = "a234567890123456789012345678901234567890";

    #[derive(Default)]
    struct FakeKeychain {
        value: Option<Vec<u8>>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl Keychain for FakeKeychain {
        fn read(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainError> {
            self.calls
                .lock()
                .unwrap()
                .push((service.into(), account.into()));
            Ok(self.value.clone().map(Zeroizing::new))
        }
    }

    struct FakeTransport {
        response: Result<HttpResponse, HttpError>,
        calls: Mutex<Vec<(String, String)>>,
        get_calls: Mutex<Vec<(String, String)>>,
        post_bodies: Mutex<Vec<Value>>,
    }

    impl HttpTransport for FakeTransport {
        fn get<'a>(
            &'a self,
            url: &'a str,
            credential: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>> {
            self.get_calls
                .lock()
                .unwrap()
                .push((url.into(), credential.into()));
            let response = self.response.clone();
            Box::pin(async move { response })
        }

        fn post<'a>(
            &'a self,
            url: &'a str,
            credential: &'a str,
            body: &'a Value,
        ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>> {
            self.calls
                .lock()
                .unwrap()
                .push((url.into(), credential.into()));
            self.post_bodies.lock().unwrap().push(body.clone());
            let response = self.response.clone();
            Box::pin(async move { response })
        }
    }

    fn transport(status: u16, body: &[u8]) -> FakeTransport {
        FakeTransport {
            response: Ok(HttpResponse {
                status,
                body: body.into(),
            }),
            calls: Mutex::new(Vec::new()),
            get_calls: Mutex::new(Vec::new()),
            post_bodies: Mutex::new(Vec::new()),
        }
    }

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000)
    }

    #[test]
    fn validates_and_normalizes_service_urls() {
        assert_eq!(
            service_url("https://example.test/").unwrap(),
            "https://example.test/api/goose"
        );
        assert_eq!(
            service_url("https://example.test").unwrap(),
            "https://example.test/api/goose"
        );
        for value in [
            "http://example.test",
            "https://user@example.test",
            "https://example.test?secret=1",
            "https://example.test#secret",
            "https://example.test///",
            "https://example.test/wrong-path",
            "https://example.test/api/goose",
            "not a url",
        ] {
            assert!(service_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn parses_raw_json_and_expired_credentials() {
        assert_eq!(
            parse_credential(TEST_CREDENTIAL.as_bytes(), now())
                .unwrap()
                .as_str(),
            TEST_CREDENTIAL
        );
        assert_eq!(
            parse_credential(
                format!(r#"{{"session_credential":"{TEST_CREDENTIAL}"}}"#).as_bytes(),
                now(),
            )
            .unwrap()
            .as_str(),
            TEST_CREDENTIAL
        );
        assert_eq!(
            parse_credential(
                format!(r#"{{"sessionCredential":"{TEST_CREDENTIAL}","expiresAt":"2020-01-01T00:00:00Z"}}"#).as_bytes(),
                now(),
            ),
            Err(CredentialError::Expired)
        );
    }

    #[tokio::test]
    async fn list_agents_returns_agent_data_and_uses_scoped_keychain_entry() {
        let keychain = FakeKeychain {
            value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
            ..Default::default()
        };
        let transport = transport(
            200,
            br#"{"status":"SUCCESS","agents":[{"agent_id":"agent-1","agent_name":"Helper"}]}"#,
        );
        assert_eq!(
            list_agents(&keychain, &transport, BASE, now()).await,
            Ok(ListAgentsResponse {
                agents: vec![serde_json::json!({
                    "agent_id": "agent-1",
                    "agent_name": "Helper"
                })]
            })
        );
        assert_eq!(
            *keychain.calls.lock().unwrap(),
            vec![(
                KEYCHAIN_SERVICE.into(),
                "default@https://app.builderlab.xyz/api/goose".into()
            )]
        );
        assert_eq!(
            *transport.calls.lock().unwrap(),
            vec![(
                format!("https://app.builderlab.xyz/api/goose{LIST_AGENTS_ENDPOINT_PATH}"),
                TEST_CREDENTIAL.into()
            )]
        );
        assert_eq!(
            *transport.post_bodies.lock().unwrap(),
            vec![serde_json::json!({ "include_instructions": true })]
        );
    }

    #[tokio::test]
    async fn checks_auth_me_endpoint_with_cli_credential() {
        let keychain = FakeKeychain {
            value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
            ..Default::default()
        };
        let transport = transport(
            200,
            br#"{"subject":"deployment-scoped-user","roles":["ROLE_USER"]}"#,
        );
        assert_eq!(
            check_auth_me_session(&keychain, &transport, BASE, now()).await,
            SessionStatus::Available
        );
        assert_eq!(
            *transport.get_calls.lock().unwrap(),
            vec![(
                format!("https://app.builderlab.xyz/api/goose{AUTH_ME_ENDPOINT_PATH}"),
                TEST_CREDENTIAL.into()
            )]
        );
        assert!(transport.calls.lock().unwrap().is_empty());
        assert_eq!(
            *keychain.calls.lock().unwrap(),
            vec![(
                KEYCHAIN_SERVICE.into(),
                "default@https://app.builderlab.xyz/api/goose".into()
            )]
        );
    }

    #[tokio::test]
    async fn auth_me_maps_unauthorized_invalid_success_and_transport_errors() {
        let keychain = FakeKeychain {
            value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
            ..Default::default()
        };
        assert_eq!(
            check_auth_me_session(
                &keychain,
                &transport(401, b"{}"),
                "https://app.builderlab.xyz/wrong-path",
                now()
            )
            .await,
            SessionStatus::Error {
                message: "BUILDERLAB_URL must be an HTTPS origin without a path".into()
            }
        );
        for status in [401, 403] {
            assert_eq!(
                check_auth_me_session(&keychain, &transport(status, b"{}"), BASE, now()).await,
                SessionStatus::LoggedOut
            );
        }
        assert!(matches!(
            check_auth_me_session(&keychain, &transport(200, b"{}"), BASE, now()).await,
            SessionStatus::Error { .. }
        ));
        assert!(matches!(
            check_auth_me_session(&keychain, &transport(503, b"{}"), BASE, now()).await,
            SessionStatus::Error { .. }
        ));
        let network = FakeTransport {
            response: Err(HttpError),
            calls: Mutex::new(Vec::new()),
            get_calls: Mutex::new(Vec::new()),
            post_bodies: Mutex::new(Vec::new()),
        };
        assert!(matches!(
            check_auth_me_session(&keychain, &network, BASE, now()).await,
            SessionStatus::Error { .. }
        ));
    }

    #[tokio::test]
    async fn list_agents_maps_auth_response_and_transport_failures() {
        let missing = FakeKeychain::default();
        assert_eq!(
            list_agents(
                &missing,
                &transport(200, b"{}"),
                "https://app.builderlab.xyz/wrong-path",
                now()
            )
            .await,
            Err(ListAgentsError::InvalidConfiguration(
                "BUILDERLAB_URL must be an HTTPS origin without a path".into()
            ))
        );
        assert_eq!(
            list_agents(
                &missing,
                &transport(200, br#"{"status":"SUCCESS"}"#),
                BASE,
                now()
            )
            .await,
            Err(ListAgentsError::Unauthenticated)
        );

        let expired = FakeKeychain {
            value: Some(
                format!(r#"{{"sessionCredential":"{TEST_CREDENTIAL}","expiresAt":"2020-01-01T00:00:00Z"}}"#)
                    .into_bytes(),
            ),
            ..Default::default()
        };
        assert_eq!(
            list_agents(
                &expired,
                &transport(200, br#"{"status":"SUCCESS"}"#),
                BASE,
                now()
            )
            .await,
            Err(ListAgentsError::Unauthenticated)
        );

        for status in [401, 403] {
            let keychain = FakeKeychain {
                value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
                ..Default::default()
            };
            assert_eq!(
                list_agents(&keychain, &transport(status, b"{}"), BASE, now()).await,
                Err(ListAgentsError::Unauthenticated)
            );
        }
        let keychain = FakeKeychain {
            value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
            ..Default::default()
        };
        assert_eq!(
            list_agents(&keychain, &transport(200, b"bad"), BASE, now()).await,
            Err(ListAgentsError::InvalidResponse)
        );
        assert_eq!(
            list_agents(&keychain, &transport(503, b"{}"), BASE, now()).await,
            Err(ListAgentsError::HttpStatus(503))
        );
        let network = FakeTransport {
            response: Err(HttpError),
            calls: Mutex::new(Vec::new()),
            get_calls: Mutex::new(Vec::new()),
            post_bodies: Mutex::new(Vec::new()),
        };
        assert_eq!(
            list_agents(&keychain, &network, BASE, now()).await,
            Err(ListAgentsError::Transport)
        );
    }
}
