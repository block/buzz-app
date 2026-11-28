//! The saved TypeSafe keys, one per community, which the `typesafe` decision
//! backend sends with that community's requests (see `decisions.rs`). Native
//! code owns the keys: each is kept in the OS credential
//! store under Buzz's own item, apart from Janet's, and it is never sent back
//! to the webview or given to an agent process. On macOS the item is created
//! by the Buzz binary, so only that binary reads it without a prompt; an
//! agent's shell cannot.
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
pub(crate) const KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.jev-key.debug"
} else {
    "xyz.block.buzz.desktop.jev-key"
};
/// The service before 1.0. Reads copy a key found only there; clearing removes it too.
#[cfg_attr(test, allow(dead_code))]
const PREVIOUS_KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "dev.local.buzz.foundation.jev-key.debug"
} else {
    "dev.local.buzz.foundation.jev-key"
};
/// The one key saved before keys were per community. Only `adopt` reads it,
/// to give it to the communities joined then.
pub(crate) const KEY_ACCOUNT: &str = "typesafe";
pub(crate) const MODEL: &str = "jev-1.13.0";
const KEY_LIMIT: usize = 512;

/// The account of `community`'s key: `typesafe:` and the community's host as
/// Builderlab names it, so every spelling of one relay shares one key.
/// `None` when `community` is not a relay URL.
pub(crate) fn account(community: &str) -> Option<String> {
    crate::decisions::community_host(community).map(|host| format!("{KEY_ACCOUNT}:{host}"))
}

/// Where the keys live, each under its account.
pub(crate) trait KeyStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn replace(&self, account: &str, key: &str) -> Result<(), String>;
    fn clear(&self, account: &str) -> Result<(), String>;
}

pub(crate) struct JevHost {
    store: Arc<dyn KeyStore>,
    /// Each account's key once read: the Keychain is asked once per
    /// community, then kept current by set and clear. A failed read is not
    /// kept, and a key the service refuses is read again, so one removed
    /// outside the app is seen on the next call.
    keys: Mutex<HashMap<String, Option<Zeroizing<String>>>>,
    /// The accounts of an `adopt` that failed, while the old key may still
    /// be waiting to reach them. Empty once one succeeds.
    adopting: Mutex<BTreeSet<String>>,
}

fn account_of(community: &str) -> Result<String, String> {
    account(community).ok_or_else(|| "That is not a community".to_string())
}

impl JevHost {
    pub(crate) fn new() -> Self {
        Self::with(Box::new(OsKeyStore))
    }
    pub(crate) fn with(store: Box<dyn KeyStore>) -> Self {
        Self {
            store: Arc::from(store),
            keys: Mutex::new(HashMap::new()),
            adopting: Mutex::new(BTreeSet::new()),
        }
    }
    /// Runs `work` on the store off the async runtime. The store can block
    /// on a consent dialog; a caller's deadline still applies while it waits.
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn KeyStore) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || work(store.as_ref()))
            .await
            .map_err(|_| "The Keychain is unavailable".to_string())?
    }
    /// `community`'s saved key, or `None` when it has none. A Keychain that
    /// cannot be read is an error, not a missing key, and so is a key the
    /// old one has yet to reach after a failed `adopt`.
    pub(crate) async fn key(&self, community: &str) -> Result<Option<Zeroizing<String>>, String> {
        let account = account_of(community)?;
        let mut keys = self.keys.lock().await;
        if let Some(key) = keys.get(&account) {
            return Ok(key.clone());
        }
        let read = {
            let account = account.clone();
            self.run(move |store| store.read(&account)).await?
        };
        if read.is_none() && self.adopting.lock().await.contains(&account) {
            return Err("The saved TypeSafe key could not be given to this community".into());
        }
        keys.insert(account, read.clone());
        Ok(read)
    }
    pub(crate) async fn forget(&self, community: &str) {
        if let Some(account) = account(community) {
            self.keys.lock().await.remove(&account);
        }
    }
    pub(crate) async fn configured(&self, community: &str) -> Result<bool, String> {
        Ok(self.key(community).await?.is_some())
    }
    pub(crate) async fn set(&self, community: &str, value: &str) -> Result<(), String> {
        let account = account_of(community)?;
        let value = value.trim();
        if value.is_empty()
            || value.len() > KEY_LIMIT
            || !value.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("That does not look like a TypeSafe API key".into());
        }
        let mut keys = self.keys.lock().await;
        let saved = Zeroizing::new(value.to_owned());
        {
            let (account, write) = (account.clone(), saved.clone());
            self.run(move |store| store.replace(&account, &write))
                .await?;
        }
        keys.insert(account, Some(saved));
        Ok(())
    }
    /// Removes `community`'s key. After a failed `adopt`, it first gives the
    /// old key to the other communities still waiting for it and deletes it,
    /// so a later `adopt` cannot bring the removed key back; if that fails,
    /// nothing is removed.
    pub(crate) async fn clear(&self, community: &str) -> Result<(), String> {
        let account = account_of(community)?;
        let mut keys = self.keys.lock().await;
        let mut adopting = self.adopting.lock().await;
        let others: BTreeSet<String> = adopting
            .iter()
            .filter(|other| **other != account)
            .cloned()
            .collect();
        let finishing = !adopting.is_empty();
        let cleared = {
            let account = account.clone();
            let others = others.clone();
            self.run(move |store| {
                if finishing {
                    give_old_key(store, &others)?;
                }
                store.clear(&account)
            })
            .await
        };
        if finishing {
            // Some copies may be saved even when a later step failed.
            for other in &others {
                keys.remove(other);
            }
        }
        cleared?;
        adopting.clear();
        keys.insert(account, None);
        Ok(())
    }
    /// Gives the key saved before keys were per community to each of
    /// `communities` that has no key of its own, then deletes it, so each
    /// community's key is then its own. Without such a key it does nothing.
    /// The old key is deleted only once every copy is saved; until then a
    /// later call tries again.
    pub(crate) async fn adopt(&self, communities: &[String]) -> Result<(), String> {
        let accounts: BTreeSet<String> = communities.iter().filter_map(|c| account(c)).collect();
        if accounts.is_empty() {
            return Ok(());
        }
        let mut keys = self.keys.lock().await;
        let mut adopting = self.adopting.lock().await;
        let copied = {
            let accounts = accounts.clone();
            self.run(move |store| give_old_key(store, &accounts)).await
        };
        // Some copies may be saved even when a later step failed: read them
        // again.
        for account in &accounts {
            keys.remove(account);
        }
        *adopting = if copied.is_ok() {
            BTreeSet::new()
        } else {
            accounts
        };
        copied
    }
}

/// Gives the old key to each of `accounts` without a key of its own, then
/// deletes it. Without an old key it does nothing.
fn give_old_key(store: &dyn KeyStore, accounts: &BTreeSet<String>) -> Result<(), String> {
    let Some(key) = store.read(KEY_ACCOUNT)? else {
        return Ok(());
    };
    for account in accounts {
        if store.read(account)?.is_none() {
            store.replace(account, &key)?;
        }
    }
    store.clear(KEY_ACCOUNT)
}

/// The OS credential store: the login Keychain on macOS, the Secret Service on
/// Linux and the Credential Manager on Windows.
struct OsKeyStore;

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
fn decode(bytes: Zeroizing<Vec<u8>>) -> Result<Option<Zeroizing<String>>, String> {
    let text = std::str::from_utf8(&bytes).map_err(|_| "The saved key is damaged".to_string())?;
    let key = text.trim();
    Ok((!key.is_empty()).then(|| Zeroizing::new(key.to_owned())))
}

/// Delete the key under both services, the previous one first, stopping at a
/// failure: reads copy it while the current one is absent, so deleting the
/// current one first could let a read bring the key back.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn clear_with<E>(delete: impl FnMut(&str) -> Result<(), E>) -> Result<(), E> {
    [PREVIOUS_KEY_SERVICE, KEY_SERVICE]
        .into_iter()
        .try_for_each(delete)
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
mod platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    fn error(error: Error) -> String {
        match error {
            Error::Denied if cfg!(target_os = "macos") => {
                "Keychain access was denied. Allow access and retry"
            }
            Error::Denied => "Secure storage access was denied. Allow access and retry",
            Error::Busy => "Another Buzz app is using secure storage. Retry shortly",
            Error::Corrupt | Error::Ambiguous => "The saved key is damaged",
            _ if cfg!(target_os = "macos") => "The Keychain is unavailable",
            _ => "Secure storage is unavailable. Unlock it and retry",
        }
        .into()
    }
    impl KeyStore for OsKeyStore {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
            let find = |service| match credentials::read(service, account) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(Error::Absent) => Ok(None),
                Err(e) => Err(e),
            };
            // Only the old device-wide key may still be under the service
            // before 1.0.
            if account != KEY_ACCOUNT {
                return find(KEY_SERVICE).map_err(error)?.map_or(Ok(None), decode);
            }
            credentials::read_or_copy(
                || find(KEY_SERVICE),
                || credentials::copy(PREVIOUS_KEY_SERVICE, KEY_SERVICE, KEY_ACCOUNT),
            )
            .map_err(error)?
            .map_or(Ok(None), decode)
        }
        fn replace(&self, account: &str, key: &str) -> Result<(), String> {
            credentials::replace(KEY_SERVICE, account, key.as_bytes()).map_err(error)
        }
        fn clear(&self, account: &str) -> Result<(), String> {
            let delete = |service: &str| match credentials::delete(service, account) {
                Ok(()) | Err(Error::Absent) => Ok(()),
                Err(e) => Err(error(e)),
            };
            if account != KEY_ACCOUNT {
                return delete(KEY_SERVICE);
            }
            clear_with(delete)
        }
    }
}

// Native tests never touch an OS credential store.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl KeyStore for OsKeyStore {
    fn read(&self, _account: &str) -> Result<Option<Zeroizing<String>>, String> {
        Err("Secure storage is not available here".into())
    }
    fn replace(&self, _account: &str, _key: &str) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
    fn clear(&self, _account: &str) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
}

#[tauri::command]
pub(crate) async fn jev_classifier_status(
    host: tauri::State<'_, JevHost>,
    community: String,
) -> Result<bool, String> {
    host.configured(&community).await
}

#[tauri::command]
pub(crate) async fn jev_classifier_set_key(
    host: tauri::State<'_, JevHost>,
    community: String,
    key: String,
) -> Result<(), String> {
    let key = Zeroizing::new(key);
    host.set(&community, &key).await
}

#[tauri::command]
pub(crate) async fn jev_classifier_clear_key(
    host: tauri::State<'_, JevHost>,
    community: String,
) -> Result<(), String> {
    host.clear(&community).await
}

#[tauri::command]
pub(crate) async fn jev_classifier_adopt(
    host: tauri::State<'_, JevHost>,
    communities: Vec<String>,
) -> Result<(), String> {
    host.adopt(&communities).await
}

#[cfg(test)]
#[path = "jev_tests.rs"]
mod tests;
