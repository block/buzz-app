//! Session policy for app-owned chrome, not a compositor capability probe.

#[derive(Debug, PartialEq, Eq)]
struct WindowControls {
    minimize: bool,
    maximize: bool,
}

fn session_controls(linux: bool, desktop: &str, omarchy_path: &str) -> WindowControls {
    let hyprland = linux
        && desktop
            .split(':')
            .any(|name| name.trim().eq_ignore_ascii_case("Hyprland"));
    WindowControls {
        minimize: !hyprland,
        // Stock Omarchy suppresses application maximize requests. Keep Maximize
        // for other Hyprland configs, which may permit it. OMARCHY_PATH is
        // exported by Omarchy's desktop session.
        maximize: !hyprland || omarchy_path.trim().is_empty(),
    }
}

fn initialization_script(controls: WindowControls) -> String {
    // Only booleans cross into the webview; never inject environment strings.
    format!(
        "window.__BUZZ_WINDOW_CONTROLS__ = {{ minimize: {}, maximize: {} }};",
        controls.minimize, controls.maximize
    )
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("XDG_SESSION_DESKTOP").ok())
        .unwrap_or_default();
    let controls = session_controls(
        cfg!(target_os = "linux"),
        &desktop,
        &std::env::var("OMARCHY_PATH").unwrap_or_default(),
    );
    // Document-start injection keeps launch, identity and shell chrome consistent
    // without an asynchronous IPC query or flashing unsupported buttons.
    tauri::plugin::Builder::new("window-controls")
        .js_init_script(initialization_script(controls))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_policy_to_the_matching_desktop_session() {
        for (linux, desktop, path, minimize, maximize) in [
            (true, "Hyprland", "/usr/share/omarchy", false, false),
            (
                true,
                "Hyprland",
                "/home/user/.local/share/omarchy",
                false,
                false,
            ),
            (true, "vendor:hyprland", "/omarchy", false, false),
            (true, "Hyprland", "", false, true),
            (true, " Hyprland ", "  ", false, true),
            (true, "GNOME", "/omarchy", true, true),
            (true, "KDE", "", true, true),
            (true, "sway", "", true, true),
            (true, "NotHyprland", "/omarchy", true, true),
            (true, "", "/omarchy", true, true),
            (false, "Hyprland", "/omarchy", true, true),
        ] {
            assert_eq!(
                session_controls(linux, desktop, path),
                WindowControls { minimize, maximize },
                "linux={linux}, desktop={desktop:?}, path={path:?}"
            );
        }
    }

    #[test]
    fn injects_only_the_control_policy() {
        assert_eq!(
            initialization_script(session_controls(true, "Hyprland", "/private/path")),
            "window.__BUZZ_WINDOW_CONTROLS__ = { minimize: false, maximize: false };"
        );
        assert_eq!(
            initialization_script(session_controls(true, "Hyprland", "")),
            "window.__BUZZ_WINDOW_CONTROLS__ = { minimize: false, maximize: true };"
        );
    }
}
