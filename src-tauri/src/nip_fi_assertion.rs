//! Relay badges (NIP-FI assertions) for trusted enterprise relays.
//!
//! The adapter issues a short-lived assertion for the person's own key, proved
//! with a NIP-98 event signed through `IdentityHost`. Relay HTTP reuses a badge
//! until shortly before expiry; each WebSocket connection asks for a fresh one
//! so a revoked person is caught at the next reconnect.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use buzz_builderlab_session::{SessionOwner, SessionSnapshot, SharedSessionRejection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use crate::{
    enterprise_login_gate::{discover_enterprise_login_gate, EnterpriseLoginGateStatus},
    enterprise_relay_url::canonical_enterprise_relay_url,
    identity::{EventTemplate, IdentityHost},
};

/// Shown to JavaScript, which returns the person to enterprise sign-in.
pub(crate) const SIGN_IN_REQUIRED: &str = "Enterprise sign-in is required";
/// Shown to JavaScript when this relay denies access without invalidating the session.
pub(crate) const ACCESS_DENIED: &str = "Enterprise access to this relay was denied";
pub(crate) const HEADER: &str = "Nostr-Federated-Identity";
const ASSERTION_PATH: &str = "/v1/identity/assertions";
/// NIP-FI caps assertion lifetime at five minutes.
const MAX_LIFETIME: u64 = 300;
/// Refresh this long before expiry so a request or handshake never carries a
/// badge that lapses in flight.
const REFRESH_MARGIN: u64 = 60;
const MAX_ASSERTION: usize = 8192;
const MAX_RESPONSE: usize = 16 * 1024;
const MAX_ASSERTION_CACHE: usize = 128;
const REQUIREMENT_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_REQUIREMENT_CACHE: usize = 128;
const SESSION_CHANGED: &str = "BuilderLab session changed while requesting a relay badge; retry";

type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
#[cfg_attr(test, derive(Debug))]
pub(crate) struct Assertion {
    /// The complete `Nostr-Federated-Identity` header value.
    pub(crate) header: Zeroizing<String>,
    /// Unix seconds; never more than `MAX_LIFETIME` from issuance.
    pub(crate) expires_at: u64,
}

struct Cached {
    session: [u8; 32],
    assertion: Assertion,
}

#[derive(Clone, Copy)]
struct CachedRequirement {
    required: bool,
    checked_at: Instant,
}

#[derive(Clone)]
pub(crate) struct RelayAssertions {
    owner: SessionOwner,
    cache: Arc<Mutex<HashMap<String, Cached>>>,
    requirements: Arc<Mutex<HashMap<String, CachedRequirement>>>,
    #[cfg(test)]
    discovery_url_override: Option<Url>,
    #[cfg(test)]
    skip_discovery: bool,
}

#[derive(Serialize)]
struct IssueRequest<'a> {
    relay_url: &'a str,
    nostr_pubkey: &'a str,
}

#[derive(Deserialize)]
struct IssueResponse {
    assertion: Zeroizing<String>,
    nostr_pubkey: String,
    expires_at: u64,
}

#[derive(Deserialize)]
struct Denial {
    error: String,
}

enum IssueFailure {
    SessionDenied,
    Failed(String),
}

impl RelayAssertions {
    pub(crate) fn new(owner: SessionOwner) -> Self {
        Self {
            owner,
            cache: Arc::default(),
            requirements: Arc::default(),
            #[cfg(test)]
            discovery_url_override: None,
            #[cfg(test)]
            skip_discovery: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn without_discovery() -> Self {
        let owner = SessionOwner::from_home(".", None, "test-enterprise-session");
        let mut assertions = Self::new(owner);
        assertions.skip_discovery = true;
        assertions
    }

    #[cfg(test)]
    fn with_discovery_url(mut self, url: Url) -> Self {
        self.discovery_url_override = Some(url);
        self
    }

    pub(crate) async fn enterprise_login_gate(
        &self,
        relay_url: &str,
    ) -> Result<EnterpriseLoginGateStatus> {
        self.requirement(relay_url).await
    }

    async fn requirement(&self, relay_url: &str) -> Result<EnterpriseLoginGateStatus> {
        let relay = canonical_enterprise_relay_url(relay_url)?;
        if let Some(required) = self.cached_requirement(&relay, Instant::now())? {
            return Ok(if required {
                EnterpriseLoginGateStatus::Required
            } else {
                EnterpriseLoginGateStatus::NotRequired
            });
        }
        let status = discover_enterprise_login_gate(&relay, {
            #[cfg(test)]
            {
                self.discovery_url_override.clone()
            }
            #[cfg(not(test))]
            {
                None
            }
        })
        .await?;
        self.cache_requirement(
            relay,
            status == EnterpriseLoginGateStatus::Required,
            Instant::now(),
        )?;
        Ok(status)
    }

    fn cached_requirement(&self, relay: &str, now: Instant) -> Result<Option<bool>> {
        let mut requirements = self
            .requirements
            .lock()
            .map_err(|_| "Enterprise identity requirement cache is unavailable")?;
        match requirements.get(relay).copied() {
            Some(cached)
                if now.saturating_duration_since(cached.checked_at) < REQUIREMENT_CACHE_TTL =>
            {
                Ok(Some(cached.required))
            }
            Some(_) => {
                requirements.remove(relay);
                Ok(None)
            }
            None => Ok(None),
        }
    }

    fn cache_requirement(&self, relay: String, required: bool, checked_at: Instant) -> Result<()> {
        let mut requirements = self
            .requirements
            .lock()
            .map_err(|_| "Enterprise identity requirement cache is unavailable")?;
        requirements.retain(|_, cached| {
            checked_at.saturating_duration_since(cached.checked_at) < REQUIREMENT_CACHE_TTL
        });
        if !requirements.contains_key(&relay) && requirements.len() >= MAX_REQUIREMENT_CACHE {
            if let Some(oldest) = requirements
                .iter()
                .min_by_key(|(_, cached)| cached.checked_at)
                .map(|(relay, _)| relay.clone())
            {
                requirements.remove(&oldest);
            }
        }
        requirements.insert(
            relay,
            CachedRequirement {
                required,
                checked_at,
            },
        );
        Ok(())
    }

    /// The badge for a relay whose NIP-11 limitation requires federated
    /// identity, or `None` for ordinary relays. `fresh` skips assertion reuse.
    pub(crate) async fn get(
        &self,
        identity: &IdentityHost,
        url: &Url,
        fresh: bool,
    ) -> Result<Option<Assertion>> {
        let Some(relay) = self.required_relay(url).await? else {
            return Ok(None);
        };
        for _ in 0..2 {
            let Some(snapshot) = self.owner.session_snapshot().await? else {
                return Err(SIGN_IN_REQUIRED.into());
            };
            let session: [u8; 32] = Sha256::digest(snapshot.credential().as_bytes()).into();
            let issued_at = now()?;
            if !fresh {
                match self.owner.admit(&snapshot, || {
                    self.cached_assertion(&relay, session, issued_at)
                }) {
                    None => continue,
                    Some(Err(error)) => return Err(error),
                    Some(Ok(Some(assertion))) => return Ok(Some(assertion)),
                    Some(Ok(None)) => {}
                }
            }
            let endpoint = self.owner.endpoint(ASSERTION_PATH)?;
            match issue(
                &self.owner,
                &snapshot,
                client()?,
                &endpoint,
                identity,
                &relay,
                issued_at,
            )
            .await
            {
                Ok(assertion) => {
                    let accepted_at = now()?;
                    match self.owner.admit(&snapshot, || {
                        self.cache_assertion(&relay, session, assertion, accepted_at)
                    }) {
                        None => continue,
                        Some(Err(error)) => return Err(error),
                        Some(Ok(assertion)) => return Ok(Some(assertion)),
                    }
                }
                Err(IssueFailure::SessionDenied) => {
                    let cleared = self.owner.admit(&snapshot, || {
                        let mut cache = self
                            .cache
                            .lock()
                            .map_err(|_| "Relay badge cache is unavailable")?;
                        if cache
                            .get(&relay)
                            .is_some_and(|cached| cached.session == session)
                        {
                            cache.remove(&relay);
                        }
                        Ok::<_, String>(())
                    });
                    match cleared {
                        None => continue,
                        Some(Err(error)) => return Err(error),
                        Some(Ok(())) => {}
                    }
                    match self.owner.reject_shared_session(&snapshot).await? {
                        SharedSessionRejection::Superseded => continue,
                        SharedSessionRejection::Removed | SharedSessionRejection::Retained => {
                            return Err(SIGN_IN_REQUIRED.into());
                        }
                    }
                }
                Err(IssueFailure::Failed(error)) => {
                    if let Some(error) = self.owner.admit(&snapshot, || error) {
                        return Err(error);
                    }
                }
            }
        }
        Err(SESSION_CHANGED.into())
    }

    /// Adds the relay badge to a protected relay HTTP request when the relay
    /// is a trusted enterprise relay and an enterprise session is saved.
    pub(crate) async fn attach(
        &self,
        identity: &IdentityHost,
        url: &Url,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder> {
        Ok(match self.get(identity, url, false).await? {
            Some(assertion) => request.header(HEADER, assertion.header.as_str()),
            None => request,
        })
    }

    fn cached_assertion(
        &self,
        relay: &str,
        session: [u8; 32],
        now: u64,
    ) -> Result<Option<Assertion>> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Relay badge cache is unavailable")?;
        cache.retain(|_, cached| cached.assertion.expires_at > now);
        Ok(cache
            .get(relay)
            .filter(|cached| {
                cached.session == session && cached.assertion.expires_at > now + REFRESH_MARGIN
            })
            .map(|cached| cached.assertion.clone()))
    }

    fn cache_assertion(
        &self,
        relay: &str,
        session: [u8; 32],
        assertion: Assertion,
        now: u64,
    ) -> Result<Assertion> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Relay badge cache is unavailable")?;
        cache.retain(|_, cached| cached.assertion.expires_at > now);
        if assertion.expires_at > now + REFRESH_MARGIN {
            if !cache.contains_key(relay) && cache.len() >= MAX_ASSERTION_CACHE {
                if let Some(earliest) = cache
                    .iter()
                    .min_by_key(|(_, cached)| cached.assertion.expires_at)
                    .map(|(relay, _)| relay.clone())
                {
                    cache.remove(&earliest);
                }
            }
            cache.insert(
                relay.to_owned(),
                Cached {
                    session,
                    assertion: assertion.clone(),
                },
            );
        }
        Ok(assertion)
    }

    async fn required_relay(&self, url: &Url) -> Result<Option<String>> {
        #[cfg(test)]
        if self.skip_discovery {
            return Ok(None);
        }
        let Ok(relay) = canonical_enterprise_relay_url(&url[..url::Position::BeforePath]) else {
            return Ok(None);
        };
        match self.requirement(&relay).await? {
            EnterpriseLoginGateStatus::Required => Ok(Some(relay.trim_end_matches('/').to_owned())),
            EnterpriseLoginGateStatus::NotRequired => Ok(None),
        }
    }
}

/// The contract's session carriage. Kept in one place while the adapter
/// contract settles which header carries the session and which the proof.
fn authorize(
    request: reqwest::RequestBuilder,
    session: &str,
    proof: &str,
) -> reqwest::RequestBuilder {
    request
        .header("Authorization", format!("Bearer {session}"))
        .header("Nostr-Authorization", proof)
}

/// Only lost-session responses authorize durable refusal of the shared session.
fn session_denied(status: u16, code: &str) -> bool {
    matches!(
        (status, code),
        (401, "session_required" | "session_expired")
    )
}

async fn issue(
    owner: &SessionOwner,
    snapshot: &SessionSnapshot,
    http: &reqwest::Client,
    endpoint: &Url,
    identity: &IdentityHost,
    relay: &str,
    now: u64,
) -> std::result::Result<Assertion, IssueFailure> {
    // The signer, not local key storage, decides whose badge is requested.
    let pubkey = identity.viewer().await.map_err(IssueFailure::Failed)?;
    let body = serde_json::to_vec(&IssueRequest {
        relay_url: relay,
        nostr_pubkey: &pubkey,
    })
    .map_err(|_| IssueFailure::Failed("Could not encode relay badge request".into()))?;
    let proof = identity
        .sign(EventTemplate {
            kind: 27235,
            created_at: now,
            content: String::new(),
            tags: vec![
                vec!["u".into(), endpoint.to_string()],
                vec!["method".into(), "POST".into()],
                vec!["payload".into(), format!("{:x}", Sha256::digest(&body))],
            ],
        })
        .await
        .map_err(IssueFailure::Failed)?;
    if proof.get("pubkey").and_then(serde_json::Value::as_str) != Some(pubkey.as_str()) {
        return Err(IssueFailure::Failed(
            "Relay badge signer does not match identity".into(),
        ));
    }
    let proof =
        format!(
            "Nostr {}",
            STANDARD.encode(serde_json::to_vec(&proof).map_err(|_| {
                IssueFailure::Failed("Could not encode relay badge proof".into())
            })?)
        );
    let Some(request) = owner.admit(snapshot, || {
        authorize(http.post(endpoint.clone()), snapshot.credential(), &proof)
            .header("Content-Type", "application/json")
            .body(body)
    }) else {
        return Err(IssueFailure::Failed(SESSION_CHANGED.into()));
    };
    let response = request
        .send()
        .await
        .map_err(|_| IssueFailure::Failed("Relay badge request failed".into()))?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await.map_err(IssueFailure::Failed)?;
    if status != 200 {
        let code = serde_json::from_slice::<Denial>(&bytes)
            .map(|denial| denial.error)
            .unwrap_or_default();
        if session_denied(status, &code) {
            return Err(IssueFailure::SessionDenied);
        }
        if status == 403 && code == "authorization_denied" {
            return Err(IssueFailure::Failed(ACCESS_DENIED.into()));
        }
        let code: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(64)
            .collect();
        return Err(IssueFailure::Failed(format!(
            "Relay badge was refused ({status} {code})"
        )));
    }
    let issued: IssueResponse = serde_json::from_slice(&bytes)
        .map_err(|_| IssueFailure::Failed("Relay badge response was invalid".into()))?;
    if issued.nostr_pubkey != pubkey
        || issued.assertion.is_empty()
        || issued.assertion.len() > MAX_ASSERTION
        || !issued.assertion.bytes().all(|b| b.is_ascii_graphic())
        || issued.expires_at <= now
        || issued.expires_at > now + MAX_LIFETIME
    {
        return Err(IssueFailure::Failed(
            "Relay badge response was invalid".into(),
        ));
    }
    Ok(Assertion {
        header: Zeroizing::new(format!("Bearer {}", issued.assertion.as_str())),
        expires_at: issued.expires_at,
    })
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Relay badge response was interrupted")?
    {
        if chunk.len() > MAX_RESPONSE - bytes.len() {
            return Err("Relay badge response was too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is unavailable")?
        .as_secs())
}

fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(15))
                .build()
        })
        .as_ref()
        .map_err(|_| "Enterprise network client is unavailable".into())
}

/// Badge for the relay WebSocket handshake. Returns the header value and its
/// expiry so the socket can rotate before the relay ends the connection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SocketBadge {
    header: String,
    expires_at: u64,
}

#[tauri::command]
pub(crate) async fn relay_socket_badge(
    identity: tauri::State<'_, IdentityHost>,
    assertions: tauri::State<'_, RelayAssertions>,
    url: String,
) -> Result<Option<SocketBadge>> {
    let url = Url::parse(&url).map_err(|_| "Invalid relay URL")?;
    if url.scheme() != "wss" {
        return Ok(None);
    }
    Ok(assertions
        .get(identity.inner(), &url, true)
        .await?
        .map(|assertion| SocketBadge {
            header: assertion.header.as_str().to_owned(),
            expires_at: assertion.expires_at,
        }))
}

#[cfg(test)]
mod tests;
