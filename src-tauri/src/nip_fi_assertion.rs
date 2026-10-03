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
/// Prefix for adapter refusals that need a visible manual retry, not reconnects.
pub(crate) const REFUSED: &str = "Relay badge was refused";
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
/// Bounds one native badge setup, including the WebSocket handshake.
pub(crate) const DEADLINE: Duration = Duration::from_secs(30);
pub(crate) const TIMED_OUT: &str = "Relay badge request timed out";
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
        self.get_until(identity, url, fresh, tokio::time::Instant::now() + DEADLINE)
            .await
    }

    /// Carries a caller's overall setup deadline through discovery, badge
    /// issuance, refusal cleanup, and the eventual native socket handshake.
    pub(crate) async fn get_until(
        &self,
        identity: &IdentityHost,
        url: &Url,
        fresh: bool,
        deadline: tokio::time::Instant,
    ) -> Result<Option<Assertion>> {
        let Some(relay) = tokio::time::timeout_at(deadline, self.required_relay(url))
            .await
            .map_err(|_| TIMED_OUT.to_owned())??
        else {
            return Ok(None);
        };
        for _ in 0..2 {
            let Some(snapshot) = tokio::time::timeout_at(deadline, self.owner.session_snapshot())
                .await
                .map_err(|_| TIMED_OUT.to_owned())??
            else {
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
            let issued = tokio::time::timeout_at(
                deadline,
                issue(
                    &self.owner,
                    &snapshot,
                    client()?,
                    &endpoint,
                    identity,
                    &relay,
                    issued_at,
                ),
            )
            .await
            .map_err(|_| TIMED_OUT.to_owned())?;
            match issued {
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
                    // Keep the owner's durable refusal cleanup running if the
                    // caller's setup deadline expires while secure storage is
                    // slow. The owner has already fenced this snapshot before
                    // awaiting storage.
                    let owner = self.owner.clone();
                    let rejection =
                        tokio::spawn(async move { owner.reject_shared_session(&snapshot).await });
                    match tokio::time::timeout_at(deadline, rejection).await {
                        Err(_) => return Err(SIGN_IN_REQUIRED.into()),
                        Ok(Err(_)) => {
                            return Err("Relay badge refusal could not be processed".into());
                        }
                        Ok(Ok(Err(error))) => return Err(error),
                        Ok(Ok(Ok(SharedSessionRejection::Superseded))) => continue,
                        Ok(Ok(Ok(
                            SharedSessionRejection::Removed | SharedSessionRejection::Retained,
                        ))) => return Err(SIGN_IN_REQUIRED.into()),
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
    signed_at: u64,
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
            created_at: signed_at,
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
    let bytes = read_bounded(response)
        .await
        .map_err(IssueFailure::Failed)?
        .unwrap_or_default();
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
        return Err(IssueFailure::Failed(if matches!(status, 429 | 503) {
            format!("Relay badge is unavailable ({status} {code})")
        } else {
            format!("{REFUSED} ({status} {code})")
        }));
    }
    // The adapter can issue the badge while this request is in flight; assess
    // its lifetime from response arrival, not from when the proof was signed.
    let received = now().map_err(IssueFailure::Failed)?;
    let invalid = || IssueFailure::Failed(format!("{REFUSED} (invalid adapter response)"));
    let issued: IssueResponse = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if issued.nostr_pubkey != pubkey
        || issued.assertion.is_empty()
        || issued.assertion.len() > MAX_ASSERTION
        || !issued.assertion.bytes().all(|b| b.is_ascii_graphic())
        || issued.expires_at <= received
        || issued.expires_at > received + MAX_LIFETIME
    {
        return Err(invalid());
    }
    Ok(Assertion {
        header: Zeroizing::new(format!("Bearer {}", issued.assertion.as_str())),
        expires_at: issued.expires_at,
    })
}

/// Returns `None` when a body exceeds the cap so HTTP status can still decide
/// whether an adapter refusal is transient. Interrupted reads remain retryable.
async fn read_bounded(mut response: reqwest::Response) -> Result<Option<Zeroizing<Vec<u8>>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Relay badge response was interrupted")?
    {
        if chunk.len() > MAX_RESPONSE - bytes.len() {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
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

#[cfg(test)]
mod tests;
