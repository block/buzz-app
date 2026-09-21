//! Tauri owns shell presentation; the host supplies one ordered unread boolean.
#[cfg(any(test, target_os = "windows"))]
const UNREAD: tauri::image::Image<'_> = tauri::include_image!("icons/unread-overlay.png");
#[cfg(any(test, target_os = "linux"))]
const TRAY: tauri::image::Image<'_> = tauri::include_image!("icons/tray.png");
#[cfg(any(test, target_os = "linux"))]
const TRAY_UNREAD: tauri::image::Image<'_> = tauri::include_image!("icons/tray-unread.png");

#[tauri::command]
pub(crate) fn unread_indicator_set(
    window: tauri::WebviewWindow,
    unread: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Unread indicators belong to the main window".into());
    }
    #[cfg(target_os = "macos")]
    return window
        .set_badge_label(unread.then(|| "•".into()))
        .map_err(|e| e.to_string());
    #[cfg(target_os = "windows")]
    return window
        .set_overlay_icon(unread.then(|| UNREAD.clone()))
        .map_err(|e| e.to_string());
    #[cfg(target_os = "linux")]
    return linux_set(&window, unread).map_err(|e| e.to_string());
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = unread;
        Err("Unread indicators are unavailable on this platform".into())
    }
}

#[cfg(target_os = "linux")]
fn linux_set(window: &tauri::WebviewWindow, unread: bool) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
        Manager,
    };
    let app = window.app_handle();
    let icon = if unread {
        TRAY_UNREAD.clone()
    } else {
        TRAY.clone()
    };
    if let Some(tray) = app.tray_by_id("unread-indicator") {
        return tray.set_icon(Some(icon));
    }
    // Synchronous Tauri commands execute on the main thread. Tauri retains the
    // tray for the app's lifetime: frontend reloads reuse it and its menu handler.
    // No click handler/tooltip: Linux only guarantees the tray's menu interface.
    let show = MenuItem::with_id(app, "unread-show", "Show Buzz", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show])?;
    TrayIconBuilder::with_id("unread-indicator")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() != "unread-show" {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = crate::notifications::focus(&window) {
                    eprintln!("Show Buzz failed: {error}");
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_icons_are_small_rgba_and_unread_adds_a_shape() {
        for icon in [&UNREAD, &TRAY, &TRAY_UNREAD] {
            assert_eq!((icon.width(), icon.height()), (32, 32));
            assert_eq!(icon.rgba().len(), 32 * 32 * 4);
        }
        assert_ne!(TRAY.rgba(), TRAY_UNREAD.rgba());
    }
}
