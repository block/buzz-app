//! Keep the hidden main window reachable while its agents continue running.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show-buzz", "Show Buzz", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit-buzz", "Quit Buzz", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app.default_window_icon().ok_or("Buzz tray icon missing")?;
    TrayIconBuilder::with_id("buzz")
        .icon(icon.clone())
        .tooltip("Buzz")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-buzz" => crate::deep_links::focus_main(app),
            "quit-buzz" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                crate::deep_links::focus_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
