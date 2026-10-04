//! Relay badges (NIP-FI assertions) for trusted enterprise relays.
//!
//! The adapter issues a short-lived assertion for the person's own key, proved
//! with a NIP-98 event signed through `IdentityHost`. Relay HTTP reuses a badge
//! until shortly before expiry; each WebSocket connection asks for a fresh one
//! so a revoked person is caught at the next reconnect.
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::time::{timeout_at, Instant};
use url::Url;
use zeroize::Zeroizing;

use crate::{
    enterprise_auth::{EnterpriseAuthHost, Rejection, SavedSession},
    enterprise_login_gate::configured_trusted_relays,
    enterprise_relay_url::canonical_enterprise_relay_url,
    identity::{EventTemplate, IdentityHost},
};

/// Shown to JavaScript, which returns the person to enterprise sign-in.
pub(crate) const SIGN_IN_REQUIRED: &str = "Enterprise sign-in is required";
/// A refusal of a session that was already refused, removed or replaced;
/// retryable.
const SESSION_REPLACED: &str = "Enterprise session changed during the relay badge request";
/// Preparation (secure storage, signing) or the adapter did not answer in
/// time; retryable.
const TIMED_OUT: &str = "Relay badge request timed out";
/// Shown to JavaScript, which keeps the session and stops retrying the relay.
pub(crate) const ACCESS_DENIED: &str = "Enterprise access to this relay was denied";
/// Prefix of a failure that retrying cannot fix (a bad proof, binding or
/// request, or a malformed badge); JavaScript keeps the session, shows it and
/// stops retrying. Only overload and network failures are retried.
pub(crate) const REFUSED: &str = "Relay badge was refused";
pub(crate) const HEADER: &str = "Nostr-Federated-Identity";
const ASSERTION_PATH: &str = "/v1/identity/assertions";
/// The enterprise adapter contract caps assertion lifetime at five minutes.
const MAX_LIFETIME: u64 = 300;
/// Refresh this long before expiry so a request or handshake never carries a
/// badge that lapses in flight.
const REFRESH_MARGIN: u64 = 60;
const MAX_ASSERTION: usize = 8192;
const MAX_RESPONSE: usize = 16 * 1024;
/// Bounds everything native does for one badge: reading the saved session,
/// signing the proof, the adapter request and handling its refusal. A relay
/// socket connect fits its handshake inside the same bound, which sits below
/// JavaScript's 35 s setup deadline so native always answers first.
pub(crate) const DEADLINE: Duration = Duration::from_secs(30);

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

#[derive(Clone)]
pub(crate) struct RelayAssertions {
    enterprise: EnterpriseAuthHost,
    cache: Arc<Mutex<HashMap<String, Cached>>>,
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

impl RelayAssertions {
    pub(crate) fn new(enterprise: EnterpriseAuthHost) -> Self {
        Self {
            enterprise,
            cache: Arc::default(),
        }
    }

    /// The badge for the relay serving `url`, or `None` when the relay is not a
    /// trusted enterprise relay or no enterprise session is saved (the login
    /// gate owns whether sign-in is required). `fresh` skips the cache. The
    /// answer, including a refusal's, arrives by `deadline`.
    pub(crate) async fn get(
        &self,
        identity: &IdentityHost,
        url: &Url,
        fresh: bool,
        deadline: Instant,
    ) -> Result<Option<Assertion>> {
        let Some(relay) = trusted_relay(url)? else {
            return Ok(None);
        };
        let saved = self.enterprise.saved_session(identity);
        self.badge(identity, relay, saved, fresh, deadline).await
    }

    async fn badge(
        &self,
        identity: &IdentityHost,
        relay: String,
        saved: impl Future<Output = Result<Option<SavedSession>>>,
        fresh: bool,
        deadline: Instant,
    ) -> Result<Option<Assertion>> {
        let timed_out = |_| TIMED_OUT.to_owned();
        let Some(saved) = timeout_at(deadline, saved).await.map_err(timed_out)?? else {
            return Ok(None);
        };
        let session: [u8; 32] = Sha256::digest(saved.token().as_bytes()).into();
        let now = now()?;
        if !fresh {
            // Reusing a cached badge is a use of the session, admitted with
            // the cache read as one step (see `EnterpriseAuthHost::admit`).
            let reused = self.enterprise.admit(saved.token(), || {
                #[cfg(test)]
                crate::enterprise_auth::seams::reach(
                    crate::enterprise_auth::seams::Point::CacheRead,
                    saved.token(),
                );
                self.lock()
                    .get(&relay)
                    .filter(|cached| {
                        cached.session == session
                            && cached.assertion.expires_at > now + REFRESH_MARGIN
                    })
                    .map(|cached| cached.assertion.clone())
            });
            match reused {
                None => return Err(SESSION_REPLACED.into()),
                Some(Some(assertion)) => return Ok(Some(assertion)),
                Some(None) => {}
            }
        }
        let endpoint = Url::parse(&format!(
            "{}{ASSERTION_PATH}",
            saved.adapter().trim_end_matches('/')
        ))
        .map_err(|_| "Enterprise authentication adapter is invalid")?;
        let issued = timeout_at(
            deadline,
            issue(
                client()?,
                &endpoint,
                &self.enterprise,
                saved.token(),
                identity,
                &relay,
                now,
            ),
        )
        .await
        .map_err(timed_out)?;
        // Refused while this request ran, possibly after it was admitted and
        // sent: whatever it returned is dropped. The request whose refusal it
        // was asks for sign-in; this one is retried with whatever session is
        // saved now.
        let assertion = match issued {
            Err(_) if self.enterprise.refused(&saved) => return Err(SESSION_REPLACED.into()),
            Ok(assertion) => assertion,
            Err(error) if error == SIGN_IN_REQUIRED => {
                self.lock().remove(&relay);
                return Err(self.refused(saved, deadline).await);
            }
            Err(error) => return Err(error),
        };
        // Accepting the badge is admitted with its caching as one step, so no
        // badge is newly accepted or cached once its refusal returns.
        self.enterprise
            .admit(saved.token(), || {
                #[cfg(test)]
                crate::enterprise_auth::seams::reach(
                    crate::enterprise_auth::seams::Point::CacheInsert,
                    saved.token(),
                );
                self.lock().insert(
                    relay,
                    Cached {
                        session,
                        assertion: assertion.clone(),
                    },
                );
            })
            .ok_or(SESSION_REPLACED)?;
        Ok(Some(assertion))
    }

    /// The error for the adapter's refusal of `saved`. Only a refusal of the
    /// current session asks for sign-in; one that a newer login replaced
    /// meanwhile is retried with that login. Removal runs on its own task, so
    /// secure storage still finishes it if it outlasts `deadline`; at the
    /// deadline the refusal is reported as is, since no newer session had
    /// been adopted when it arrived.
    async fn refused(&self, saved: SavedSession, deadline: Instant) -> String {
        if self.enterprise.superseded(&saved) {
            return SESSION_REPLACED.into();
        }
        let enterprise = self.enterprise.clone();
        let removal = tokio::spawn(async move { enterprise.reject(saved).await });
        match timeout_at(deadline, removal).await {
            Ok(Ok(Ok(Rejection::Superseded))) => SESSION_REPLACED.into(),
            Ok(Ok(Err(error))) => error,
            Ok(Err(_)) => "Enterprise secure storage could not be accessed".into(),
            // The sign-in prompt shows a failed removal from `cleanup`.
            Ok(Ok(Ok(Rejection::Removed | Rejection::Retained))) | Err(_) => {
                SIGN_IN_REQUIRED.into()
            }
        }
    }

    /// Adds the relay badge to a protected relay HTTP request when the relay
    /// is a trusted enterprise relay and an enterprise session is saved.
    pub(crate) async fn attach(
        &self,
        identity: &IdentityHost,
        url: &Url,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder> {
        let Some(relay) = trusted_relay(url)? else {
            return Ok(request);
        };
        let saved = self.enterprise.saved_session(identity);
        self.attach_badge(identity, relay, saved, request).await
    }

    async fn attach_badge(
        &self,
        identity: &IdentityHost,
        relay: String,
        saved: impl Future<Output = Result<Option<SavedSession>>>,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder> {
        let deadline = Instant::now() + DEADLINE;
        Ok(
            match self.badge(identity, relay, saved, false, deadline).await? {
                Some(assertion) => request.header(HEADER, assertion.header.as_str()),
                None => request,
            },
        )
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Cached>> {
        self.cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The audience-bearing relay URL (`wss://host`, no trailing slash) when the
/// request targets a relay on this build's trusted enterprise list.
fn trusted_relay(url: &Url) -> Result<Option<String>> {
    let trusted = configured_trusted_relays()?;
    if trusted.is_empty() {
        return Ok(None);
    }
    let Ok(relay) = canonical_enterprise_relay_url(&url[..url::Position::BeforePath]) else {
        return Ok(None);
    };
    Ok(trusted
        .contains(&relay)
        .then(|| relay.trim_end_matches('/').to_owned()))
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

/// Only lost-session denials mean the person must sign in again; a policy
/// denial keeps the session, since signing in cannot change the policy. Every
/// other failure (proof, binding, overload, network) keeps the session so a
/// client or configuration fault never signs the person out.
fn denial(status: u16, code: &str) -> Option<&'static str> {
    match (status, code) {
        (401, "session_required" | "session_expired") => Some(SIGN_IN_REQUIRED),
        (403, "authorization_denied") => Some(ACCESS_DENIED),
        _ => None,
    }
}

async fn issue(
    http: &reqwest::Client,
    endpoint: &Url,
    enterprise: &EnterpriseAuthHost,
    session: &str,
    identity: &IdentityHost,
    relay: &str,
    now: u64,
) -> Result<Assertion> {
    #[cfg(test)]
    crate::enterprise_auth::seams::reach(crate::enterprise_auth::seams::Point::Preparing, session);
    // The signer, not local key storage, decides whose badge is requested.
    let pubkey = identity.viewer().await?;
    let body = serde_json::to_vec(&IssueRequest {
        relay_url: relay,
        nostr_pubkey: &pubkey,
    })
    .map_err(|_| "Could not encode relay badge request")?;
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
        .await?;
    if proof.get("pubkey").and_then(serde_json::Value::as_str) != Some(pubkey.as_str()) {
        return Err("Relay badge signer does not match identity".into());
    }
    let proof = format!(
        "Nostr {}",
        STANDARD
            .encode(serde_json::to_vec(&proof).map_err(|_| "Could not encode relay badge proof")?)
    );
    // Identity access and signing can take a while; the session may have been
    // refused meanwhile, and then it is not sent. Admission creates the
    // request; it goes out once awaited, after the lock is released.
    let sending = enterprise
        .admit(session, || {
            authorize(http.post(endpoint.clone()), session, &proof)
                .header("Content-Type", "application/json")
                .body(body)
                .send()
        })
        .ok_or(SESSION_REPLACED)?;
    let response = sending.await.map_err(|_| "Relay badge request failed")?;
    let status = response.status().as_u16();
    // An oversized body carries no usable code, so the status alone decides.
    let bytes = read_bounded(response).await?.unwrap_or_default();
    if status != 200 {
        let code = serde_json::from_slice::<Denial>(&bytes)
            .map(|denial| denial.error)
            .unwrap_or_default();
        if let Some(denial) = denial(status, &code) {
            return Err(denial.into());
        }
        let code: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(64)
            .collect();
        // Only overload is worth retrying; network failures retry too.
        return Err(if matches!(status, 429 | 503) {
            format!("Relay badge is unavailable ({status} {code})")
        } else {
            format!("{REFUSED} ({status} {code})")
        });
    }
    // The adapter issued the badge no later than its response arrived, so
    // freshness and the lifetime cap are measured from arrival, not from
    // `now` (when the request was signed).
    let received = self::now()?;
    let invalid = || format!("{REFUSED} (invalid adapter response)");
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

/// The body, or `None` when it exceeds `MAX_RESPONSE`. An interrupted read is
/// a network failure and stays retryable.
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
