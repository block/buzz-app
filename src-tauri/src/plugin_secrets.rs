//! Plugin-owned secrets in the OS credential store.
//!
//! Secret values never enter WebView JavaScript. A plugin saves a secret through
//! an app-owned entry window that runs no plugin code, and uses it by naming it
//! in a host request; the native client adds the header. A secret goes only to
//! origins declared by the plugin that saved it. Another plugin may use it only
//! after the user chooses Always Allow in a native dialog; Settings can revoke.
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};

use buzz_credential_store::Error;
use buzzodz_plugins::{Manager, SecretGrant};
use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::Manager as _;
use tokio::sync::{oneshot, Mutex};
use zeroize::Zeroizing;

use crate::{with_manager, PluginManager};

const MAX_SECRET_BYTES: usize = 16 * 1024;
const MAX_LABEL_CHARS: usize = 80;
pub(crate) const ENTRY_WINDOW: &str = "secret-entry";

type Result<T> = std::result::Result<T, String>;

pub(crate) trait SecretStore: Send + Sync {
    fn read(&self, account: &str) -> std::result::Result<Option<Zeroizing<String>>, Error>;
    fn write(&self, account: &str, value: &str) -> std::result::Result<(), Error>;
    fn delete(&self, account: &str) -> std::result::Result<(), Error>;
}

pub(crate) struct OsStore;

#[cfg(not(test))]
impl SecretStore for OsStore {
    fn read(&self, account: &str) -> std::result::Result<Option<Zeroizing<String>>, Error> {
        match buzz_credential_store::read_plugin_secret(account) {
            Ok(bytes) => std::str::from_utf8(&bytes)
                .map(|value| Some(Zeroizing::new(value.to_owned())))
                .map_err(|_| Error::Corrupt),
            Err(Error::Absent) => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn write(&self, account: &str, value: &str) -> std::result::Result<(), Error> {
        buzz_credential_store::write_plugin_secret(account, value)
    }
    fn delete(&self, account: &str) -> std::result::Result<(), Error> {
        buzz_credential_store::delete_plugin_secret(account)
    }
}

// Native tests cannot touch an OS credential store, even via the default host.
#[cfg(test)]
impl SecretStore for OsStore {
    fn read(&self, _: &str) -> std::result::Result<Option<Zeroizing<String>>, Error> {
        Err(Error::Unavailable)
    }
    fn write(&self, _: &str, _: &str) -> std::result::Result<(), Error> {
        Err(Error::Unavailable)
    }
    fn delete(&self, _: &str) -> std::result::Result<(), Error> {
        Err(Error::Unavailable)
    }
}

fn store_error(error: Error) -> String {
    match error {
        Error::Denied => "Keychain access was denied. Allow access and retry.",
        Error::Busy => "Another Buzz app is accessing secure storage. Retry shortly.",
        Error::Corrupt => "The saved secret is malformed. Save it again.",
        _ => "Secure storage is unavailable. Unlock your credential store and retry.",
    }
    .into()
}

fn valid_name(name: &str) -> Result<()> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        || !bytes.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
    {
        return Err(
            "Invalid secret name (use up to 64 lowercase letters, digits, dots, underscores or hyphens)"
                .into(),
        );
    }
    Ok(())
}

/// Plugin ids cannot contain `/`, so accounts of different plugins never collide.
fn account(plugin: &str, name: &str) -> Result<String> {
    buzzodz_plugins::valid_id(plugin)?;
    valid_name(name)?;
    Ok(format!("{plugin}/{name}"))
}

fn has_own(store: &dyn SecretStore, plugin: &str, name: &str) -> Result<bool> {
    Ok(store
        .read(&account(plugin, name)?)
        .map_err(store_error)?
        .is_some())
}

fn write_own(store: &dyn SecretStore, plugin: &str, name: &str, value: &str) -> Result<()> {
    let account = account(plugin, name)?;
    if value.trim().is_empty() || value.len() > MAX_SECRET_BYTES {
        return Err("Enter a value of up to 16 KiB".into());
    }
    store.write(&account, value).map_err(store_error)
}

fn delete_own(store: &dyn SecretStore, plugin: &str, name: &str) -> Result<()> {
    store.delete(&account(plugin, name)?).map_err(store_error)
}

fn plugin_name(manager: &Manager, id: &str) -> Result<String> {
    manager
        .catalog()?
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .map(|plugin| plugin.manifest.name)
        .ok_or_else(|| "Plugin is not installed".into())
}

// --- Using a secret in a host request -------------------------------------

/// A host request's reference to a saved secret. It carries no value.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SecretReference {
    /// The plugin that saved the secret; the requesting plugin when omitted.
    provider: Option<String>,
    name: String,
    header: String,
    #[serde(default)]
    prefix: String,
}

/// Checked facts about a reference before any secret is read.
#[derive(Debug)]
pub(crate) struct Plan {
    grant: SecretGrant,
    consumer_name: String,
    provider_name: String,
    header: HeaderName,
    prefix: String,
    needs_consent: bool,
}

/// Check the reference against the provider's declared origins and saved grants.
pub(crate) fn plan(
    manager: &Manager,
    consumer: &str,
    reference: &SecretReference,
    url: &reqwest::Url,
    reserved_header: impl Fn(&HeaderName) -> bool,
) -> Result<Plan> {
    let provider = reference.provider.as_deref().unwrap_or(consumer).to_owned();
    account(&provider, &reference.name)?;
    let header =
        HeaderName::from_bytes(reference.header.as_bytes()).map_err(|_| "Invalid secret header")?;
    if reserved_header(&header) {
        return Err("Secret header is not allowed".into());
    }
    if reference.prefix.len() > 64 {
        return Err("Secret header prefix is too long".into());
    }
    let catalog = manager.catalog()?.plugins;
    let info = catalog
        .iter()
        .find(|plugin| plugin.manifest.id == provider)
        .ok_or("Credential provider is not installed")?;
    let provider_grants = manager.host_grants(&provider, &info.revision)?;
    if !provider_grants
        .network_origins
        .contains(&url.origin().ascii_serialization())
    {
        return Err("This secret cannot be sent to that origin".into());
    }
    let grant = SecretGrant {
        consumer: consumer.into(),
        provider: provider.clone(),
        name: reference.name.clone(),
    };
    let needs_consent = provider != consumer && !manager.has_secret_grant(&grant)?;
    let consumer_name = catalog
        .iter()
        .find(|plugin| plugin.manifest.id == consumer)
        .map(|plugin| plugin.manifest.name.clone())
        .unwrap_or_else(|| consumer.into());
    Ok(Plan {
        grant,
        consumer_name,
        provider_name: info.manifest.name.clone(),
        header,
        prefix: reference.prefix.clone(),
        needs_consent,
    })
}

/// Serializes consent dialogs so concurrent requests never ask twice.
#[derive(Default)]
pub(crate) struct ConsentPrompts(Mutex<()>);

fn consent_message(plan: &Plan) -> String {
    format!(
        "“{}” wants to use the credential “{}” saved by “{}”.\n\nThe credential is sent only to sites that “{}” declares. You can revoke this in Settings → Plugins.",
        plan.consumer_name, plan.grant.name, plan.provider_name, plan.provider_name
    )
}

/// Ask for consent when needed, then read the secret and build its header.
pub(crate) async fn authorize<Ask, Asked>(
    store: Arc<dyn SecretStore>,
    prompts: &ConsentPrompts,
    manager: Manager,
    plan: Plan,
    ask: Ask,
) -> Result<(HeaderName, HeaderValue)>
where
    Ask: FnOnce(String) -> Asked,
    Asked: Future<Output = bool>,
{
    if plan.needs_consent {
        let _prompt = prompts.0.lock().await;
        let check = manager.clone();
        let grant = plan.grant.clone();
        let granted = tauri::async_runtime::spawn_blocking(move || check.has_secret_grant(&grant))
            .await
            .map_err(|e| e.to_string())??;
        if !granted {
            if !ask(consent_message(&plan)).await {
                return Err("Credential access was not allowed".into());
            }
            let grant = plan.grant.clone();
            tauri::async_runtime::spawn_blocking(move || manager.grant_secret(grant))
                .await
                .map_err(|e| e.to_string())??;
        }
    }
    let account = account(&plan.grant.provider, &plan.grant.name)?;
    let value = tauri::async_runtime::spawn_blocking(move || store.read(&account))
        .await
        .map_err(|e| e.to_string())?
        .map_err(store_error)?
        .ok_or("The credential is not saved")?;
    let header = Zeroizing::new(format!("{}{}", plan.prefix, value.as_str()));
    let mut value = HeaderValue::from_str(&header)
        .map_err(|_| "The saved credential is not a valid header value")?;
    value.set_sensitive(true);
    Ok((plan.header, value))
}

/// Native Always Allow / Don't Allow dialog. Plugin code cannot answer it.
pub(crate) async fn ask_native<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    message: String,
) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Allow access to a credential?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Always Allow".into(),
                "Don't Allow".into(),
            ))
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}

// --- Own secrets ------------------------------------------------------------

#[tauri::command]
pub(crate) async fn plugin_secret_has(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    name: String,
) -> Result<bool> {
    with_manager(manager, move |manager| {
        manager.host_grants(&id, &revision)?;
        has_own(&OsStore, &id, &name)
    })
    .await
}

#[tauri::command]
pub(crate) async fn plugin_secret_delete(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    name: String,
) -> Result<()> {
    with_manager(manager, move |manager| {
        manager.host_grants(&id, &revision)?;
        delete_own(&OsStore, &id, &name)
    })
    .await
}

// --- Entry window -----------------------------------------------------------

struct Pending {
    plugin: String,
    plugin_name: String,
    name: String,
    label: String,
    done: oneshot::Sender<bool>,
}

/// At most one entry window at a time.
#[derive(Default)]
pub(crate) struct SecretEntry(Arc<StdMutex<Option<Pending>>>);

impl SecretEntry {
    fn finish(&self, saved: bool) {
        if let Some(pending) = self.0.lock().unwrap().take() {
            let _ = pending.done.send(saved);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryPrompt {
    plugin_name: String,
    label: String,
}

/// Open the app-owned entry window and wait until the user saves or closes it.
#[tauri::command]
pub(crate) async fn plugin_secret_enter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    entry: tauri::State<'_, SecretEntry>,
    id: String,
    revision: String,
    name: String,
    label: String,
) -> Result<bool> {
    let label = label.trim().to_owned();
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err("A secret label must be 1 to 80 characters".into());
    }
    let (plugin, plugin_name, name) = with_manager(manager, move |manager| {
        manager.host_grants(&id, &revision)?;
        account(&id, &name)?;
        let display = plugin_name(&manager, &id)?;
        Ok((id, display, name))
    })
    .await?;
    let (done, saved) = oneshot::channel();
    {
        let mut slot = entry.0.lock().unwrap();
        if slot.is_some() || app.get_webview_window(ENTRY_WINDOW).is_some() {
            if let Some(window) = app.get_webview_window(ENTRY_WINDOW) {
                let _ = window.set_focus();
            }
            return Err("Another credential entry is already open".into());
        }
        *slot = Some(Pending {
            plugin,
            plugin_name,
            name,
            label,
            done,
        });
    }
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        ENTRY_WINDOW,
        tauri::WebviewUrl::App("secret-entry.html".into()),
    )
    .title("Save a credential")
    .inner_size(440.0, 280.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .center()
    .build();
    let window = match window {
        Ok(window) => window,
        Err(error) => {
            entry.finish(false);
            return Err(format!("Could not open credential entry: {error}"));
        }
    };
    let slot = entry.0.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(pending) = slot.lock().unwrap().take() {
                let _ = pending.done.send(false);
            }
        }
    });
    Ok(saved.await.unwrap_or(false))
}

#[tauri::command]
pub(crate) fn plugin_secret_entry_prompt(
    entry: tauri::State<'_, SecretEntry>,
) -> Result<EntryPrompt> {
    let slot = entry.0.lock().unwrap();
    let pending = slot.as_ref().ok_or("No credential entry is open")?;
    Ok(EntryPrompt {
        plugin_name: pending.plugin_name.clone(),
        label: pending.label.clone(),
    })
}

#[tauri::command]
pub(crate) async fn plugin_secret_entry_submit<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    entry: tauri::State<'_, SecretEntry>,
    value: String,
) -> Result<()> {
    let value = Zeroizing::new(value);
    let (plugin, name) = {
        let slot = entry.0.lock().unwrap();
        let pending = slot.as_ref().ok_or("No credential entry is open")?;
        (pending.plugin.clone(), pending.name.clone())
    };
    // Keep the entry open on failure so the user can retry.
    tauri::async_runtime::spawn_blocking(move || write_own(&OsStore, &plugin, &name, &value))
        .await
        .map_err(|e| e.to_string())??;
    entry.finish(true);
    if let Some(window) = app.get_webview_window(ENTRY_WINDOW) {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn plugin_secret_entry_cancel<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    entry: tauri::State<'_, SecretEntry>,
) {
    entry.finish(false);
    if let Some(window) = app.get_webview_window(ENTRY_WINDOW) {
        let _ = window.close();
    }
}

// --- Saved grants (Settings) -------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrantInfo {
    consumer: String,
    consumer_name: String,
    provider: String,
    provider_name: String,
    name: String,
}

#[tauri::command]
pub(crate) async fn plugin_secret_grants(
    manager: tauri::State<'_, PluginManager>,
) -> Result<Vec<GrantInfo>> {
    with_manager(manager, |manager| {
        let plugins = manager.catalog()?.plugins;
        let name = |id: &str| {
            plugins
                .iter()
                .find(|plugin| plugin.manifest.id == id)
                .map(|plugin| plugin.manifest.name.clone())
                .unwrap_or_else(|| id.into())
        };
        Ok(manager
            .secret_grants()?
            .into_iter()
            .map(|grant| GrantInfo {
                consumer_name: name(&grant.consumer),
                provider_name: name(&grant.provider),
                consumer: grant.consumer,
                provider: grant.provider,
                name: grant.name,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn plugin_secret_revoke(
    manager: tauri::State<'_, PluginManager>,
    consumer: String,
    provider: String,
    name: String,
) -> Result<()> {
    with_manager(manager, move |manager| {
        manager.revoke_secret(&SecretGrant {
            consumer,
            provider,
            name,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    #[derive(Default)]
    struct MemoryStore(StdMutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn read(&self, account: &str) -> std::result::Result<Option<Zeroizing<String>>, Error> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .map(Zeroizing::new))
        }
        fn write(&self, account: &str, value: &str) -> std::result::Result<(), Error> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> std::result::Result<(), Error> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn own_secrets_round_trip_per_plugin() {
        let store = MemoryStore::default();
        write_own(&store, "loganj.jev", "api-key", "first").unwrap();
        write_own(&store, "loganj.jev", "api-key", "second").unwrap();
        assert!(has_own(&store, "loganj.jev", "api-key").unwrap());
        assert!(!has_own(&store, "other.plugin", "api-key").unwrap());
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .get("loganj.jev/api-key")
                .map(String::as_str),
            Some("second")
        );
        delete_own(&store, "loganj.jev", "api-key").unwrap();
        assert!(!has_own(&store, "loganj.jev", "api-key").unwrap());
    }

    #[test]
    fn rejects_names_and_values_that_could_escape_or_overflow() {
        let store = MemoryStore::default();
        for name in ["", "Key", "a/b", "../x", ".key", &"k".repeat(65)] {
            assert!(
                write_own(&store, "loganj.jev", name, "v").is_err(),
                "{name}"
            );
        }
        assert!(write_own(&store, "bad/id", "key", "v").is_err());
        assert!(write_own(&store, "loganj.jev", "key", "  ").is_err());
        assert!(write_own(
            &store,
            "loganj.jev",
            "key",
            &"v".repeat(MAX_SECRET_BYTES + 1)
        )
        .is_err());
        assert!(write_own(
            &store,
            "loganj.jev",
            "key_2.v-1",
            &"v".repeat(MAX_SECRET_BYTES)
        )
        .is_ok());
        assert_eq!(store.0.lock().unwrap().len(), 1);
    }

    fn install(manager: &Manager, root: &std::path::Path, id: &str, origins: &[&str]) {
        let source = root.join(id);
        fs::create_dir(&source).unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        fs::write(
            source.join("manifest.json"),
            serde_json::json!({
                "id": id, "name": format!("{id} name"), "apiVersion": 1,
                "host": { "networkOrigins": origins },
            })
            .to_string(),
        )
        .unwrap();
        manager.install(&source).unwrap();
        manager.change("enable", id).unwrap();
    }

    fn reference(provider: Option<&str>) -> SecretReference {
        SecretReference {
            provider: provider.map(Into::into),
            name: "token".into(),
            header: "Authorization".into(),
            prefix: "Bearer ".into(),
        }
    }

    fn url(value: &str) -> reqwest::Url {
        reqwest::Url::parse(value).unwrap()
    }

    #[tokio::test]
    async fn secrets_go_only_to_provider_origins_after_consent() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().join("profile")), "test", false).unwrap();
        install(
            &manager,
            temp.path(),
            "example.provider",
            &["https://api.provider.test"],
        );
        install(
            &manager,
            temp.path(),
            "example.adapter",
            &["https://api.provider.test", "https://elsewhere.test"],
        );
        let store = Arc::new(MemoryStore::default());
        write_own(store.as_ref(), "example.provider", "token", "dapi").unwrap();
        let store: Arc<dyn SecretStore> = store;
        let prompts = ConsentPrompts::default();
        let no = |_: &HeaderName| false;

        // The owner uses its secret without a prompt; the value is only in the header.
        let own = plan(
            &manager,
            "example.provider",
            &reference(None),
            &url("https://api.provider.test/v1"),
            no,
        )
        .unwrap();
        assert!(!own.needs_consent);
        let (name, value) = authorize(store.clone(), &prompts, manager.clone(), own, |_| async {
            panic!("owner must not be prompted")
        })
        .await
        .unwrap();
        assert_eq!(name, "authorization");
        assert_eq!(value.to_str().unwrap(), "Bearer dapi");
        assert!(value.is_sensitive());

        // No origin outside the provider's manifest, even one the consumer declares.
        let elsewhere = plan(
            &manager,
            "example.adapter",
            &reference(Some("example.provider")),
            &url("https://elsewhere.test/"),
            no,
        );
        assert_eq!(
            elsewhere.unwrap_err(),
            "This secret cannot be sent to that origin"
        );

        // Declining keeps no grant; Always Allow persists and stops later prompts.
        let mut messages = Vec::new();
        for answer in [false, true] {
            let cross = plan(
                &manager,
                "example.adapter",
                &reference(Some("example.provider")),
                &url("https://api.provider.test/v1"),
                no,
            )
            .unwrap();
            assert!(cross.needs_consent);
            let result = authorize(store.clone(), &prompts, manager.clone(), cross, |message| {
                messages.push(message);
                async move { answer }
            })
            .await;
            assert_eq!(result.is_ok(), answer);
        }
        assert!(messages[0].contains("“example.adapter name” wants to use the credential “token” saved by “example.provider name”"));
        let again = plan(
            &manager,
            "example.adapter",
            &reference(Some("example.provider")),
            &url("https://api.provider.test/v1"),
            no,
        )
        .unwrap();
        assert!(!again.needs_consent);

        // Revoking asks again.
        manager
            .revoke_secret(&SecretGrant {
                consumer: "example.adapter".into(),
                provider: "example.provider".into(),
                name: "token".into(),
            })
            .unwrap();
        assert!(
            plan(
                &manager,
                "example.adapter",
                &reference(Some("example.provider")),
                &url("https://api.provider.test/v1"),
                no
            )
            .unwrap()
            .needs_consent
        );
    }

    #[tokio::test]
    async fn rejects_missing_disabled_and_reserved_references() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().join("profile")), "test", false).unwrap();
        install(
            &manager,
            temp.path(),
            "example.provider",
            &["https://api.provider.test"],
        );
        let target = url("https://api.provider.test/");
        assert!(plan(
            &manager,
            "example.provider",
            &reference(Some("example.absent")),
            &target,
            |_| false
        )
        .is_err());
        assert_eq!(
            plan(
                &manager,
                "example.provider",
                &reference(None),
                &target,
                |_| true
            )
            .unwrap_err(),
            "Secret header is not allowed"
        );
        let own = plan(
            &manager,
            "example.provider",
            &reference(None),
            &target,
            |_| false,
        )
        .unwrap();
        let empty: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
        assert_eq!(
            authorize(
                empty,
                &ConsentPrompts::default(),
                manager.clone(),
                own,
                |_| async { true }
            )
            .await
            .unwrap_err(),
            "The credential is not saved"
        );
        manager.change("disable", "example.provider").unwrap();
        assert!(plan(
            &manager,
            "example.provider",
            &reference(None),
            &target,
            |_| false
        )
        .is_err());
    }
}
