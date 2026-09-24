//! A read-only floating view of the app-owned compute worker.
use crate::compute_host::ComputeHost;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "compute-widget";
#[tauri::command]
pub async fn compute_widget_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, ComputeHost>,
) -> Result<(), String> {
    if !host.status()?.available {
        return Err("Enable Compute in the development desktop app to open its widget".into());
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("compute-widget.html".into()))
        .title("Compute")
        .inner_size(200.0, 200.0)
        .min_inner_size(128.0, 128.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .always_on_top(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn compute_widget_close<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
