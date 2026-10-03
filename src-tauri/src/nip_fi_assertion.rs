//! Relay badges (NIP-FI assertions) for trusted enterprise relays.
//!
//! The adapter issues a short-lived assertion for the person's own key, proved
//! with a NIP-98 event signed through `IdentityHost`. Relay HTTP reuses a badge
//! until shortly before expiry; each WebSocket connection asks for a fresh one
//! so a revoked person is caught at the next reconnect.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use crate::{
    enterprise_auth::EnterpriseAuthHost,
    enterprise_login_gate::configured_trusted_relays,
    enterprise_relay_url::canonical_enterprise_relay_url,
    identity::{EventTemplate, IdentityHost},
};

/// Shown to JavaScript, which returns the person to enterprise sign-in.
pub(crate) const SIGN_IN_REQUIRED: &str = "Enterprise sign-in is required";
/// Shown to JavaScript, which keeps the session and stops retrying the relay.
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
    /// gate owns whether sign-in is required). `fresh` skips the cache.
    pub(crate) async fn get(
        &self,
        identity: &IdentityHost,
        url: &Url,
        fresh: bool,
    ) -> Result<Option<Assertion>> {
        let Some(relay) = trusted_relay(url)? else {
            return Ok(None);
        };
        let Some((adapter, token)) = self.enterprise.saved_session(identity).await? else {
            return Ok(None);
        };
        let session: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let now = now()?;
        if !fresh {
            if let Some(cached) = self.lock().get(&relay).filter(|cached| {
                cached.session == session && cached.assertion.expires_at > now + REFRESH_MARGIN
            }) {
                return Ok(Some(cached.assertion.clone()));
            }
        }
        let endpoint = Url::parse(&format!(
            "{}{ASSERTION_PATH}",
            adapter.trim_end_matches('/')
        ))
        .map_err(|_| "Enterprise authentication adapter is invalid")?;
        let issued = issue(client()?, &endpoint, &token, identity, &relay, now).await;
        let assertion = match issued {
            Ok(assertion) => assertion,
            Err(error) => {
                if error == SIGN_IN_REQUIRED {
                    self.lock().remove(&relay);
                }
                return Err(error);
            }
        };
        self.lock().insert(
            relay,
            Cached {
                session,
                assertion: assertion.clone(),
            },
        );
        Ok(Some(assertion))
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
    session: &str,
    identity: &IdentityHost,
    relay: &str,
    now: u64,
) -> Result<Assertion> {
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
    let response = authorize(http.post(endpoint.clone()), session, &proof)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "Relay badge request failed")?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await?;
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
        return Err(format!("Relay badge was refused ({status} {code})"));
    }
    let issued: IssueResponse =
        serde_json::from_slice(&bytes).map_err(|_| "Relay badge response was invalid")?;
    if issued.nostr_pubkey != pubkey
        || issued.assertion.is_empty()
        || issued.assertion.len() > MAX_ASSERTION
        || !issued.assertion.bytes().all(|b| b.is_ascii_graphic())
        || issued.expires_at <= now
        || issued.expires_at > now + MAX_LIFETIME
    {
        return Err("Relay badge response was invalid".into());
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

#[cfg(test)]
mod tests;
