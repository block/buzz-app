use super::*;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
struct FakeStore {
    key: StdMutex<Option<String>>,
    reads: StdMutex<usize>,
    /// Reads fail, as a locked or refused Keychain does.
    unreadable: StdMutex<bool>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        *self.reads.lock().unwrap() += 1;
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self.key.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn replace(&self, key: &str) -> Result<(), String> {
        *self.key.lock().unwrap() = Some(key.into());
        Ok(())
    }
}

fn host(store: &Arc<FakeStore>) -> ClaudeKey {
    ClaudeKey::with(Box::new(store.clone()))
}

#[tokio::test]
async fn a_saved_key_takes_effect_without_reading_the_store_again() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    assert!(!key.configured().await.unwrap());
    key.set("  sk-ant-api03-new_KEY  ").await.unwrap();
    assert!(key.configured().await.unwrap());
    assert_eq!(
        key.key().await.unwrap().as_deref().map(String::as_str),
        Some("sk-ant-api03-new_KEY")
    );
    assert_eq!(
        store.key.lock().unwrap().as_deref(),
        Some("sk-ant-api03-new_KEY")
    );
    assert_eq!(*store.reads.lock().unwrap(), 1);
}

#[tokio::test]
async fn refuses_what_is_not_an_anthropic_key() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    let long = format!("sk-ant-{}", "x".repeat(512));
    for bad in [
        "",
        "sk-ant-",
        "sk-proj-abc",
        "tk_abc",
        "sk-ant-a b",
        "sk-ant-a\nb",
        "sk-ant-a\u{e9}b",
        "sk-ant-a=b",
        long.as_str(),
    ] {
        assert_eq!(key.set(bad).await, Err(NOT_A_KEY.into()), "{bad:?}");
    }
    assert!(store.key.lock().unwrap().is_none());
}

#[tokio::test]
async fn an_unreadable_store_is_an_error_and_is_read_again() {
    let store = Arc::new(FakeStore::default());
    *store.key.lock().unwrap() = Some("sk-ant-k".into());
    *store.unreadable.lock().unwrap() = true;
    let key = host(&store);
    // Not "missing", so the app does not report that no key is saved.
    assert!(key.configured().await.is_err());
    *store.unreadable.lock().unwrap() = false;
    assert!(key.configured().await.unwrap());
    assert_eq!(*store.reads.lock().unwrap(), 2);
}

#[test]
fn only_buzz_claude_processes_may_have_the_key() {
    for process in [
        "claude-sh",
        "claude-protected-arm64",
        "claude-protected-x64",
    ] {
        assert!(may_have("buzz.claude-code", process), "{process}");
        assert!(!may_have("buzz.codex", process), "{process}");
    }
    for process in ["claude", "read", "platform", "workspace"] {
        assert!(!may_have("buzz.claude-code", process), "{process}");
    }
}
