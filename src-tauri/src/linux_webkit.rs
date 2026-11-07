use std::{env, path::Path};

const NVIDIA_KERNEL_MODULE: &str = "/sys/module/nvidia";
const FORCE_DMABUF_RENDERER: &str = "WEBKIT_FORCE_DMABUF_RENDERER";
const DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const RENDERER_DISABLES: [&str; 2] = [
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
];

pub fn enable_gpu_rendering_on_nvidia_wayland() {
    let nvidia = Path::new(NVIDIA_KERNEL_MODULE).exists();
    let wayland = uses_wayland(
        env_value("WAYLAND_DISPLAY").as_deref(),
        env_value("GDK_BACKEND").as_deref(),
    );
    for name in gpu_rendering_settings(nvidia, wayland, env_value) {
        env::set_var(name, "1");
    }
}

fn env_value(name: &str) -> Option<String> {
    env::var_os(name).map(|value| value.to_string_lossy().into_owned())
}

fn uses_wayland(wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    let preferred_backend = gdk_backend.map_or("*", |backends| {
        backends.split(',').next().unwrap_or_default()
    });
    wayland_display.is_some_and(|display| !display.is_empty())
        && matches!(preferred_backend, "*" | "wayland")
}

fn gpu_rendering_settings(
    nvidia: bool,
    wayland: bool,
    value: impl Fn(&str) -> Option<String>,
) -> Vec<&'static str> {
    if !nvidia || !wayland {
        return Vec::new();
    }
    let renderer_disabled = RENDERER_DISABLES
        .iter()
        .any(|name| value(name).is_some_and(|setting| setting != "0"));
    let force = value(FORCE_DMABUF_RENDERER).unwrap_or_default();
    let explicit_sync = value(DISABLE_EXPLICIT_SYNC);
    if renderer_disabled
        || force.starts_with('0')
        || explicit_sync
            .as_deref()
            .is_some_and(|setting| setting != "1")
    {
        return Vec::new();
    }
    let mut settings = Vec::new();
    if force.is_empty() {
        settings.push(FORCE_DMABUF_RENDERER);
    }
    if explicit_sync.is_none() {
        settings.push(DISABLE_EXPLICIT_SYNC);
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOTH: [&str; 2] = [FORCE_DMABUF_RENDERER, DISABLE_EXPLICIT_SYNC];

    fn settings_with(name: &'static str, setting: &'static str) -> Vec<&'static str> {
        gpu_rendering_settings(true, true, |asked| {
            (asked == name).then(|| setting.to_string())
        })
    }

    #[test]
    fn nvidia_on_wayland_gets_both_settings() {
        assert_eq!(gpu_rendering_settings(true, true, |_| None), BOTH);
    }

    #[test]
    fn other_gpus_and_x11_are_left_alone() {
        assert!(gpu_rendering_settings(false, true, |_| None).is_empty());
        assert!(gpu_rendering_settings(true, false, |_| None).is_empty());
    }

    #[test]
    fn opting_out_of_the_force_setting_leaves_everything_alone() {
        assert!(settings_with(FORCE_DMABUF_RENDERER, "0").is_empty());
    }

    #[test]
    fn a_force_setting_webkit_ignores_is_replaced() {
        assert_eq!(settings_with(FORCE_DMABUF_RENDERER, ""), BOTH);
    }

    #[test]
    fn forcing_by_hand_still_gets_the_explicit_sync_setting() {
        assert_eq!(
            settings_with(FORCE_DMABUF_RENDERER, "1"),
            [DISABLE_EXPLICIT_SYNC]
        );
    }

    #[test]
    fn a_renderer_disable_wins_unless_it_is_zero() {
        for name in RENDERER_DISABLES {
            assert!(settings_with(name, "1").is_empty(), "{name}");
            assert!(settings_with(name, "").is_empty(), "{name}");
            assert_eq!(settings_with(name, "0"), BOTH, "{name}");
        }
    }

    #[test]
    fn an_explicit_sync_value_the_driver_ignores_blocks_forcing() {
        assert_eq!(
            settings_with(DISABLE_EXPLICIT_SYNC, "1"),
            [FORCE_DMABUF_RENDERER]
        );
        assert!(settings_with(DISABLE_EXPLICIT_SYNC, "0").is_empty());
        assert!(settings_with(DISABLE_EXPLICIT_SYNC, "").is_empty());
    }

    #[test]
    fn wayland_needs_a_display_and_wayland_as_the_first_backend() {
        let display = Some("wayland-1");
        assert!(uses_wayland(display, None));
        assert!(uses_wayland(display, Some("wayland,x11,*")));
        assert!(uses_wayland(display, Some("*")));
        assert!(uses_wayland(display, Some("*,x11")));
        assert!(!uses_wayland(display, Some("x11")));
        assert!(!uses_wayland(display, Some("x11,wayland")));
        assert!(!uses_wayland(Some(""), None));
        assert!(!uses_wayland(None, None));
    }
}
