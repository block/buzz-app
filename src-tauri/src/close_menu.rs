//! Cmd+W is a menu action that only ever closes a tab, never the window: with
//! no tab to close it does nothing. The red button still closes the window.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Manager, Runtime,
};

const CLOSE: &str = "buzz-close";
const REQUEST: &str = include_str!("close-request.js");

pub(crate) fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let close = MenuItem::with_id(app, CLOSE, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    // Tauri's default has Close Window in both File and Window. Preserve all
    // other native items (especially editing/services), replacing both routes.
    // Predefined items expose their label, but not their native action type.
    let close_label = PredefinedMenuItem::close_window(app, None)?.text()?;
    let mut replaced = 0;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, item) in submenu.items()?.iter().enumerate() {
                if let Some(predefined) = item.as_predefined_menuitem() {
                    if predefined.text()? == close_label {
                        submenu.remove(item)?;
                        submenu.insert(&close, index)?;
                        replaced += 1;
                    }
                }
            }
        }
    }
    debug_assert_eq!(replaced, 2, "Tauri default Close menu structure changed");
    Ok(menu)
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() != CLOSE {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Unlike a predefined Close item, custom menu items stay enabled without
    // a key window. Never consume a retained tab in a hidden/background window.
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || !window.is_focused().unwrap_or(false)
    {
        return;
    }
    // Evaluate only in the trusted main view, even when a raw guest webview
    // owns keyboard focus.
    if let Err(error) = window.eval(REQUEST) {
        eprintln!("Could not request Buzz tab close: {error}");
    }
}
