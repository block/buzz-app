//! Cmd+W is a menu action, not a window-close request: the red button must
//! continue closing the window even when a tab is open.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Manager, Runtime,
};

const CLOSE: &str = "buzz-close";
const REQUEST: &str = include_str!("close-request.js");

pub(crate) fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let close = MenuItem::with_id(app, CLOSE, "Close", true, Some("CmdOrCtrl+W"))?;
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
    // owns keyboard focus. One synchronous decision avoids stale tab state,
    // startup/reload subscription gaps, and timeout-driven double closes.
    let target = window.clone();
    if let Err(error) = window.eval_with_callback(REQUEST, move |result| {
        // Only an explicit unhandled result permits fallback. Evaluation errors
        // must not turn a handled tab close into a second, window-level close.
        if result == r#""unhandled""#
            && target.is_visible().unwrap_or(false)
            && target.is_focused().unwrap_or(false)
        {
            if let Err(error) = target.close() {
                eprintln!("Could not close Buzz window: {error}");
            }
        }
    }) {
        eprintln!("Could not request Buzz close: {error}");
    }
}
