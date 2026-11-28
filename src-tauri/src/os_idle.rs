/// Machine-wide input on supported desktops; other platforms use app activity.
#[tauri::command]
pub fn get_os_idle_seconds() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        macos_idle_seconds()
    }
    #[cfg(windows)]
    {
        user_idle::UserIdle::get_time()
            .ok()
            .map(|idle| idle.as_seconds())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// `user-idle`'s macOS backend releases an IOKit Mach port twice, which current
/// macOS kills as a guarded-port violation (EXC_GUARD). Quartz reports the same
/// session-wide idle time without touching Mach ports.
#[cfg(target_os = "macos")]
fn macos_idle_seconds() -> Option<u64> {
    // kCGEventSourceStateCombinedSessionState
    const COMBINED_SESSION_STATE: i32 = 0;
    // kCGAnyInputEventType, ((CGEventType)(~0))
    const ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }

    // SAFETY: plain C call with value arguments and no retained resources.
    let seconds = unsafe {
        CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT_TYPE)
    };
    seconds.is_finite().then(|| seconds.max(0.0) as u64)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn macos_idle_query_returns_without_crashing() {
        // The old backend killed the process with EXC_GUARD on this call.
        assert!(super::macos_idle_seconds().is_some());
    }
}
