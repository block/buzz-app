//! Native-only credential entry. Neither the value nor a field handle crosses IPC.
use crate::reviewed_invocation::{Invocations, Retirement};
use zeroize::Zeroizing;

const UNAVAILABLE: &str = "Private credential entry is unavailable";

/// Runs one native dialog under the call's owner; both steps share this fence.
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))] // Compile AppKit, but tests never open real private input.
async fn on_main<R: tauri::Runtime, T: Send + 'static>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    dialog: impl FnOnce(&str) -> Result<Option<T>, String> + Send + 'static,
) -> Result<Option<T>, String> {
    // Aborting the IPC future must close its dialog, but must not acknowledge
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
            dialog(&call)
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

/// Before anything is cleared: `None` means the user kept the slot as it was.
#[cfg(all(not(test), target_os = "macos"))]
pub(super) async fn confirm<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    label: String,
    owner: Retirement,
) -> Result<Option<Retirement>, String> {
    on_main(app, state, call, move |call| {
        macos::confirm(call, &label).map(|go| go.then_some(owner))
    })
    .await
}

#[cfg(all(not(test), target_os = "macos"))]
pub(super) async fn enter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    label: String,
    owner: Retirement,
) -> Result<Option<(Zeroizing<String>, Retirement)>, String> {
    on_main(app, state, call, move |call| {
        macos::show(call, &label).map(|value| value.map(|value| (value, owner)))
    })
    .await
}

#[cfg(all(not(test), not(target_os = "macos")))]
pub(super) async fn confirm<R: tauri::Runtime>(
    _: tauri::AppHandle<R>,
    _: Invocations,
    _: String,
    _: String,
    _: Retirement,
) -> Result<Option<Retirement>, String> {
    Err(UNAVAILABLE.into())
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
type FixtureEntry<T> = (
    std::sync::mpsc::Sender<()>,
    tokio::sync::oneshot::Receiver<T>,
);

/// A fake dialog: signals when shown, then waits for the test's answer.
#[cfg(test)]
pub(super) struct FixtureDialog<T>(pub std::sync::Mutex<Option<FixtureEntry<T>>>);
#[cfg(test)]
pub(super) type FixtureInput = FixtureDialog<Option<String>>;

#[cfg(test)]
async fn fixture<R: tauri::Runtime, T: Send + Sync + 'static>(
    app: &tauri::AppHandle<R>,
    state: &Invocations,
    call: &str,
) -> Result<Option<T>, String> {
    use tauri::Manager as _;
    let (shown, answer) = app
        .try_state::<FixtureDialog<T>>()
        .and_then(|fixture| fixture.0.lock().ok()?.take())
        .ok_or(UNAVAILABLE)?;
    if !state.try_live(call) {
        return Err(UNAVAILABLE.into());
    }
    // A pre-answered dialog may have no observer.
    let _ = shown.send(());
    let signal = state.retirement_signal(call)?;
    tokio::select! {
        answer = answer => answer.map(Some).map_err(|_| UNAVAILABLE.to_owned()),
        _ = signal.notified() => Ok(None),
    }
}

#[cfg(test)]
pub(super) async fn confirm<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    _: String,
    owner: Retirement,
) -> Result<Option<Retirement>, String> {
    Ok(fixture::<_, bool>(&app, &state, &call)
        .await?
        .filter(|go| *go)
        .map(|_| owner))
}

#[cfg(test)]
pub(super) async fn enter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Invocations,
    call: String,
    _: String,
    owner: Retirement,
) -> Result<Option<(Zeroizing<String>, Retirement)>, String> {
    fixture::<_, Option<String>>(&app, &state, &call)
        .await?
        .flatten()
        .map(|value| buzzodz_plugins::secrets::valid_value(&value).map(|value| (value, owner)))
        .transpose()
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
        // displayed dialog; Invocations remains the sole admission/lifetime owner.
        static ACTIVE: RefCell<Option<(String, Retained<NSAlert>)>> = const { RefCell::new(None) };
    }

    pub(super) fn cancel(call: &str) {
        let Some(main) = MainThreadMarker::new() else {
            return;
        };
        ACTIVE.with_borrow(|active| {
            if let Some((_, alert)) = active.as_ref().filter(|(id, _)| id == call) {
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

    /// One dialog at a time, cancellable by its call; true only for the first button.
    fn run(call: &str, alert: &Retained<NSAlert>) -> bool {
        ACTIVE.with_borrow_mut(|active| *active = Some((call.into(), alert.clone())));
        let response = alert.runModal();
        ACTIVE.with_borrow_mut(|active| *active = None);
        response == NSAlertFirstButtonReturn
    }

    fn alert(
        main: MainThreadMarker,
        title: &str,
        text: &str,
        accept: &str,
    ) -> Result<Retained<NSAlert>, String> {
        if ACTIVE.with_borrow(|active| active.is_some()) {
            return Err(UNAVAILABLE.into());
        }
        let alert = NSAlert::new(main);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(text));
        alert.addButtonWithTitle(&NSString::from_str(accept));
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        Ok(alert)
    }

    pub(super) fn confirm(call: &str, label: &str) -> Result<bool, String> {
        let main = MainThreadMarker::new().ok_or(UNAVAILABLE)?;
        let alert = alert(
            main,
            "Replace integration credential?",
            &format!("{label}\nContinuing removes any saved credential for this slot. If you cancel the next entry, it stays empty."),
            "Continue and clear",
        )?;
        Ok(run(call, &alert))
    }

    pub(super) fn show(call: &str, label: &str) -> Result<Option<Zeroizing<String>>, String> {
        let main = MainThreadMarker::new().ok_or(UNAVAILABLE)?;
        let alert = alert(
            main,
            "Save integration credential",
            &format!("{label}\nAny previous credential for this slot was removed. Saved in this Mac's credential store across restarts. Buzz uses it only for this integration's declared requests. This does not test the key or approve generation. Cancel leaves the slot empty."),
            "Save",
        )?;
        let field = NSSecureTextField::initWithFrame(
            NSSecureTextField::alloc(main),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(360.0, 24.0)),
        );
        alert.setAccessoryView(Some(&field));
        let value = run(call, &alert).then(|| Zeroizing::new(field.stringValue().to_string()));
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
