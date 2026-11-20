//! Windows notification-area icon.
//!
//! Closing the main window on Windows hides it (see the `CloseRequested`
//! handler), so running agents keep working. This icon is the way back: a left
//! click opens Buzz, and its menu offers Open and Quit. Once the window is
//! hidden it is the way to quit, since Alt+F4 and the taskbar's Close only
//! close the window.
use std::{fs::OpenOptions, io::ErrorKind, path::Path};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

const TRAY_ID: &str = "buzz-tray";
const OPEN_ID: &str = "tray-open";
const QUIT_ID: &str = "tray-quit";
/// In the app data dir once the first close has said where Buzz went.
const CLOSE_HINT_MARKER: &str = "windows-close-hint-shown";

#[derive(Debug, PartialEq, Eq)]
enum TrayCommand {
    Open,
    Quit,
}

fn command(id: &str) -> Option<TrayCommand> {
    match id {
        OPEN_ID => Some(TrayCommand::Open),
        QUIT_ID => Some(TrayCommand::Quit),
        _ => None,
    }
}

/// Only a left-button release opens Buzz: the right button belongs to the
/// menu, and each click also reports a press.
fn opens(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

/// Adds Buzz's icon, which lasts as long as the app.
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN_ID, "Open Buzz", true, None::<&str>)?,
            &MenuItem::with_id(app, QUIT_ID, "Quit Buzz", true, None::<&str>)?,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Buzz")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match command(event.id.as_ref()) {
            Some(TrayCommand::Open) => crate::deep_links::focus_main(app),
            // The same exit as quitting from the app menu: agents stop with Buzz.
            Some(TrayCommand::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if opens(&event) {
                crate::deep_links::focus_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Whether Buzz's icon is in the notification area, so a closed window can
/// come back.
pub(crate) fn installed<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

/// Whether this is the first close to report. Creating the marker is the
/// claim, so a marker that cannot be written skips the hint instead of
/// repeating it on every close.
fn first_close(data_dir: &Path) -> bool {
    let claimed = std::fs::create_dir_all(data_dir).and_then(|()| {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(data_dir.join(CLOSE_HINT_MARKER))
    });
    match claimed {
        Ok(_) => true,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => false,
        Err(error) => {
            eprintln!("Could not record the close hint: {error}");
            false
        }
    }
}

/// Closing quits most Windows apps, so the first close says once that Buzz is
/// still running and where its icon is.
pub(crate) fn hint_first_close<R: Runtime>(app: &AppHandle<R>) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    if !first_close(&data_dir) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let shown = crate::notifications::toast_app_id(&app).and_then(|id| {
            tauri_winrt_notification::Toast::new(&id)
                .title("Buzz is still running")
                .text1("Closing the window keeps Buzz in the notification area. Right-click its icon to quit.")
                .show()
                .map_err(|e| e.to_string())
        });
        if let Err(error) = shown {
            eprintln!("Could not show the close hint: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{tray::TrayIconId, PhysicalPosition, Rect};

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn installed_only_after_install() {
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("mock app");
        assert!(!installed(app.handle()));
        install(app.handle()).expect("tray icon");
        assert!(installed(app.handle()));
    }

    #[test]
    fn menu_items_open_and_quit() {
        assert_eq!(command(OPEN_ID), Some(TrayCommand::Open));
        assert_eq!(command(QUIT_ID), Some(TrayCommand::Quit));
        assert_eq!(command(""), None);
    }

    #[test]
    fn close_hint_once_per_data_dir() {
        let root = tempfile::tempdir().unwrap();
        // A fresh install can close before anything else creates the dir.
        let data_dir = root.path().join("app");
        assert!(first_close(&data_dir));
        assert!(data_dir.join(CLOSE_HINT_MARKER).exists());
        assert!(!first_close(&data_dir));
    }

    #[test]
    fn close_hint_skipped_when_unrecordable() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file");
        std::fs::write(&file, b"").unwrap();
        assert!(!first_close(&file));
        assert!(!first_close(&file));
    }

    #[test]
    fn only_a_left_release_opens_buzz() {
        assert!(opens(&click(MouseButton::Left, MouseButtonState::Up)));
        assert!(!opens(&click(MouseButton::Left, MouseButtonState::Down)));
        assert!(!opens(&click(MouseButton::Right, MouseButtonState::Up)));
        assert!(!opens(&TrayIconEvent::Enter {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
        }));
    }
}
