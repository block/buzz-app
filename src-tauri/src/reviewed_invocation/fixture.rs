//! Debug-only isolated manual host. Reuses production commands/executor, installed
//! artifacts and the actual frontend PluginRuntime. Never starts normal identity,
//! community, helper, provider, or app startup services. Not an acceptance API.
use super::{HostCalls, Invocations, PluginManager};
use tauri::Manager as _;

pub fn run() {
    let temporary = tempfile::tempdir().expect("temporary fixture root");
    let root = dunce::canonicalize(temporary.path()).expect("canonical fixture root");
    let executable = std::env::current_exe()
        .expect("fixture executable")
        .with_file_name("reviewed-input-recipient");
    let bytes = std::fs::read(&executable).expect("build the closed synthetic recipient first");
    use sha2::{Digest as _, Sha256};
    let hash = format!("{:x}", Sha256::digest(bytes));
    // Never consult an inherited managed-plugin policy in the disposable fixture.
    std::env::set_var("BUZZ_MANAGED_PLUGINS", root.join("no-managed-policy.json"));
    let source = root.join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(
        source.join("plugin.js"),
        include_str!("../../../tests/fixtures/reviewed-invocation/plugin.js"),
    )
    .unwrap();
    std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
        "id":"example.reviewed-fixture", "name":"Fake reviewed invocation fixture", "apiVersion":1,
        "host":{"reviewedInvocations":[{"id":"synthetic", "artifact":{"path":executable,"sha256":hash}}]}
    })).unwrap()).unwrap();
    let manager =
        buzzodz_plugins::Manager::open(Some(root.join("registry")), "fixture", false).unwrap();
    manager.install(&source).unwrap();
    manager
        .change("enable", "example.reviewed-fixture")
        .unwrap();
    eprintln!(
        "FAKE fixture registry: {}\nPinned synthetic recipient SHA-256: {hash}",
        root.join("registry").display()
    );
    let mut context = crate::app_context();
    let config = context.config_mut();
    config.identifier = "xyz.buzz.reviewed-fake-fixture".into();
    config.app.app_directories_override =
        Some(tauri::utils::config::AppDirectoriesOverride::Root(root));
    config.build.dev_url = Some("http://127.0.0.1:1439".parse().unwrap());
    config.app.windows.truncate(1);
    config.app.windows[0].title = "Synthetic host-card review fixture".into();
    config.app.windows[0].visible = true;
    config.app.windows[0].url = tauri::WebviewUrl::External(
        "http://127.0.0.1:1439/tests/fixtures/reviewed-invocation/"
            .parse()
            .unwrap(),
    );
    tauri::Builder::default()
        .manage(PluginManager(Ok(manager)))
        .manage(HostCalls::default())
        .manage(Invocations::default())
        .manage(crate::federated_identity::access::Registrations::default())
        .invoke_handler(tauri::generate_handler![
            crate::plugin_catalog,
            crate::plugin_module,
            crate::plugin_change,
            crate::host_request::plugin_host_call_context,
            super::plugin_host_reviewed_invoke,
            super::plugin_host_reviewed_retire,
            super::plugin_host_reviewed_dispatch,
        ])
        .on_page_load(|view, payload| {
            if view.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                view.state::<HostCalls>().page_load();
                view.state::<Invocations>().clear();
            }
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                window.state::<Invocations>().clear();
            }
        })
        .run(context)
        .expect("manual fixture host");
    drop(temporary);
}
