//! Settings → Appearance → Match display refresh rate, on macOS.
//!
//! On a display faster than 60 Hz, WebKit holds page rendering updates
//! (`requestAnimationFrame`, style, layout and main-thread paint) near 60 fps
//! while its "Prefer Page Rendering Updates near 60fps" feature is on, as it
//! is by default. A 120 Hz display then gets one rendering update every other
//! refresh. Only private `WKPreferences` API turns the feature off: the
//! `+_features` list and `-_setEnabled:forFeature:`, which Safari's Feature
//! Flags menu uses. A WebKit without either, or without the feature, keeps
//! the cap, and Settings does not offer the choice.
//!
//! The choice is off by default, as in Safari. It is saved in the app config
//! directory, so setup reads it before the main window is first shown, and
//! applies from the next launch. A page applies the feature only when its
//! rendering cadence is next recomputed, as when its window is shown, its
//! display changes or Low Power Mode toggles, not when the feature is set
//! (the feature has no change handler, and WebKit no call that recomputes the
//! cadence). Wry starts loading before Tauri's setup runs, but the macOS
//! launch window stays hidden until the page shows it.

use std::path::Path;

use objc2::{msg_send, rc::Retained, runtime::AnyObject, sel, ClassType};
use objc2_foundation::{NSArray, NSString};
use objc2_web_kit::{WKPreferences, WKWebView};
use tauri::Manager;

const NEAR_60_FPS: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";
const FILE: &str = "match-display-refresh-rate.json";

/// Whether the owner chose to match the display. Missing or unreadable
/// choices keep WebKit's cap.
pub(crate) fn saved(config: &Path) -> bool {
    std::fs::read(config.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(false)
}

fn save(config: &Path, enabled: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(config)?;
    std::fs::write(config.join(FILE), if enabled { "true" } else { "false" })
}

/// WebKit's feature, when this WebKit can turn it off.
fn feature() -> Option<Retained<AnyObject>> {
    if !WKPreferences::class()
        .metaclass()
        .responds_to(sel!(_features))
        || !WKPreferences::class().responds_to(sel!(_setEnabled:forFeature:))
    {
        return None;
    }
    let features: Retained<NSArray<AnyObject>> =
        unsafe { msg_send![WKPreferences::class(), _features] };
    let key = NSString::from_str(NEAR_60_FPS);
    features.iter().find(|feature| {
        feature.class().responds_to(sel!(key)) && {
            let name: Retained<NSString> = unsafe { msg_send![feature, key] };
            name == key
        }
    })
}

/// Turns the cap off for `webview` when `enabled`. Call on the main thread,
/// before the main window is first shown.
pub(crate) fn install(webview: &tauri::webview::PlatformWebview, enabled: bool) {
    if !enabled {
        return;
    }
    // SAFETY: Wry's macOS webview is a WKWebView.
    let webview = unsafe { &*webview.inner().cast::<WKWebView>() };
    let preferences = unsafe { webview.configuration().preferences() };
    match feature() {
        Some(feature) => unsafe {
            let _: () = msg_send![&preferences, _setEnabled: false, forFeature: &*feature];
        },
        None => eprintln!("WebKit cannot change its rendering rate"),
    }
}

/// The saved choice, or `None` when this WebKit cannot apply it. Runs on the
/// main thread, as WebKit's API expects.
#[tauri::command]
pub(crate) fn render_rate_preference<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<bool>, String> {
    if feature().is_none() {
        return Ok(None);
    }
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(Some(saved(&config)))
}

#[tauri::command]
pub(crate) fn render_rate_set<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    save(&config, enabled).map_err(|_| "Could not save the refresh rate choice.".into())
}

#[cfg(test)]
mod tests {
    use super::{save, saved, FILE};

    #[test]
    fn keeps_the_cap_until_the_owner_opts_in() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!saved(dir.path()));
        for unreadable in ["", "on", "1", "{\"enabled\":true}"] {
            std::fs::write(dir.path().join(FILE), unreadable).unwrap();
            assert!(!saved(dir.path()), "{unreadable:?}");
        }
    }

    #[test]
    fn saves_the_choice_for_the_next_launch() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("missing");
        save(&config, true).unwrap();
        assert!(saved(&config));
        save(&config, false).unwrap();
        assert!(!saved(&config));
    }
}
