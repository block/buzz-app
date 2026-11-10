//! App-lifetime clipboard ownership keeps copied content available on Linux.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use tauri::Manager as _;
use zeroize::Zeroizing;

#[derive(Default)]
pub(crate) struct Clipboard(Mutex<Option<arboard::Clipboard>>, Secrets);

/// Counts successful secret copies: only the latest one's timer may clear.
/// Read and written on the main thread with the clipboard held.
#[derive(Default)]
struct Secrets(AtomicU64);

impl Clipboard {
    pub(crate) fn release(&self) {
        if let Ok(mut clipboard) = self.0.lock() {
            clipboard.take();
        }
    }
}

async fn write<R: tauri::Runtime, T: Send + 'static>(
    app: &tauri::AppHandle<R>,
    set: impl FnOnce(&mut arboard::Clipboard, &Secrets) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let state = handle.state::<Clipboard>();
            let mut stored = state
                .0
                .lock()
                .map_err(|_| "Clipboard unavailable".to_owned())?;
            if stored.is_none() {
                *stored = Some(
                    arboard::Clipboard::new().map_err(|_| "Clipboard unavailable".to_owned())?,
                );
            }
            set(stored.as_mut().expect("clipboard initialized"), &state.1)
        })();
        let _ = send.send(result);
    })
    .map_err(|_| "Clipboard unavailable".to_owned())?;
    receive
        .await
        .map_err(|_| "Clipboard unavailable".to_owned())?
}

pub(crate) async fn write_image<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    width: usize,
    height: usize,
    bytes: Vec<u8>,
) -> Result<(), String> {
    write(app, move |clipboard, _| {
        clipboard
            .set_image(arboard::ImageData {
                width,
                height,
                bytes: std::borrow::Cow::Owned(bytes),
            })
            .map_err(|_| "Could not copy image".to_owned())
    })
    .await
}

/// WebKit rejects `navigator.clipboard` writes without transient user
/// activation, and each host script evaluation (how Tauri delivers events and
/// channel messages) clears it. A click that races host traffic then fails to
/// copy, so macOS text copies go through the host clipboard instead.
///
/// `clear_after_secs` is for secrets such as a private key: see `copy_secret`
/// and `clear_secret`. The wait is at most 10 minutes; quitting cancels it.
#[tauri::command]
pub(crate) async fn clipboard_write_text<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    text: String,
    clear_after_secs: Option<u64>,
) -> Result<(), String> {
    let Some(secs) = clear_after_secs else {
        return write(&app, move |clipboard, _| {
            clipboard
                .set_text(text)
                .map_err(|_| "Could not copy text".to_owned())
        })
        .await;
    };
    let text = Zeroizing::new(text);
    let copied = text.clone();
    let generation = write(&app, move |clipboard, secrets| {
        copy_secret(clipboard, secrets, &text).map_err(|_| "Could not copy text".to_owned())
    })
    .await?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(secs.min(600))).await;
        let _ = write(&app, move |clipboard, secrets| {
            clear_secret(clipboard, secrets, generation, &copied);
            Ok(())
        })
        .await;
    });
    Ok(())
}

/// The clipboard operations a secret copy needs, so tests can stand in for the OS.
trait Board {
    /// Sets text marked as sensitive: macOS and Linux clipboard managers skip
    /// it, and Windows keeps it out of clipboard history and cloud sync.
    fn set_secret(&mut self, text: &str) -> Result<(), arboard::Error>;
    fn text(&mut self) -> Result<String, arboard::Error>;
    fn clear(&mut self) -> Result<(), arboard::Error>;
}

impl Board for arboard::Clipboard {
    fn set_secret(&mut self, text: &str) -> Result<(), arboard::Error> {
        let set = self.set();
        #[cfg(target_os = "macos")]
        let set = arboard::SetExtApple::exclude_from_history(set);
        #[cfg(windows)]
        let set = arboard::SetExtWindows::exclude_from_monitoring(set);
        #[cfg(all(unix, not(target_os = "macos")))]
        let set = arboard::SetExtLinux::exclude_from_history(set);
        set.text(text)
    }
    fn text(&mut self) -> Result<String, arboard::Error> {
        self.get_text()
    }
    fn clear(&mut self) -> Result<(), arboard::Error> {
        arboard::Clipboard::clear(self)
    }
}

/// Copies a secret and returns its generation. Only a copy that was written
/// counts, so a failed copy leaves the earlier copy's clear in place.
fn copy_secret(
    board: &mut impl Board,
    secrets: &Secrets,
    text: &str,
) -> Result<u64, arboard::Error> {
    board.set_secret(text)?;
    Ok(secrets.0.fetch_add(1, Ordering::SeqCst) + 1)
}

/// Best effort: clears the clipboard if no later secret copy restarted the
/// wait and it still holds `copied`. Another app can still write between the
/// read and the clear; an unreadable clipboard is left alone.
fn clear_secret(board: &mut impl Board, secrets: &Secrets, generation: u64, copied: &str) {
    if secrets.0.load(Ordering::SeqCst) != generation {
        return;
    }
    let unchanged = board
        .text()
        .map(Zeroizing::new)
        .is_ok_and(|now| now.as_str() == copied);
    if unchanged {
        let _ = board.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        text: Option<String>,
        refuse: bool,
    }
    impl Board for Fake {
        fn set_secret(&mut self, text: &str) -> Result<(), arboard::Error> {
            if self.refuse {
                return Err(arboard::Error::ClipboardOccupied);
            }
            self.text = Some(text.to_owned());
            Ok(())
        }
        fn text(&mut self) -> Result<String, arboard::Error> {
            self.text.clone().ok_or(arboard::Error::ContentNotAvailable)
        }
        fn clear(&mut self) -> Result<(), arboard::Error> {
            self.text = None;
            Ok(())
        }
    }

    #[test]
    fn a_secret_copy_is_cleared_once_its_wait_ends() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        clear_secret(&mut board, &secrets, first, "nsec1key");
        assert_eq!(board.text, None);
    }

    #[test]
    fn copying_the_same_key_again_restarts_the_wait() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        let second = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        clear_secret(&mut board, &secrets, first, "nsec1key");
        assert_eq!(board.text.as_deref(), Some("nsec1key"));
        clear_secret(&mut board, &secrets, second, "nsec1key");
        assert_eq!(board.text, None);
    }

    #[test]
    fn a_failed_copy_leaves_the_earlier_copys_clear_in_place() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        board.refuse = true;
        assert!(copy_secret(&mut board, &secrets, "nsec1key").is_err());
        clear_secret(&mut board, &secrets, first, "nsec1key");
        assert_eq!(board.text, None);
    }

    #[test]
    fn anything_else_on_the_clipboard_is_left_alone() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        board.text = Some("something else".into());
        clear_secret(&mut board, &secrets, first, "nsec1key");
        assert_eq!(board.text.as_deref(), Some("something else"));
        board.text = None;
        clear_secret(&mut board, &secrets, first, "nsec1key");
        assert_eq!(board.text, None);
    }
}
