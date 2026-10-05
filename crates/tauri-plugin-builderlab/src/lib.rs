//! Opt-in native companion to the `block.builderlab` Settings plugin.
mod callback;
mod session;

use session::{Account, BuilderlabHost, Config, Env};
use tauri::{plugin::TauriPlugin, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn auth(host: tauri::State<'_, BuilderlabHost>) -> Result<Option<Account>, String> {
    host.inner().clone().auth().await
}
#[tauri::command]
async fn login<R: Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, BuilderlabHost>,
) -> Result<Account, String> {
    host.inner()
        .clone()
        .login(&move |url: &str| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "Could not open the sign-in browser".to_owned())
        })
        .await
}
#[tauri::command]
fn cancel(host: tauri::State<'_, BuilderlabHost>) -> Result<(), String> {
    host.cancel()
}
#[tauri::command]
async fn sign_out(host: tauri::State<'_, BuilderlabHost>) -> Result<(), String> {
    host.inner().clone().sign_out().await
}

/// Only compiled/registered by the app's `builderlab` feature. The grant is
/// restricted to the local main webview, never browser guests or remote pages.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("builderlab")
        .invoke_handler(tauri::generate_handler![auth, login, cancel, sign_out])
        .setup(|app, _| {
            app.add_capability(include_str!("../capability.json"))?;
            app.manage(BuilderlabHost::new(
                app.path()
                    .home_dir()
                    .map_err(|_| "Could not resolve the Builderlab session store".to_owned())
                    .and_then(|home| Config::resolve(&Env::from_process(), &home)),
            ));
            Ok(())
        })
        .build()
}
