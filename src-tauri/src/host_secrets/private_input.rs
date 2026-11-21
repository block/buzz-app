//! Native-only credential entry. Neither the value nor a field handle crosses IPC.
use crate::reviewed_invocation::{Invocations, Retirement};
use zeroize::Zeroizing;

const UNAVAILABLE: &str = "Private credential entry is unavailable";

#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))] // Compile AppKit, but tests never open real private input.
async fn enter_native<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    label: String,
    owner: Retirement,
) -> Result<Option<(Zeroizing<String>, Retirement)>, String> {
    // Aborting the IPC future must close its field, but must not acknowledge
    // completion before the queued/running main-thread owner actually returns.
    struct CancelOnDrop(Invocations, String, bool);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            if self.2 {
                self.0.cancel(&self.1);
            }
        }
    }
    let mut cancellation = CancelOnDrop(state.clone(), call.clone(), true);
    let signal = state.retirement_signal(&call)?;
    let (finished, completion) = tokio::sync::oneshot::channel::<()>();
    let closer = app.clone();
    let close_call = call.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = completion => {},
            _ = signal.notified() => {
                let _ = closer.run_on_main_thread(move || macos::cancel(&close_call));
            },
        }
    });
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = if state.try_live(&call) && !send.is_closed() {
            macos::show(&call, &label).map(|value| value.map(|value| (value, owner)))
        } else {
            Err(UNAVAILABLE.to_owned())
        };
        let _ = finished.send(());
        let _ = send.send(result);
    })
    .map_err(|_| UNAVAILABLE)?;
    let result = receive.await.map_err(|_| UNAVAILABLE)?;
    cancellation.2 = false;
    result
}

#[cfg(all(not(test), target_os = "macos"))]
pub(super) async fn enter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    label: String,
    owner: Retirement,
) -> Result<Option<(Zeroizing<String>, Retirement)>, String> {
    enter_native(app, state, call, label, owner).await
}

#[cfg(all(not(test), not(target_os = "macos")))]
pub(super) async fn enter<R: tauri::Runtime>(
    _: tauri::AppHandle<R>,
    _: Invocations,
    _: String,
    _: String,
    _: Retirement,
) -> Result<Option<(Zeroizing<String>, Retirement)>, String> {
    Err(UNAVAILABLE.into())
}

#[cfg(test)]
type FixtureEntry = (
    std::sync::mpsc::Sender<()>,
    tokio::sync::oneshot::Receiver<Option<String>>,
);

#[cfg(test)]
#[derive(Default)]
pub(super) struct FixtureInput(pub std::sync::Mutex<Option<FixtureEntry>>);

#[cfg(test)]
pub(super) async fn enter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    _: String,
    owner: Retirement,
) -> Result<Option<(Zeroizing<String>, Retirement)>, String> {
    use tauri::Manager as _;
    let (started, input) = app
        .try_state::<FixtureInput>()
        .and_then(|fixture| fixture.0.lock().ok()?.take())
        .ok_or(UNAVAILABLE)?;
    if !state.try_live(&call) {
        return Err(UNAVAILABLE.into());
    }
    started.send(()).map_err(|_| UNAVAILABLE)?;
    let signal = state.retirement_signal(&call)?;
    tokio::select! {
        value = input => value.map_err(|_| UNAVAILABLE.to_owned())?
            .map(|value| buzzodz_plugins::secrets::valid_value(&value).map(|value| (value, owner))).transpose(),
        _ = signal.notified() => Ok(None),
    }
}

#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))] // The registered fake-input checks do not exercise AppKit.
mod macos {
    use super::*;
    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication, NSSecureTextField};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use std::cell::RefCell;

    thread_local! {
        // AppKit objects stay on the main thread. This is only the currently
        // displayed field; Invocations remains the sole admission/lifetime owner.
        static FIELD: RefCell<Option<(String, Retained<NSAlert>)>> = const { RefCell::new(None) };
    }

    pub(super) fn cancel(call: &str) {
        let Some(main) = MainThreadMarker::new() else {
            return;
        };
        FIELD.with_borrow(|field| {
            if let Some((_, alert)) = field.as_ref().filter(|(id, _)| id == call) {
                let application = NSApplication::sharedApplication(main);
                if application
                    .modalWindow()
                    .as_deref()
                    .is_some_and(|window| std::ptr::eq(window, &*alert.window()))
                {
                    application.abortModal();
                    alert.window().orderOut(None);
                }
            }
        });
    }

    pub(super) fn show(call: &str, label: &str) -> Result<Option<Zeroizing<String>>, String> {
        let main = MainThreadMarker::new().ok_or(UNAVAILABLE)?;
        if FIELD.with_borrow(|field| field.is_some()) {
            return Err(UNAVAILABLE.into());
        }
        let alert = NSAlert::new(main);
        alert.setMessageText(&NSString::from_str("Save integration credential"));
        alert.setInformativeText(&NSString::from_str(&format!(
            "{label}\nSaved in this Mac's credential store across restarts. Buzz uses it only for this integration's declared requests. This does not test the key or approve generation. Cancel leaves no new saved credential."
        )));
        alert.addButtonWithTitle(&NSString::from_str("Save"));
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        let field = NSSecureTextField::initWithFrame(
            NSSecureTextField::alloc(main),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(360.0, 24.0)),
        );
        alert.setAccessoryView(Some(&field));
        FIELD.with_borrow_mut(|active| *active = Some((call.into(), alert.clone())));
        let response = alert.runModal();
        FIELD.with_borrow_mut(|active| *active = None);
        let value = (response == NSAlertFirstButtonReturn)
            .then(|| Zeroizing::new(field.stringValue().to_string()));
        field.setStringValue(&NSString::from_str(""));
        // Clearing the field and zeroizing Rust buffers does not promise that
        // AppKit's internal editing/string copies are securely erased.
        value
            .map(|value| buzzodz_plugins::secrets::valid_value(&value))
            .transpose()
            .map_err(|_| {
                "The credential must be a nonempty, single-line value of at most 512 bytes".into()
            })
    }
}
