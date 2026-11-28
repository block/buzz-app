use super::*;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
struct FakeStore {
    keys: StdMutex<HashMap<String, String>>,
    reads: StdMutex<usize>,
    /// Reads fail, as a locked or refused Keychain does.
    unreadable: StdMutex<bool>,
    /// Writes to this account fail.
    refuse: StdMutex<Option<String>>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        *self.reads.lock().unwrap() += 1;
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self
            .keys
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Zeroizing::new))
    }
    fn replace(&self, account: &str, key: &str) -> Result<(), String> {
        if self.refuse.lock().unwrap().as_deref() == Some(account) {
            return Err("refused".into());
        }
        self.keys.lock().unwrap().insert(account.into(), key.into());
        Ok(())
    }
    fn clear(&self, account: &str) -> Result<(), String> {
        self.keys.lock().unwrap().remove(account);
        Ok(())
    }
}

const ONE: &str = "wss://one.example";
const TWO: &str = "wss://two.example";

fn host(store: &Arc<FakeStore>) -> JevHost {
    JevHost::with(Box::new(store.clone()))
}
fn saved(store: &Arc<FakeStore>, account: &str) -> Option<String> {
    store.keys.lock().unwrap().get(account).cloned()
}
/// A store holding the one key saved before keys were per community.
fn legacy(key: &str) -> Arc<FakeStore> {
    let store = Arc::new(FakeStore::default());
    store
        .keys
        .lock()
        .unwrap()
        .insert(KEY_ACCOUNT.into(), key.into());
    store
}

#[test]
fn every_spelling_of_a_relay_shares_one_account() {
    assert_eq!(account(ONE).as_deref(), Some("typesafe:one.example"));
    for spelling in [
        "https://ONE.example/",
        "wss://one.example.",
        "wss://one.example:443",
    ] {
        assert_eq!(account(spelling), account(ONE), "{spelling}");
    }
    assert_ne!(account("wss://one.example:7777"), account(ONE));
    for bad in ["", "one.example", "file:///tmp/relay"] {
        assert_eq!(account(bad), None, "{bad}");
    }
}

#[tokio::test]
async fn set_and_clear_take_effect_without_reading_the_keychain_again() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store);
    assert!(!host.configured(ONE).await.unwrap());
    host.set(ONE, "  tk_new  ").await.unwrap();
    assert!(host.configured(ONE).await.unwrap());
    assert_eq!(
        saved(&store, "typesafe:one.example").as_deref(),
        Some("tk_new")
    );
    host.clear(ONE).await.unwrap();
    assert!(!host.configured(ONE).await.unwrap());
    assert_eq!(*store.reads.lock().unwrap(), 1);
}

#[tokio::test]
async fn each_community_has_its_own_key() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store);
    host.set(ONE, "tk_one").await.unwrap();
    host.set(TWO, "tk_two").await.unwrap();
    assert_eq!(
        host.key(ONE).await.unwrap().as_deref().map(String::as_str),
        Some("tk_one")
    );
    assert_eq!(
        host.key(TWO).await.unwrap().as_deref().map(String::as_str),
        Some("tk_two")
    );
    // Removing one community's key leaves the other's.
    host.clear(ONE).await.unwrap();
    assert!(!host.configured(ONE).await.unwrap());
    assert!(host.configured(TWO).await.unwrap());
    assert_eq!(
        saved(&store, "typesafe:two.example").as_deref(),
        Some("tk_two")
    );
}

#[tokio::test]
async fn refuses_a_key_that_is_not_one_printable_token_or_not_for_a_community() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store);
    for bad in ["", "a b", "a\nb", "a\u{e9}b", &"x".repeat(513)] {
        assert!(host.set(ONE, bad).await.is_err(), "{bad:?}");
    }
    for community in ["", "one.example"] {
        assert!(host.set(community, "tk").await.is_err(), "{community:?}");
        assert!(host.configured(community).await.is_err(), "{community:?}");
    }
    assert!(store.keys.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unreadable_keychain_is_an_error_and_is_read_again() {
    let store = Arc::new(FakeStore::default());
    store
        .keys
        .lock()
        .unwrap()
        .insert("typesafe:one.example".into(), "k".into());
    *store.unreadable.lock().unwrap() = true;
    let host = host(&store);
    // Not "missing", so the app does not report that no key is saved.
    assert!(host.configured(ONE).await.is_err());
    *store.unreadable.lock().unwrap() = false;
    assert!(host.configured(ONE).await.unwrap());
    assert_eq!(*store.reads.lock().unwrap(), 2);
}

#[tokio::test]
async fn adopting_gives_the_old_key_to_each_community_without_one_then_deletes_it() {
    let store = legacy("tk_old");
    store
        .keys
        .lock()
        .unwrap()
        .insert("typesafe:two.example".into(), "tk_two".into());
    let host = host(&store);
    // Read before adopting: the cached answer must not outlive it.
    assert!(!host.configured(ONE).await.unwrap());
    host.adopt(&[ONE.into(), TWO.into()]).await.unwrap();
    assert_eq!(
        saved(&store, "typesafe:one.example").as_deref(),
        Some("tk_old")
    );
    assert_eq!(
        saved(&store, "typesafe:two.example").as_deref(),
        Some("tk_two")
    );
    assert_eq!(saved(&store, KEY_ACCOUNT), None);
    assert!(host.configured(ONE).await.unwrap());
    // A community joined later has no key, and adopting again does nothing.
    host.adopt(&["wss://three.example".into()]).await.unwrap();
    assert_eq!(saved(&store, "typesafe:three.example"), None);
}

#[tokio::test]
async fn adopting_keeps_the_old_key_until_every_copy_is_saved() {
    let store = legacy("tk_old");
    *store.refuse.lock().unwrap() = Some("typesafe:two.example".into());
    let host = host(&store);
    assert!(host.adopt(&[ONE.into(), TWO.into()]).await.is_err());
    assert_eq!(saved(&store, KEY_ACCOUNT).as_deref(), Some("tk_old"));
    *store.refuse.lock().unwrap() = None;
    host.adopt(&[ONE.into(), TWO.into()]).await.unwrap();
    assert_eq!(
        saved(&store, "typesafe:two.example").as_deref(),
        Some("tk_old")
    );
    assert_eq!(saved(&store, KEY_ACCOUNT), None);
}

#[tokio::test]
async fn a_key_removed_after_a_failed_adoption_stays_removed() {
    let store = legacy("tk_old");
    *store.refuse.lock().unwrap() = Some("typesafe:two.example".into());
    let host = host(&store);
    assert!(host.adopt(&[ONE.into(), TWO.into()]).await.is_err());
    // One got its copy; Two's is still waiting, which is not a missing key.
    assert!(host.configured(ONE).await.unwrap());
    assert!(host.configured(TWO).await.is_err());
    // Removing One's key can't finish the adoption yet, so nothing changes.
    assert!(host.clear(ONE).await.is_err());
    assert_eq!(
        saved(&store, "typesafe:one.example").as_deref(),
        Some("tk_old")
    );
    assert_eq!(saved(&store, KEY_ACCOUNT).as_deref(), Some("tk_old"));
    // Once it can, Two gets the old key, which is then deleted with One's.
    *store.refuse.lock().unwrap() = None;
    host.clear(ONE).await.unwrap();
    assert_eq!(saved(&store, "typesafe:one.example"), None);
    assert_eq!(
        saved(&store, "typesafe:two.example").as_deref(),
        Some("tk_old")
    );
    assert_eq!(saved(&store, KEY_ACCOUNT), None);
    assert!(!host.configured(ONE).await.unwrap());
    assert!(host.configured(TWO).await.unwrap());
    // A later adoption, as at the next launch, has nothing to bring back.
    host.adopt(&[ONE.into(), TWO.into()]).await.unwrap();
    assert_eq!(saved(&store, "typesafe:one.example"), None);
}

#[tokio::test]
async fn adopting_with_no_community_keeps_the_old_key() {
    let store = legacy("tk_old");
    let host = host(&store);
    host.adopt(&[]).await.unwrap();
    host.adopt(&["not a relay".into()]).await.unwrap();
    assert_eq!(saved(&store, KEY_ACCOUNT).as_deref(), Some("tk_old"));
    assert_eq!(*store.reads.lock().unwrap(), 0);
}

#[test]
fn clearing_deletes_the_previous_item_first_and_stops_at_a_failure() {
    let mut deleted = Vec::new();
    clear_with(|service| {
        deleted.push(service.to_owned());
        Ok::<_, ()>(())
    })
    .unwrap();
    assert_eq!(deleted, [PREVIOUS_KEY_SERVICE, KEY_SERVICE]);
    deleted.clear();
    assert!(clear_with(|service| {
        deleted.push(service.to_owned());
        Err(())
    })
    .is_err());
    assert_eq!(deleted, [PREVIOUS_KEY_SERVICE]);
}
