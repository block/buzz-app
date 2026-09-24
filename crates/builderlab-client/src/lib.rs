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
const CLI_SERVICE_PATH: &str = "/api/goose";
const ENDPOINT_PATH: &str = "/v3/beekeeper/list-agents";
const SESSION_HEADER: &str = "X-BB-Session-Credential";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SessionStatus {
    NotConfigured,
    LoggedOut,
    Available,
    Error { message: String },
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
    fn post<'a>(
        &'a self,
        url: &'a str,
        credential: &'a str,
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
    fn post<'a>(
        &'a self,
        url: &'a str,
        credential: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>> {
        Box::pin(async move {
            let response = self
                .client
                .post(url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header(SESSION_HEADER, credential)
                .json(&serde_json::json!({ "include_instructions": true }))
                .send()
                .await
                .map_err(|_| HttpError)?;
            let status = response.status().as_u16();
            let body = response.bytes().await.map_err(|_| HttpError)?.to_vec();
            Ok(HttpResponse { status, body })
        })
    }
}

pub async fn check_from_env() -> SessionStatus {
    let Some(raw_url) = std::env::var_os("BUILDERLAB_URL") else {
        return SessionStatus::NotConfigured;
    };
    let raw_url = raw_url.to_string_lossy();
    let base = match service_url(&raw_url) {
        Ok(base) => base,
        Err(message) => return SessionStatus::Error { message },
    };
    let transport = match ReqwestTransport::new() {
        Ok(transport) => transport,
        Err(message) => return SessionStatus::Error { message },
    };
    check_session(&SystemKeychain, &transport, &base, SystemTime::now()).await
}

pub async fn check_session(
    keychain: &dyn Keychain,
    transport: &dyn HttpTransport,
    base: &str,
    now: SystemTime,
) -> SessionStatus {
    let base = match service_url(base) {
        Ok(base) => base,
        Err(message) => return SessionStatus::Error { message },
    };
    let account = format!("{PROFILE}@{base}");
    let credential = match keychain.read(KEYCHAIN_SERVICE, &account) {
        Ok(Some(value)) => match parse_credential(&value, now) {
            Ok(value) => value,
            Err(CredentialError::Expired | CredentialError::Invalid) => {
                return SessionStatus::LoggedOut
            }
        },
        Ok(None) => return SessionStatus::LoggedOut,
        Err(KeychainError::Unavailable) => {
            return SessionStatus::Error {
                message: "BuilderLab login is unavailable on this platform".into(),
            }
        }
    };
    let endpoint = format!("{base}{ENDPOINT_PATH}");
    let response = match transport.post(&endpoint, &credential).await {
        Ok(response) => response,
        Err(HttpError) => {
            return SessionStatus::Error {
                message: "Could not connect to BuilderLab".into(),
            }
        }
    };
    if matches!(response.status, 401 | 403) {
        return SessionStatus::LoggedOut;
    }
    if !StatusCode::from_u16(response.status)
        .map(|status| status.is_success())
        .unwrap_or(false)
    {
        return SessionStatus::Error {
            message: "BuilderLab rejected the session check".into(),
        };
    }
    if valid_list_agents_response(&response.body) {
        SessionStatus::Available
    } else {
        SessionStatus::Error {
            message: "BuilderLab returned an invalid session response".into(),
        }
    }
}

fn service_url(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value)
        .map_err(|_| "BUILDERLAB_URL must be a credential-free HTTPS URL".to_owned())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("BUILDERLAB_URL must be a credential-free HTTPS URL".into());
    }
    if url.path().trim_end_matches('/').is_empty() {
        url.set_path(CLI_SERVICE_PATH);
    }
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

fn valid_list_agents_response(body: &[u8]) -> bool {
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let Some(object) = parsed.as_object() else {
        return false;
    };
    let status_valid = object.get("status").is_some_and(|status| {
        status == 1 || status == "SUCCESS" || status == "LIST_AGENTS_STATUS_SUCCESS"
    });
    status_valid && object.get("agents").is_none_or(Value::is_array)
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
    }

    impl HttpTransport for FakeTransport {
        fn post<'a>(
            &'a self,
            url: &'a str,
            credential: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>> {
            self.calls
                .lock()
                .unwrap()
                .push((url.into(), credential.into()));
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
        }
    }

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000)
    }

    #[test]
    fn validates_and_normalizes_service_urls() {
        assert_eq!(
            service_url("https://example.test///").unwrap(),
            "https://example.test/api/goose"
        );
        assert_eq!(
            service_url("https://example.test").unwrap(),
            "https://example.test/api/goose"
        );
        assert_eq!(
            service_url("https://EXAMPLE.test/api/goose/").unwrap(),
            "https://example.test/api/goose"
        );
        for value in [
            "http://example.test",
            "https://user@example.test",
            "https://example.test?secret=1",
            "https://example.test#secret",
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
    async fn uses_scoped_keychain_entry_and_session_endpoint() {
        let keychain = FakeKeychain {
            value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
            ..Default::default()
        };
        let transport = transport(200, br#"{"status":"SUCCESS","agents":[]}"#);
        assert_eq!(
            check_session(&keychain, &transport, BASE, now()).await,
            SessionStatus::Available
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
                format!("https://app.builderlab.xyz/api/goose{ENDPOINT_PATH}"),
                TEST_CREDENTIAL.into()
            )]
        );
    }

    #[tokio::test]
    async fn maps_missing_expired_unauthorized_malformed_and_transport_failures() {
        let missing = FakeKeychain::default();
        let success = transport(200, br#"{"status":"SUCCESS"}"#);
        assert_eq!(
            check_session(&missing, &success, BASE, now()).await,
            SessionStatus::LoggedOut
        );

        let expired = FakeKeychain {
            value: Some(
                format!(r#"{{"sessionCredential":"{TEST_CREDENTIAL}","expiresAt":"2020-01-01T00:00:00Z"}}"#)
                    .into_bytes(),
            ),
            ..Default::default()
        };
        assert_eq!(
            check_session(&expired, &success, BASE, now()).await,
            SessionStatus::LoggedOut
        );

        for status in [401, 403] {
            let keychain = FakeKeychain {
                value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
                ..Default::default()
            };
            assert_eq!(
                check_session(&keychain, &transport(status, b"{}"), BASE, now()).await,
                SessionStatus::LoggedOut
            );
        }
        let keychain = FakeKeychain {
            value: Some(TEST_CREDENTIAL.as_bytes().to_vec()),
            ..Default::default()
        };
        assert!(matches!(
            check_session(&keychain, &transport(200, b"bad"), BASE, now()).await,
            SessionStatus::Error { .. }
        ));
        let network = FakeTransport {
            response: Err(HttpError),
            calls: Mutex::new(Vec::new()),
        };
        assert!(matches!(
            check_session(&keychain, &network, BASE, now()).await,
            SessionStatus::Error { .. }
        ));
    }
}
