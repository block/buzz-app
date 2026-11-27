#[cfg(target_os = "macos")]
pub(super) async fn recognize(samples: Vec<i16>) -> Result<String, String> {
    use std::ffi::{c_char, c_void, CStr};
    use tokio::sync::oneshot;

    type ResultSender = oneshot::Sender<Result<String, String>>;

    unsafe extern "C" {
        fn buzz_huddle_recognize(
            samples: *const i16,
            length: u32,
            context: *mut c_void,
            callback: extern "C" fn(*mut c_void, *const c_char, *const c_char),
        );
    }

    extern "C" fn complete(context: *mut c_void, text: *const c_char, error: *const c_char) {
        // The native operation invokes the callback exactly once and owns both
        // strings until it returns.
        let sender = unsafe { Box::from_raw(context.cast::<ResultSender>()) };
        let result = if !error.is_null() {
            Err(unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned())
        } else if !text.is_null() {
            Ok(unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned())
        } else {
            Ok(String::new())
        };
        let _ = sender.send(result);
    }

    let (send, receive) = oneshot::channel();
    // The native function copies the sample buffer before returning.
    unsafe {
        buzz_huddle_recognize(
            samples.as_ptr(),
            samples.len() as u32,
            Box::into_raw(Box::new(send)).cast(),
            complete,
        );
    }
    receive
        .await
        .map_err(|_| "Speech recognition ended".to_string())?
}

#[cfg(not(target_os = "macos"))]
pub(super) async fn recognize(_samples: Vec<i16>) -> Result<String, String> {
    Err("Huddle microphone transcription is available on macOS.".into())
}
