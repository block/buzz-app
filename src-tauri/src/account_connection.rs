//! Explicit existing-account connection. No startup credential reads, durable keys
//! or implicit membership. A revocable lease binds native custody to one origin.
pub(crate) mod archive;
pub(crate) mod history;
pub(crate) mod session;
pub(crate) mod socket;
use nostr::{FromBech32, Keys, PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const CANCELLED: &str = "Account check cancelled or expired";
const CREDENTIAL: &str = "Could not verify the selected existing Buzz account. Check the public key and Keychain access.";
const DISCOVERY: &str = "Could not discover this relay. Check its address and try again.";
const MAX_BYTES: usize = 2 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    expected_public_key: String,
    relay_url: String,
}
#[derive(Clone)]
struct Destination {
    viewer: String,
    origin: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedAccount {
    viewer: String,
    origin: String,
    relay_author: String,
    archive_authority: Option<String>,
    lease: String,
}
struct Pending {
    id: String,
    destination: Destination,
    created: Instant,
    running: bool,
}
#[derive(Default)]
struct State {
    pending: Option<Pending>,
    session: Option<Arc<session::Session>>,
    closed: bool,
}
trait Credentials: Send + Sync {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>>;
}
struct InstalledAccount;
impl Credentials for InstalledAccount {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        // Test builds never compile a live credential-store call.
        #[cfg(all(target_os = "macos", not(test)))]
        {
            use security_framework::os::macos::passwords::find_generic_password;
            let (value, _) =
                find_generic_password(None, "buzz-desktop", "secrets").map_err(|_| CREDENTIAL)?;
            Ok(Zeroizing::new(value.to_vec()))
        }
        #[cfg(any(not(target_os = "macos"), test))]
        {
            Err(CREDENTIAL.into())
        }
    }
}
#[derive(Clone)]
pub(crate) struct AccountConnection {
    state: Arc<Mutex<State>>,
    credentials: Arc<dyn Credentials>,
    reading: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    archive: Option<Arc<archive::Archive>>,
}
impl Default for AccountConnection {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            credentials: Arc::new(InstalledAccount),
            reading: Arc::new(AtomicBool::new(false)),
            busy: Arc::new(AtomicBool::new(false)),
            archive: None,
        }
    }
}
impl AccountConnection {
    pub(crate) fn with_archive(root: std::path::PathBuf) -> Self {
        let archive = Arc::new(archive::Archive::new(root));
        let maintenance = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = maintenance.maintain();
        });
        Self {
            archive: Some(archive),
            ..Self::default()
        }
    }
    fn begin(&self, caller: &str, request: Request) -> Result<String> {
        caller_allowed(caller)?;
        let destination = validate(request)?; // Before any OS or network work.
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if state.closed {
            return Err(CANCELLED.into());
        }
        if state.session.is_some() {
            return Err("Disconnect the current native account before replacing it".into());
        }
        if self.busy.load(Ordering::SeqCst)
            || self.reading.load(Ordering::SeqCst)
            || state
                .pending
                .as_ref()
                .is_some_and(|p| p.running || p.created.elapsed() < Duration::from_secs(15))
        {
            return Err("Another account check is still in progress".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        state.pending = Some(Pending {
            id: id.clone(),
            destination,
            created: Instant::now(),
            running: false,
        });
        Ok(id)
    }
    fn start(&self, caller: &str, id: &str) -> Result<Destination> {
        caller_allowed(caller)?;
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if state.closed {
            return Err(CANCELLED.into());
        }
        let pending = state
            .pending
            .as_mut()
            .filter(|p| p.id == id && !p.running && p.created.elapsed() < Duration::from_secs(15))
            .ok_or(CANCELLED)?;
        pending.running = true;
        Ok(pending.destination.clone())
    }
    fn active(&self, id: &str) -> Result<()> {
        let state = self.state.lock().map_err(|_| CANCELLED)?;
        if state.closed
            || !state
                .pending
                .as_ref()
                .is_some_and(|p| p.id == id && p.running)
        {
            return Err(CANCELLED.into());
        }
        Ok(())
    }
    fn cancel(&self, caller: &str, id: &str) -> Result<()> {
        caller_allowed(caller)?;
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if state.pending.as_ref().is_some_and(|p| p.id == id) {
            state.pending = None;
        }
        Ok(())
    }
    pub(crate) fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.pending = None;
            if let Some(session) = state.session.take() {
                session.close();
            }
        }
    }
    pub(crate) fn revoke(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.pending = None;
            if let Some(session) = state.session.take() {
                session.close();
            }
        }
    }
    async fn verify(&self, id: &str, destination: &Destination) -> Result<Keys> {
        self.active(id)?;
        if self.reading.swap(true, Ordering::SeqCst) {
            return Err("Another account check is still in progress".into());
        }
        let reading = self.reading.clone();
        let owner = self.clone();
        let id = id.to_owned();
        let expected = destination.viewer.clone();
        // OS credential prompts cannot reliably be cancelled. Hold admission until
        // actual completion, and fence results even if the async waiter times out.
        tauri::async_runtime::spawn_blocking(move || {
            struct Reading(Arc<AtomicBool>);
            impl Drop for Reading {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let _reading = Reading(reading);
            owner.active(&id)?;
            let bytes = owner.credentials.read()?;
            owner.active(&id)?;
            let keys = verify_identity(&bytes, &expected)?;
            owner.active(&id)?;
            Ok(keys)
        })
        .await
        .map_err(|_| CREDENTIAL)?
    }
    async fn run(&self, caller: &str, id: String) -> Result<VerifiedAccount> {
        self.run_with(caller, id, |origin| async move { discover(&origin).await })
            .await
    }
    async fn run_with<F: std::future::Future<Output = Result<(String, Option<String>)>>>(
        &self,
        caller: &str,
        id: String,
        discovery: impl FnOnce(String) -> F,
    ) -> Result<VerifiedAccount> {
        let destination = self.start(caller, &id)?;
        if self.busy.swap(true, Ordering::SeqCst) {
            self.cancel(caller, &id)?;
            return Err("Another account check is still in progress".into());
        }
        struct Busy(Arc<AtomicBool>);
        impl Drop for Busy {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _busy = Busy(self.busy.clone());
        let result = tokio::time::timeout(Duration::from_secs(120), async {
            let keys = self.verify(&id, &destination).await?;
            self.active(&id)?;
            let (relay_author, archive_authority) = discovery(destination.origin.clone()).await?;
            self.active(&id)?;
            Ok((keys, relay_author, archive_authority))
        })
        .await
        .map_err(|_| {
            "Account check timed out; close any remaining Keychain prompt before retrying"
                .to_owned()
        })
        .and_then(|r| r);
        // Single-use ticket. Cancellation/replacement wins over a successful read.
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        let current = !state.closed
            && state
                .pending
                .as_ref()
                .is_some_and(|p| p.id == id && p.running);
        if !current {
            return Err(CANCELLED.into());
        }
        state.pending = None;
        let (keys, relay_author, archive_authority) = result?;
        let session = Arc::new(session::Session::with_history(
            destination.origin.clone(),
            keys,
            relay_author.clone(),
            self.archive.clone(),
        ));
        let lease = session.id.clone();
        state.session = Some(session);
        Ok(VerifiedAccount {
            viewer: destination.viewer,
            origin: destination.origin,
            relay_author,
            archive_authority,
            lease,
        })
    }
}
fn caller_allowed(caller: &str) -> Result<()> {
    if caller == "main" {
        Ok(())
    } else {
        Err("Account access is unavailable in this view".into())
    }
}
fn validate(request: Request) -> Result<Destination> {
    let pin = request.expected_public_key.trim();
    let key = if pin.len() == 64 && pin.bytes().all(|c| c.is_ascii_hexdigit()) {
        PublicKey::from_hex(pin).map_err(|_| ())
    } else if pin.starts_with("npub1") && pin.len() == 63 {
        PublicKey::from_bech32(pin).map_err(|_| ())
    } else {
        return Err(
            "Enter the existing account's public key (npub or hex), never a secret key".into(),
        );
    }
    .map_err(|_| "Enter a valid public key (npub or hex)")?;
    let origin = relay_origin(&request.relay_url)?;
    Ok(Destination {
        viewer: key.to_hex(),
        origin,
    })
}
// Same contract as features/communities/destination.ts; tests share its cases.
fn relay_origin(input: &str) -> Result<String> {
    let bad = || {
        "Enter a wss:// or https:// relay origin without credentials, path, query or fragment"
            .to_owned()
    };
    let raw = input.trim();
    let (scheme, authority) = raw.split_once("://").ok_or_else(bad)?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if raw.len() > 2048
        || !(scheme.eq_ignore_ascii_case("wss") || scheme.eq_ignore_ascii_case("https"))
        || authority.is_empty()
        || authority
            .chars()
            .any(|c| c.is_whitespace() || "/?#\\@".contains(c))
    {
        return Err(bad());
    }
    let mut url = url::Url::parse(&format!("https://{authority}")).map_err(|_| bad())?;
    let host = url.host_str().ok_or_else(bad)?.to_owned();
    if host.ends_with('.') {
        url.set_host(Some(host.strip_suffix('.').unwrap_or(&host)))
            .map_err(|_| bad())?;
    }
    Ok(url.origin().ascii_serialization())
}
fn verify_identity(bytes: &[u8], expected: &str) -> Result<Keys> {
    if bytes.len() > MAX_BYTES {
        return Err(CREDENTIAL.into());
    }
    // Zeroizing strings also dispose unrelated agent values in the fixed legacy
    // blob. Duplicate keys are refused rather than picking a different identity.
    struct Blob(std::collections::BTreeMap<String, Zeroizing<String>>);
    impl<'de> Deserialize<'de> for Blob {
        fn deserialize<D: serde::Deserializer<'de>>(
            deserializer: D,
        ) -> std::result::Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Blob;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("credential map")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut access: A,
                ) -> std::result::Result<Blob, A::Error> {
                    let mut values = std::collections::BTreeMap::new();
                    while let Some((key, value)) = access.next_entry::<String, String>()? {
                        let value = Zeroizing::new(value);
                        if values.insert(key, value).is_some() {
                            return Err(serde::de::Error::custom("Duplicate credential"));
                        }
                    }
                    Ok(Blob(values))
                }
            }
            deserializer.deserialize_map(Visitor)
        }
    }
    let blob: Blob = serde_json::from_slice(bytes).map_err(|_| CREDENTIAL)?;
    let identity = blob.0.get("identity").ok_or(CREDENTIAL)?;
    let secret = SecretKey::from_bech32(identity.as_str()).map_err(|_| CREDENTIAL)?;
    let key = Keys::new(secret); // library owns keypair disposal; no zero-copy/zeroization guarantee.
    if key.public_key().to_hex() != expected {
        return Err(CREDENTIAL.into());
    }
    Ok(key)
}
fn discovery(bytes: &[u8]) -> Result<(String, Option<String>)> {
    if bytes.len() > MAX_BYTES {
        return Err(DISCOVERY.into());
    }
    #[derive(Deserialize)]
    struct Info {
        #[serde(rename = "self")]
        authority: Option<String>,
        pubkey: Option<String>,
    }
    let value: Info = serde_json::from_slice(bytes).map_err(|_| DISCOVERY)?;
    let valid = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    };
    let author = value
        .authority
        .as_ref()
        .or(value.pubkey.as_ref())
        .filter(|s| valid(s))
        .ok_or(DISCOVERY)?
        .clone();
    Ok((author, value.authority))
}
async fn discover(origin: &str) -> Result<(String, Option<String>)> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| DISCOVERY)?;
    let mut response = client
        .get(origin)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| DISCOVERY)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(DISCOVERY.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| DISCOVERY)? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(DISCOVERY.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    discovery(&bytes)
}
#[tauri::command]
pub(crate) fn account_connection_begin<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    request: Request,
) -> Result<String> {
    host.begin(webview.label(), request)
}
#[tauri::command]
pub(crate) async fn account_connection_run<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    ticket: String,
) -> Result<VerifiedAccount> {
    host.run(webview.label(), ticket).await
}
#[tauri::command]
pub(crate) fn account_connection_cancel<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    ticket: String,
) -> Result<()> {
    host.cancel(webview.label(), &ticket)
}

#[cfg(test)]
mod tests;
