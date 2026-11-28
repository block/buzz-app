//! The OS input mute for the person's own Huddle. On macOS 14+ AirPods and
//! Beats mute gestures and the Huddle button both go through
//! `AVAudioApplication`, so the button, the menu bar indicator and the
//! headset's chimes agree. Elsewhere `start` returns `None` and Huddles keep
//! only their own mute.
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;

static TOKENS: AtomicU64 = AtomicU64::new(0);

/// Takes the OS input mute for one call, replacing any earlier holder.
#[tauri::command]
pub(crate) fn input_mute_start(changes: Channel<bool>) -> Option<u64> {
    let token = TOKENS.fetch_add(1, Ordering::SeqCst) + 1;
    platform::start(token, move |muted| {
        let _ = changes.send(muted);
    })
    .map_err(|error| eprintln!("system input mute is unavailable: {error}"))
    .ok()
    .map(|()| token)
}

#[tauri::command]
pub(crate) fn input_mute_set(muted: bool) -> Result<(), String> {
    platform::set(muted)
}

/// Releases the OS input mute if `token` still holds it.
#[tauri::command]
pub(crate) fn input_mute_stop(token: u64) {
    platform::stop(Some(token));
}

/// The main document went away, so no call can still hold the mute.
pub(crate) fn release() {
    platform::stop(None);
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2::{
        available, exception,
        rc::Retained,
        runtime::{Bool, ProtocolObject},
    };
    use objc2_avf_audio::{
        AVAudioApplication, AVAudioApplicationRecordPermission, AVAudioEngine,
        AVAudioEngineConfigurationChangeNotification, AVAudioPCMBuffer, AVAudioTime,
    };
    use objc2_foundation::{
        NSError, NSNotification, NSNotificationCenter, NSObjectProtocol, NSString,
    };
    use std::ffi::{c_char, c_void};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    type Observer = Retained<ProtocolObject<dyn NSObjectProtocol>>;
    struct Holder {
        token: u64,
        engine: Option<Retained<AVAudioEngine>>,
        observers: Vec<Observer>,
    }
    // SAFETY: the engine and observer tokens are only used under HOLDER's lock.
    unsafe impl Send for Holder {}
    static HOLDER: Mutex<Option<Holder>> = Mutex::new(None);
    static RESTARTS: AtomicU64 = AtomicU64::new(0);

    fn application() -> Result<Retained<AVAudioApplication>, String> {
        if !available!(macos = 14.0) {
            return Err("needs macOS 14".into());
        }
        // SAFETY: AVAudioApplication is public API from macOS 14.
        Ok(unsafe { AVAudioApplication::sharedInstance() })
    }
    fn text(error: Retained<NSError>) -> String {
        error.localizedDescription().to_string()
    }

    pub(super) fn start(token: u64, change: impl Fn(bool) + 'static) -> Result<(), String> {
        let app = application()?;
        let mut holder = HOLDER.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = holder.take() {
            release(previous, &app);
        }
        let handler = RcBlock::new(move |muted: Bool| {
            change(muted.as_bool());
            Bool::YES
        });
        // SAFETY: the block has the declared signature, and AVFAudio copies it.
        unsafe { app.setInputMuteStateChangeHandler_error(Some(&handler)) }.map_err(text)?;
        // macOS only accepts a mute once a handler is set. Calls start unmuted.
        if let Err(error) = unsafe { app.setInputMuted_error(false) } {
            let _ = unsafe { app.setInputMuteStateChangeHandler_error(None) };
            return Err(text(error));
        }
        let center = NSNotificationCenter::defaultCenter();
        let mut observers = Vec::new();
        // Restart the input when the device changes, such as AirPods connecting.
        let restart = RcBlock::new(move |_: NonNull<NSNotification>| {
            let restart = RESTARTS.fetch_add(1, Ordering::SeqCst) + 1;
            std::thread::spawn(move || restart_capture(token, restart));
        });
        // SAFETY: the name is AVFAudio's static and the block outlives no state.
        observers.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(AVAudioEngineConfigurationChangeNotification),
                None,
                None,
                &restart,
            )
        });
        // Observing the mute notification opts the app into headset gestures.
        // It is new in macOS 14, so look it up rather than link it.
        if let Some(name) = mute_notification() {
            let read = RcBlock::new(|_: NonNull<NSNotification>| {
                let _ = application().map(|app| unsafe { app.isInputMuted() });
            });
            observers.push(unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &read)
            });
        }
        let engine = capture()
            .map_err(|error| eprintln!("headset mute gestures are unavailable: {error}"))
            .ok();
        *holder = Some(Holder {
            token,
            engine,
            observers,
        });
        Ok(())
    }

    pub(super) fn set(muted: bool) -> Result<(), String> {
        let app = application()?;
        let holder = HOLDER.lock().map_err(|e| e.to_string())?;
        if holder.is_none() {
            return Err("no Huddle holds the input mute".into());
        }
        // SAFETY: a handler is registered while a holder exists.
        unsafe { app.setInputMuted_error(muted) }.map_err(text)
    }

    pub(super) fn stop(token: Option<u64>) {
        let Ok(app) = application() else { return };
        let Ok(mut holder) = HOLDER.lock() else {
            return;
        };
        if holder
            .as_ref()
            .is_some_and(|held| token.is_none_or(|token| held.token == token))
        {
            release(holder.take().expect("checked"), &app);
        }
    }

    fn release(holder: Holder, app: &AVAudioApplication) {
        let center = NSNotificationCenter::defaultCenter();
        for observer in holder.observers {
            // SAFETY: each token came from this center.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
        if let Some(engine) = holder.engine {
            stop_capture(&engine);
        }
        // Leave nothing muted for voice notes, then hand the mute back.
        // SAFETY: nil is the documented way to remove the handler.
        unsafe {
            let _ = app.setInputMuted_error(false);
            let _ = app.setInputMuteStateChangeHandler_error(None);
        }
    }

    fn mute_notification() -> Option<&'static NSString> {
        extern "C" {
            fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        }
        const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
        // SAFETY: the symbol, when present, is a constant NSString pointer.
        unsafe {
            let symbol = dlsym(
                RTLD_DEFAULT,
                c"AVAudioApplicationInputMuteStateChangeNotification".as_ptr(),
            ) as *const *const NSString;
            symbol.as_ref().and_then(|name| name.as_ref())
        }
    }

    /// A silent input of the app's own. Headsets send mute gestures only to an
    /// app capturing audio, and WebKit captures in another process.
    fn capture() -> Result<Retained<AVAudioEngine>, String> {
        // Never prompt from here: WebKit asked when the call joined, and an
        // undecided prompt would block the input node until answered.
        if unsafe { application()?.recordPermission() }
            != AVAudioApplicationRecordPermission::Granted
        {
            return Err("no microphone access".into());
        }
        let attempt = exception::catch(|| unsafe {
            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            let format = input.outputFormatForBus(0);
            if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
                return Err("no input device".to_string());
            }
            let tap = RcBlock::new(|_: NonNull<AVAudioPCMBuffer>, _: NonNull<AVAudioTime>| {});
            input.installTapOnBus_bufferSize_format_block(
                0,
                4096,
                Some(&format),
                RcBlock::as_ptr(&tap),
            );
            engine.prepare();
            if let Err(error) = engine.startAndReturnError() {
                input.removeTapOnBus(0);
                return Err(text(error));
            }
            Ok(engine)
        });
        attempt.unwrap_or_else(|error| Err(format!("{error:?}")))
    }

    fn stop_capture(engine: &AVAudioEngine) {
        let _ = exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
            engine.inputNode().removeTapOnBus(0);
            engine.stop();
        }));
    }

    fn restart_capture(token: u64, restart: u64) {
        for _ in 0..10 {
            std::thread::sleep(Duration::from_millis(150));
            if RESTARTS.load(Ordering::SeqCst) != restart {
                return;
            }
            let Ok(mut holder) = HOLDER.lock() else {
                return;
            };
            let Some(held) = holder.as_mut().filter(|held| held.token == token) else {
                return;
            };
            if let Some(engine) = held.engine.take() {
                stop_capture(&engine);
            }
            held.engine = capture().ok();
            if held.engine.is_some() {
                return;
            }
            drop(holder);
            std::thread::sleep(Duration::from_millis(850));
        }
    }

    #[cfg(test)]
    mod tests {
        /// Needs macOS 14; run with `--ignored`.
        #[test]
        #[ignore]
        fn the_button_and_the_system_mute_report_through_one_handler() {
            use std::sync::mpsc;
            let (sender, changes) = mpsc::channel();
            super::start(1, move |muted| {
                let _ = sender.send(muted);
            })
            .unwrap();
            // Wait for one value; the OS may repeat a state it already had.
            let expect = |muted: bool| {
                while changes
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap()
                    != muted
                {}
            };
            super::set(true).unwrap();
            expect(true);
            super::set(false).unwrap();
            expect(false);
            super::stop(Some(2));
            super::set(true).expect("another call's token cannot release it");
            expect(true);
            super::stop(Some(1));
            assert!(super::set(true).is_err());
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub(super) fn start(_: u64, _: impl Fn(bool) + 'static) -> Result<(), String> {
        Err("this platform has no app input mute".into())
    }
    pub(super) fn set(_: bool) -> Result<(), String> {
        Err("this platform has no app input mute".into())
    }
    pub(super) fn stop(_: Option<u64>) {}
}
