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
fn cancel(host: tauri::State<'_, BuilderlabHost>) -> Result<(), String> {
    host.cancel()
}
#[tauri::command]
async fn sign_out(host: tauri::State<'_, BuilderlabHost>) -> Result<(), String> {
    host.inner().clone().sign_out().await
}

fn handle<R: Runtime>(invoke: tauri::ipc::Invoke<R>) -> bool {
    if invoke.message.command() != "login" {
        let handler: fn(tauri::ipc::Invoke<R>) -> bool =
            tauri::generate_handler![auth, cancel, sign_out];
        return handler(invoke);
    }
    let app = invoke.message.webview().app_handle().clone();
    let host = app.state::<BuilderlabHost>().inner().clone();
    // An async command macro schedules even its argument extraction. Register
    // here, in dispatch order with synchronous cancel, before scheduling work.
    // No storage or network access happens on the dispatch thread.
    let attempt = host.begin_login();
    invoke.resolver.respond_async(async move {
        host.complete_login(attempt?, &move |url: &str| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "Could not open the sign-in browser".to_owned())
        })
        .await
        .map_err(Into::into)
    });
    true
}

/// Only compiled/registered by the app's `builderlab` feature. The grant is
/// restricted to the local main webview, never browser guests or remote pages.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("builderlab")
        .invoke_handler(handle)
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
