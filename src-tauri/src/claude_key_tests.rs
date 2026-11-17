use super::*;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
struct FakeStore {
    key: StdMutex<Option<String>>,
    reads: StdMutex<usize>,
    /// Reads fail, as a locked or refused Keychain does.
    unreadable: StdMutex<bool>,
    undeletable: StdMutex<bool>,
    unwritable: StdMutex<bool>,
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
        if *self.unwritable.lock().unwrap() {
            return Err("locked".into());
        }
        *self.key.lock().unwrap() = Some(key.into());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        if *self.undeletable.lock().unwrap() {
            return Err("locked".into());
        }
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}

fn host(store: &Arc<FakeStore>) -> ClaudeKey {
    ClaudeKey::with(Box::new(store.clone()))
}

fn kept(key: Result<Option<ApiKey>, String>) -> Option<String> {
    key.unwrap().map(|k| k.value.as_str().to_owned())
}

#[tokio::test]
async fn a_saved_key_takes_effect_without_reading_the_store_again() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    assert!(!key.configured().await.unwrap());
    key.set("  sk-ant-api03-new_KEY  ", None).await.unwrap();
    assert_eq!(
        kept(key.key().await).as_deref(),
        Some("sk-ant-api03-new_KEY")
    );
    assert_eq!(
        store.key.lock().unwrap().as_deref(),
        Some("sk-ant-api03-new_KEY")
    );
    assert_eq!(*store.reads.lock().unwrap(), 1);
}

#[tokio::test]
async fn no_key_is_not_kept_so_one_saved_elsewhere_is_used() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    assert_eq!(kept(key.key().await), None);
    // Another Buzz on this computer saves one.
    *store.key.lock().unwrap() = Some("sk-ant-elsewhere".into());
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-elsewhere"));
    // Kept from then on.
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-elsewhere"));
    assert_eq!(*store.reads.lock().unwrap(), 2);
}

#[tokio::test]
async fn a_check_rereads_a_key_replaced_or_removed_elsewhere() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    key.set("sk-ant-old", None).await.unwrap();
    *store.key.lock().unwrap() = Some("sk-ant-new".into());
    assert!(key.configured().await.unwrap());
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-new"));
    *store.key.lock().unwrap() = None;
    assert!(!key.configured().await.unwrap());
    assert_eq!(kept(key.key().await), None);
}

#[tokio::test]
async fn clearing_removes_the_stored_and_cached_key_and_is_repeatable() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    key.set("sk-ant-saved", None).await.unwrap();
    key.clear().await.unwrap();
    assert!(store.key.lock().unwrap().is_none());
    assert_eq!(kept(key.key().await), None);
    assert!(!host(&store).configured().await.unwrap());
    key.clear().await.unwrap();
    key.set("sk-ant-new", None).await.unwrap();
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-new"));
}

#[tokio::test]
async fn a_failed_delete_keeps_the_saved_key_until_retry_succeeds() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    key.set("sk-ant-saved", None).await.unwrap();
    *store.undeletable.lock().unwrap() = true;
    assert_eq!(key.clear().await, Err("locked".into()));
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-saved"));
    assert_eq!(store.key.lock().unwrap().as_deref(), Some("sk-ant-saved"));
    *store.undeletable.lock().unwrap() = false;
    key.clear().await.unwrap();
    assert_eq!(kept(key.key().await), None);
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
        assert_eq!(key.set(bad, None).await, Err(NOT_A_KEY.into()), "{bad:?}");
    }
    assert!(store.key.lock().unwrap().is_none());
}

const WORKSPACE: &str = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";

fn environment(key: &ApiKey) -> std::collections::HashMap<String, Option<String>> {
    let mut command = tokio::process::Command::new("claude");
    command.env("ANTHROPIC_API_KEY", "sk-ant-stale");
    command.env(
        "ANTHROPIC_CUSTOM_HEADERS",
        "X-Example: keep\nAnthropic-Workspace-Id: wrkspc_old",
    );
    key.apply(&mut command);
    command
        .as_std()
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

#[tokio::test]
async fn saves_and_reloads_the_workspace_with_the_key_and_sets_the_request_header() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    key.set("sk-ant-new", Some(&format!("  {WORKSPACE}  ")))
        .await
        .unwrap();
    let read = host(&store).key().await.unwrap().unwrap();
    let env = environment(&read);
    assert_eq!(env[ENV].as_deref(), Some("sk-ant-new"));
    assert_eq!(
        env["ANTHROPIC_CUSTOM_HEADERS"].as_deref(),
        Some(format!("X-Example: keep\nanthropic-workspace-id: {WORKSPACE}").as_str())
    );
    assert_eq!(read.workspace.as_deref(), Some(WORKSPACE));
    // The cached pair is replaced together, including when returning to a scoped key.
    key.set("sk-ant-scoped", Some("  ")).await.unwrap();
    assert!(key.key().await.unwrap().unwrap().workspace.is_none());
    assert!(host(&store)
        .key()
        .await
        .unwrap()
        .unwrap()
        .workspace
        .is_none());
    assert_eq!(store.key.lock().unwrap().as_deref(), Some("sk-ant-scoped"));
}

#[tokio::test]
async fn refuses_invalid_workspace_ids_without_replacing_the_key_or_workspace() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    key.set("sk-ant-old", Some(WORKSPACE)).await.unwrap();
    let stored = store.key.lock().unwrap().clone();
    let long = format!("wrkspc_{}", "x".repeat(128));
    for invalid in [
        "workspace",
        "wrkspc_",
        "wrkspc_a b",
        "wrkspc_é",
        "wrkspc_a\nX-Header: injected",
        long.as_str(),
    ] {
        assert_eq!(
            key.set("sk-ant-new", Some(invalid)).await,
            Err(NOT_A_WORKSPACE.into())
        );
        assert_eq!(*store.key.lock().unwrap(), stored);
        assert_eq!(
            key.key().await.unwrap().unwrap().workspace.as_deref(),
            Some(WORKSPACE)
        );
    }
    *store.unwritable.lock().unwrap() = true;
    assert!(key.set("sk-ant-new", None).await.is_err());
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-old"));
    assert_eq!(*store.key.lock().unwrap(), stored);
}

#[tokio::test]
async fn rejects_damaged_saved_credentials_without_discarding_the_cached_pair() {
    let store = Arc::new(FakeStore::default());
    let key = host(&store);
    key.set("sk-ant-old", Some(WORKSPACE)).await.unwrap();
    for damaged in [
        "{",
        r#"{"key":"sk-ant-new","workspace":"bad\nX-Header: injected"}"#,
    ] {
        *store.key.lock().unwrap() = Some(damaged.into());
        assert_eq!(
            key.configured().await,
            Err("The saved key is damaged".into())
        );
        assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-old"));
    }
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
    // A failed check keeps the key processes start with.
    *store.unreadable.lock().unwrap() = true;
    assert!(key.configured().await.is_err());
    assert_eq!(kept(key.key().await).as_deref(), Some("sk-ant-k"));
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
