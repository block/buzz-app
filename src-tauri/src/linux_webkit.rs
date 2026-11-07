use std::{env, ffi::OsStr, path::Path};

const NVIDIA_KERNEL_MODULE: &str = "/sys/module/nvidia";
const FORCE_DMABUF_RENDERER: &str = "WEBKIT_FORCE_DMABUF_RENDERER";
const DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const RENDERING_CHOICES: [&str; 3] = [
    FORCE_DMABUF_RENDERER,
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
];

pub fn enable_gpu_rendering_on_nvidia_wayland() {
    let nvidia = Path::new(NVIDIA_KERNEL_MODULE).exists();
    let wayland = uses_wayland(
        env::var_os("WAYLAND_DISPLAY").as_deref(),
        env::var_os("GDK_BACKEND").as_deref(),
    );
    let settings = gpu_rendering_settings(nvidia, wayland, |name| env::var_os(name).is_some());
    for name in settings {
        env::set_var(name, "1");
    }
}

fn uses_wayland(wayland_display: Option<&OsStr>, gdk_backend: Option<&OsStr>) -> bool {
    wayland_display.is_some()
        && gdk_backend.is_none_or(|backends| backends.to_string_lossy().starts_with("wayland"))
}

fn gpu_rendering_settings(
    nvidia: bool,
    wayland: bool,
    is_set: impl Fn(&str) -> bool,
) -> Vec<&'static str> {
    if !nvidia || !wayland || RENDERING_CHOICES.iter().any(|name| is_set(name)) {
        return Vec::new();
    }
    [FORCE_DMABUF_RENDERER, DISABLE_EXPLICIT_SYNC]
        .into_iter()
        .filter(|name| !is_set(name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOTH: [&str; 2] = [FORCE_DMABUF_RENDERER, DISABLE_EXPLICIT_SYNC];

    #[test]
    fn nvidia_on_wayland_gets_both_settings() {
        assert_eq!(gpu_rendering_settings(true, true, |_| false), BOTH);
    }

    #[test]
    fn other_gpus_and_x11_are_left_alone() {
        assert!(gpu_rendering_settings(false, true, |_| false).is_empty());
        assert!(gpu_rendering_settings(true, false, |_| false).is_empty());
    }

    #[test]
    fn an_existing_rendering_choice_wins() {
        for choice in RENDERING_CHOICES {
            let settings = gpu_rendering_settings(true, true, |name| name == choice);
            assert!(settings.is_empty(), "{choice}");
        }
    }

    #[test]
    fn an_existing_explicit_sync_choice_is_kept() {
        let settings = gpu_rendering_settings(true, true, |name| name == DISABLE_EXPLICIT_SYNC);
        assert_eq!(settings, [FORCE_DMABUF_RENDERER]);
    }

    #[test]
    fn wayland_needs_a_display_and_no_other_backend_first() {
        let display = Some(OsStr::new("wayland-1"));
        assert!(uses_wayland(display, None));
        assert!(uses_wayland(display, Some(OsStr::new("wayland,x11,*"))));
        assert!(!uses_wayland(display, Some(OsStr::new("x11"))));
        assert!(!uses_wayland(None, None));
    }
}
