use std::{sync::OnceLock, time::Duration};

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::enterprise_relay_url::{
    canonical_enterprise_relay_url, parse_enterprise_relay_allowlist,
};

const MAX_DISCOVERY_BODY: usize = 128 * 1024;

fn enterprise_relay_http_url(relay: &str) -> Result<Url, String> {
    let mut url = Url::parse(relay).map_err(|_| "Invalid enterprise relay URL")?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return Err("Invalid enterprise relay URL".into()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "Could not normalize enterprise relay URL")?;
    let path = format!("{}/info", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub(crate) enum EnterpriseLoginGateStatus {
    NotRequired,
    Required,
}

#[tauri::command]
pub(crate) async fn enterprise_login_gate(
    relay_url: String,
) -> Result<EnterpriseLoginGateStatus, String> {
    let trusted = configured_trusted_relays()?;
    discover_enterprise_login_gate(&relay_url, &trusted, None).await
}

async fn discover_enterprise_login_gate(
    relay_url: &str,
    trusted: &[String],
    // Production passes None; tests replace only the already-authorized destination with loopback.
    discovery_url_override: Option<Url>,
) -> Result<EnterpriseLoginGateStatus, String> {
    if trusted.is_empty() {
        return Ok(EnterpriseLoginGateStatus::NotRequired);
    }
    if !trusted_relay_matches(relay_url, trusted)? {
        return Ok(EnterpriseLoginGateStatus::NotRequired);
    }
    let relay = canonical_enterprise_relay_url(relay_url)?;
    let discovery_url = discovery_url_override.unwrap_or(enterprise_relay_http_url(&relay)?);

    let response = client()?
        .get(discovery_url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| "Enterprise community discovery failed".to_owned())?;
    if !response.status().is_success() {
        return Err("Enterprise community discovery failed".into());
    }
    let body = read_bounded(response).await?;
    let document: Value = serde_json::from_slice(&body)
        .map_err(|_| "Enterprise community discovery was invalid".to_owned())?;
    evaluate_trusted_enterprise_login_gate(&document)
}

fn trusted_relay_matches(relay_url: &str, trusted: &[String]) -> Result<bool, String> {
    if trusted.is_empty() {
        return Ok(false);
    }
    let relay = canonical_enterprise_relay_url(relay_url)?;
    Ok(trusted.iter().any(|trusted| trusted == &relay))
}

pub(crate) fn configured_trusted_relays() -> Result<Vec<String>, String> {
    option_env!("BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS")
        .map(parse_enterprise_relay_allowlist)
        .transpose()
        .map(|relays| relays.unwrap_or_default())
}

fn evaluate_trusted_enterprise_login_gate(
    document: &Value,
) -> Result<EnterpriseLoginGateStatus, String> {
    let limitation_requires = match document
        .get("limitation")
        .and_then(|limitation| limitation.get("federated_identity"))
    {
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("Enterprise identity discovery was invalid".into()),
        None => false,
    };
    let Some(discovery) = document.get("federated_identity") else {
        return Err(if limitation_requires {
            "Enterprise identity discovery was incomplete".into()
        } else {
            "This trusted community did not advertise supported enterprise login".into()
        });
    };
    if !limitation_requires {
        return Err("Enterprise identity discovery was inconsistent".into());
    }
    let Some(discovery) = discovery.as_object() else {
        return Err("Enterprise identity discovery was invalid".into());
    };
    if discovery.get("core").and_then(Value::as_str) != Some("client-attached") {
        return Err("This community advertised an unsupported enterprise login".into());
    }
    let Some(freshness) = discovery
        .get("assertion_freshness")
        .and_then(Value::as_object)
    else {
        return Err("Enterprise identity discovery was incomplete".into());
    };
    if freshness.get("class").and_then(Value::as_str) != Some("offline-jwt") {
        return Err("This community advertised an unsupported enterprise login".into());
    }
    if !matches!(
        freshness.get("maximum_residual_upstream_revocation_seconds"),
        None | Some(Value::Null)
    ) {
        return Err("This community advertised an unsupported enterprise login".into());
    }
    Ok(EnterpriseLoginGateStatus::Required)
}

fn client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Enterprise network client is unavailable".into())
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DISCOVERY_BODY as u64)
    {
        return Err("Enterprise community discovery was too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Enterprise community discovery failed".to_owned())?
    {
        if chunk.len() > MAX_DISCOVERY_BODY - body.len() {
            return Err("Enterprise community discovery was too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{Shutdown, SocketAddr, TcpListener, TcpStream},
        thread::{self, JoinHandle},
    };

    const TRUSTED_RELAY: &str = "wss://enterprise.example";
    const SHUTDOWN_REQUEST: &[u8] = b"BUZZ_FIXTURE_SHUTDOWN\n";

    struct Fixture {
        address: SocketAddr,
        join: Option<JoinHandle<Option<Vec<u8>>>>,
        url: Url,
    }

    impl Fixture {
        fn spawn(response: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let join = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream).ok()??;
                let _ = stream.write_all(&response);
                Some(request)
            });
            Self {
                address,
                join: Some(join),
                url: Url::parse(&format!("http://{address}/info")).unwrap(),
            }
        }

        fn wake(&self) {
            if let Ok(mut stream) = TcpStream::connect(self.address) {
                let _ = stream.write_all(SHUTDOWN_REQUEST);
                let _ = stream.shutdown(Shutdown::Write);
            }
        }

        fn finish(mut self) -> Option<Vec<u8>> {
            let join = self.join.take().unwrap();
            self.wake();
            join.join().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(join) = self.join.take() {
                self.wake();
                let _ = join.join();
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Vec<u8>>> {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        loop {
            let read = stream.read(&mut buffer)?;
            if read == 0 {
                return Ok(None);
            }
            request.extend_from_slice(&buffer[..read]);
            if request.starts_with(SHUTDOWN_REQUEST) {
                return Ok(None);
            }
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                return Ok(Some(request));
            }
            if request.len() > 64 * 1024 {
                return Err(std::io::Error::other("fixture request headers too large"));
            }
        }
    }

    fn response(status: &str, body: &[u8], content_length: usize) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn chunked_response(body: &[u8]) -> Vec<u8> {
        let mut response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".to_vec();
        for chunk in body.chunks(4096) {
            write!(&mut response, "{:x}\r\n", chunk.len()).unwrap();
            response.extend_from_slice(chunk);
            response.extend_from_slice(b"\r\n");
        }
        response.extend_from_slice(b"0\r\n\r\n");
        response
    }

    fn redirect_response(location: &Url) -> Vec<u8> {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn trusted_relays() -> Vec<String> {
        parse_enterprise_relay_allowlist(TRUSTED_RELAY).unwrap()
    }

    async fn discover_with_fixture(
        response: Vec<u8>,
        trusted: &[String],
    ) -> (Result<EnterpriseLoginGateStatus, String>, Option<Vec<u8>>) {
        let fixture = Fixture::spawn(response);
        let result =
            discover_enterprise_login_gate(TRUSTED_RELAY, trusted, Some(fixture.url.clone())).await;
        (result, fixture.finish())
    }

    fn assert_info_request(request: Option<&Vec<u8>>) {
        let request = String::from_utf8_lossy(request.unwrap());
        assert!(request.starts_with("GET /info HTTP/1.1"));
        assert!(request
            .lines()
            .any(|line| line.eq_ignore_ascii_case("Accept: application/nostr+json")));
    }

    fn padded_discovery_body(length: usize) -> Vec<u8> {
        let mut document = discovery_document();
        document["padding"] = Value::String(String::new());
        let empty_padding_length = serde_json::to_vec(&document).unwrap().len();
        document["padding"] = Value::String("x".repeat(length - empty_padding_length));
        let body = serde_json::to_vec(&document).unwrap();
        assert_eq!(body.len(), length);
        body
    }

    fn discovery_document() -> Value {
        serde_json::json!({
            "limitation": { "federated_identity": true },
            "federated_identity": {
                "core": "client-attached",
                "assertion_freshness": {
                    "class": "offline-jwt",
                    "maximum_residual_upstream_revocation_seconds": null
                }
            }
        })
    }

    #[test]
    fn matching_advertisement_requires_login() {
        assert_eq!(
            evaluate_trusted_enterprise_login_gate(&discovery_document()).unwrap(),
            EnterpriseLoginGateStatus::Required
        );
    }

    #[test]
    fn missing_or_inconsistent_advertisement_fails_closed() {
        for document in [
            serde_json::json!({}),
            serde_json::json!({
                "limitation": { "federated_identity": false },
                "federated_identity": {}
            }),
        ] {
            assert!(evaluate_trusted_enterprise_login_gate(&document).is_err());
        }
    }

    #[test]
    fn unsupported_freshness_is_rejected() {
        let mut document = discovery_document();
        document["federated_identity"]["assertion_freshness"]["class"] =
            Value::String("current-status".into());
        assert!(evaluate_trusted_enterprise_login_gate(&document).is_err());
    }

    #[test]
    fn ordinary_relays_bypass_the_trusted_gate() {
        let trusted = vec!["wss://enterprise.example/".to_owned()];
        assert!(!trusted_relay_matches("https://ordinary.example/", &trusted).unwrap());
        assert!(!trusted_relay_matches("https://ordinary.example/", &[]).unwrap());
    }

    #[test]
    fn trusted_matching_uses_secure_origin_canonicalization() {
        let trusted = parse_enterprise_relay_allowlist("https://EXAMPLE.com.").unwrap();
        assert!(trusted_relay_matches("https://example.com", &trusted).unwrap());
        assert!(trusted_relay_matches("wss://EXAMPLE.com:443/", &trusted).unwrap());
    }

    #[test]
    fn maps_websocket_discovery_to_http_info() {
        assert_eq!(
            enterprise_relay_http_url("wss://relay.example/")
                .unwrap()
                .as_str(),
            "https://relay.example/info"
        );
    }

    #[tokio::test]
    async fn ordinary_and_unconfigured_relays_never_fetch_discovery() {
        let body = serde_json::to_vec(&discovery_document()).unwrap();
        for (relay, trusted) in [
            ("wss://ordinary.example", trusted_relays()),
            (TRUSTED_RELAY, Vec::new()),
        ] {
            let fixture = Fixture::spawn(response("200 OK", &body, body.len()));
            let status = discover_enterprise_login_gate(relay, &trusted, Some(fixture.url.clone()))
                .await
                .unwrap();
            assert_eq!(status, EnterpriseLoginGateStatus::NotRequired);
            assert!(fixture.finish().is_none());
        }
    }

    #[tokio::test]
    async fn trusted_discovery_requires_valid_metadata_and_sends_expected_request() {
        let body = serde_json::to_vec(&discovery_document()).unwrap();
        let (status, request) =
            discover_with_fixture(response("200 OK", &body, body.len()), &trusted_relays()).await;
        assert_eq!(status.unwrap(), EnterpriseLoginGateStatus::Required);
        assert_info_request(request.as_ref());
    }

    #[tokio::test]
    async fn trusted_discovery_failures_fail_closed() {
        let cases = [
            ("503 Service Unavailable", b"unavailable".to_vec(), "failed"),
            ("200 OK", b"not json".to_vec(), "invalid"),
            ("200 OK", b"{}".to_vec(), "did not advertise"),
            (
                "200 OK",
                br#"{"limitation":{"federated_identity":true}}"#.to_vec(),
                "incomplete",
            ),
            (
                "200 OK",
                br#"{"limitation":{"federated_identity":false},"federated_identity":{}}"#.to_vec(),
                "inconsistent",
            ),
        ];
        for (status, body, expected_error) in cases {
            let (result, request) =
                discover_with_fixture(response(status, &body, body.len()), &trusted_relays()).await;
            let error = result.unwrap_err();
            assert!(error.contains(expected_error), "{error}");
            assert_info_request(request.as_ref());
        }
    }

    #[tokio::test]
    async fn trusted_discovery_refuses_redirects() {
        let body = serde_json::to_vec(&discovery_document()).unwrap();
        let target = Fixture::spawn(response("200 OK", &body, body.len()));
        let redirect = Fixture::spawn(redirect_response(&target.url));
        let error = discover_enterprise_login_gate(
            TRUSTED_RELAY,
            &trusted_relays(),
            Some(redirect.url.clone()),
        )
        .await
        .unwrap_err();
        let redirect_request = redirect.finish();
        let target_request = target.finish();

        assert!(error.contains("failed"), "{error}");
        assert_info_request(redirect_request.as_ref());
        assert!(target_request.is_none());
    }

    #[tokio::test]
    async fn trusted_discovery_body_limit_covers_declared_and_chunked_responses() {
        let exact = padded_discovery_body(MAX_DISCOVERY_BODY);
        let oversized = padded_discovery_body(MAX_DISCOVERY_BODY + 1);
        let cases = [
            (
                "declared exact",
                response("200 OK", &exact, exact.len()),
                true,
            ),
            (
                "declared oversized",
                response("200 OK", &[], MAX_DISCOVERY_BODY + 1),
                false,
            ),
            ("chunked exact", chunked_response(&exact), true),
            ("chunked oversized", chunked_response(&oversized), false),
        ];
        for (name, response, succeeds) in cases {
            let (result, request) = discover_with_fixture(response, &trusted_relays()).await;

            if succeeds {
                assert_eq!(
                    result.unwrap(),
                    EnterpriseLoginGateStatus::Required,
                    "{name}"
                );
            } else {
                assert!(
                    result.unwrap_err().contains("too large"),
                    "{name} should be bounded"
                );
            }
            assert_info_request(request.as_ref());
        }
    }
}
