pub mod agent_runner;
mod community_compute;
mod demo_credits;
mod compute_host;
mod compute_widget;
use compute_host::ComputeHost;
mod notifications;
mod terminal;
use notifications::{notification_show, Notifications};
use tauri::Manager as _;
use terminal::{
    terminal_close, terminal_close_owner, terminal_create_owner, terminal_read, terminal_resize,
    terminal_spawn, terminal_write, Terminals,
};

use buzzodz_plugins::{
    imports::{prepare_folder, prepare_git, PreparedImport, Preview},
    Catalog, InstallationResult, Manager,
};
use std::sync::{Arc, Mutex};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Default)]
struct Imports(Arc<Mutex<Option<PreparedImport>>>);

async fn prepare_import(
    imports: Imports,
    operation: impl FnOnce() -> Result<Option<PreparedImport>, String> + Send + 'static,
) -> Result<Option<Preview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        *pending = None;
        *pending = operation()?;
        Ok(pending.as_ref().map(|p| p.preview.clone()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_import_folder(
    app: tauri::AppHandle,
    imports: tauri::State<'_, Imports>,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        app.dialog()
            .file()
            .set_title("Choose a plugin folder")
            .blocking_pick_folder()
            .map(|folder| prepare_folder(&folder.into_path().map_err(|e| e.to_string())?))
            .transpose()
    })
    .await
}
#[tauri::command]
async fn plugin_import_git(
    imports: tauri::State<'_, Imports>,
    repository: String,
    reference: String,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        prepare_git(&repository, &reference).map(Some)
    })
    .await
}
#[tauri::command]
async fn plugin_import_discard(
    imports: tauri::State<'_, Imports>,
    token: String,
) -> Result<(), String> {
    let mut pending = imports
        .0
        .try_lock()
        .map_err(|_| "Another import is in progress")?;
    if pending.as_ref().is_some_and(|p| p.preview.token == token) {
        *pending = None;
    }
    Ok(())
}
#[tauri::command]
async fn plugin_import_install(
    manager: tauri::State<'_, PluginManager>,
    imports: tauri::State<'_, Imports>,
    token: String,
    path: String,
) -> Result<InstallationResult, String> {
    let imports = imports.inner().clone();
    with_manager(manager, move |m| {
        let pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        pending
            .as_ref()
            .ok_or("This import preview expired. Choose the source again.")?
            .install(&m, &token, &path)
            .map(|catalog| ready(&m, catalog))
    })
    .await
}

fn ready(manager: &Manager, catalog: Catalog) -> InstallationResult {
    InstallationResult::Ready {
        catalog,
        external_plugins_paused: manager.external_plugins_paused(),
    }
}

// Invalid environment configuration must not prevent the recovery shell from opening.
struct PluginManager(Result<Manager, String>);
async fn with_manager<T: Send + 'static>(
    state: tauri::State<'_, PluginManager>,
    operation: impl FnOnce(Manager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let manager = state.0.clone()?;
    tauri::async_runtime::spawn_blocking(move || operation(manager))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_catalog(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| {
        Ok(match m.catalog() {
            Ok(catalog) => ready(&m, catalog),
            Err(reason) => InstallationResult::Recovery {
                reason,
                can_reset: true,
            },
        })
    })
    .await
}
#[tauri::command]
async fn plugin_change(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PluginManager>,
    action: String,
    id: String,
    compute: tauri::State<'_, ComputeHost>,
) -> Result<InstallationResult, String> {
    let compute = compute.inner().clone();
    with_manager(manager, move |m| {
        if id == "buzz.community-compute" && action == "disable" {
            compute.set_allowed(false);
            compute.stop(None, true)?;
            if let Some(window) = app.get_webview_window(compute_widget::LABEL) {
                window.close().map_err(|e| e.to_string())?;
            }
        }
        let result = m.change(&action, &id)?;
        if id == "buzz.community-compute" && action == "enable" {
            compute.set_allowed(true);
        }
        Ok(ready(&m, result))
    })
    .await
}
#[tauri::command]
async fn plugin_module(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
) -> Result<String, String> {
    with_manager(manager, move |m| m.module(&id, &revision)).await
}
#[tauri::command]
async fn plugin_recover(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| m.recover().map(|catalog| ready(&m, catalog))).await
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Imports::default())
        .manage(Terminals::default())
        .manage(Notifications::default())
        .manage(PluginManager(Manager::from_env()))
        .setup(|app| {
            let enabled = app
                .state::<PluginManager>()
                .0
                .as_ref()
                .ok()
                .and_then(|m| m.catalog().ok())
                .is_some_and(|catalog| {
                    catalog
                        .plugins
                        .iter()
                        .any(|p| p.manifest.id == "buzz.community-compute" && p.enabled)
                });
            let host = ComputeHost::new(
                app.path().app_data_dir().ok(),
                app.config().build.dev_url.as_ref().map(ToString::to_string),
                enabled,
            );
            app.manage(host.clone());
            app.manage(agent_runner::AgentRunner::new(
                app.path().app_data_dir()?,
                std::env::current_exe()?
                    .parent()
                    .ok_or("Missing app executable directory")?
                    .join("agent-runtime"),
                host.clone(),
            ));
            host.restore();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_runner::agent_runner_status,
            agent_runner::agent_runner_start,
            agent_runner::agent_runner_stop,
            compute_widget::compute_widget_open,
            compute_widget::compute_widget_close,
            community_compute::community_compute_test,
            community_compute::community_compute_status,
            community_compute::community_compute_models,
            community_compute::community_compute_start,
            community_compute::community_compute_stop,
            community_compute::community_compute_snapshot,
            demo_credits::community_compute_demo_wallet,
            demo_credits::community_compute_demo_add_consumer_credits,
            demo_credits::community_compute_demo_spend,
            demo_credits::community_compute_demo_reset,
            demo_credits::community_compute_demo_seed_legacy,
            notification_show,
            terminal_create_owner,
            terminal_spawn,
            terminal_read,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_close_owner,
            plugin_import_folder,
            plugin_import_git,
            plugin_import_install,
            plugin_import_discard,
            plugin_catalog,
            plugin_change,
            plugin_module,
            plugin_recover
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Buzz Foundation")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = app.state::<agent_runner::AgentRunner>().stop();
                let _ = app.state::<ComputeHost>().stop(None, false);
                if let Err(error) = app.state::<Terminals>().shutdown() {
                    eprintln!("Terminal shutdown failed: {error}");
                }
            }
        });
}
