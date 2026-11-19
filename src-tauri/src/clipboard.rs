//! App-lifetime clipboard ownership keeps copied content available on Linux.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

use sha2::{Digest as _, Sha256};
use tauri::Manager as _;
use zeroize::Zeroizing;

#[derive(Default)]
pub(crate) struct Clipboard(Mutex<Option<arboard::Clipboard>>, Secrets);

/// Counts successful secret copies: only the latest one's timer may clear.
/// Written on the main thread with the clipboard held.
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

/// The main composer's trusted Paste event can report Files without exposing
/// an image to WKWebView. Read only native image representations in that case.
#[tauri::command]
pub(crate) async fn clipboard_read_pasted_image<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<tauri::ipc::Response, String> {
    let png = if window.label() == "main" {
        read_pasted_image(&window).await?
    } else {
        Vec::new()
    };
    Ok(tauri::ipc::Response::new(png))
}

#[cfg(target_os = "macos")]
thread_local! {
    static PASTE_ACTION: std::cell::Cell<Option<(isize, std::time::Instant)>> =
        const { std::cell::Cell::new(None) };
}

/// AppKit sends this for Edit → Paste and its keyboard equivalent before
/// WebKit dispatches the paste event. The webview cannot arm the clipboard read.
#[cfg(target_os = "macos")]
pub(crate) fn observe_paste_actions() {
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSMenuItem, NSMenuWillSendActionNotification, NSPasteboard};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};

    let handler = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
        if MainThreadMarker::new().is_none() {
            return;
        }
        // SAFETY: AppKit supplies the live notification for this callback.
        let note = unsafe { note.as_ref() };
        let action = note
            .userInfo()
            .and_then(|info| info.objectForKey(&NSString::from_str("MenuItem")))
            .and_then(|item| item.downcast::<NSMenuItem>().ok())
            .and_then(|item| item.action());
        if action == Some(sel!(paste:)) {
            PASTE_ACTION.set(crate::browser::focused_session().is_none().then(|| {
                (
                    NSPasteboard::generalPasteboard().changeCount(),
                    std::time::Instant::now(),
                )
            }));
        }
    });
    // SAFETY: AppKit posts menu actions on the main thread, and the observer
    // uses the posting thread without a queue.
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSMenuWillSendActionNotification),
            None,
            None,
            &handler,
        )
    };
    // The app menu and its observer live for the process.
    std::mem::forget(token);
}

#[cfg(not(target_os = "macos"))]
async fn read_pasted_image<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<Vec<u8>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
async fn read_pasted_image<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Vec<u8>, String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    const MAX_ENCODED_BYTES: usize = 50 * 1024 * 1024;
    let (send, receive) = tokio::sync::oneshot::channel();
    let focused_window = window.clone();
    window
        .run_on_main_thread(move || {
            let read = || {
                if !focused_window.is_focused().unwrap_or(false) {
                    return Ok(None);
                }
                let board = NSPasteboard::generalPasteboard();
                let count = board.changeCount();
                if !PASTE_ACTION.take().is_some_and(|(expected, time)| {
                    expected == count && time.elapsed() < std::time::Duration::from_secs(2)
                }) {
                    return Ok(None);
                }
                if board.types().is_some_and(|types| {
                    types
                        .iter()
                        .any(|kind| kind.to_string() == "public.file-url")
                }) {
                    return Ok(None);
                }
                let image = ["public.heic", "public.tiff"]
                    .into_iter()
                    .find_map(|kind| board.dataForType(&NSString::from_str(kind)));
                if board.changeCount() != count {
                    return Ok(None);
                }
                match image {
                    Some(image) if image.len() > MAX_ENCODED_BYTES => {
                        Err("The clipboard image is too large to paste")
                    }
                    Some(image) => Ok(Some(image.to_vec())),
                    None => Ok(None),
                }
            };
            let _ = send.send(read());
        })
        .map_err(|_| "Could not read the clipboard")?;
    let Some(image) = receive
        .await
        .map_err(|_| "Could not read the clipboard")??
    else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || pasted_image_png(image, MAX_ENCODED_BYTES))
        .await
        .map_err(|_| "Could not decode the clipboard image".to_owned())?
}

#[cfg(target_os = "macos")]
fn pasted_image_png(bytes: Vec<u8>, max_encoded_bytes: usize) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_core_image::CIImage;
    use objc2_foundation::{NSData, NSDictionary};

    const MAX_PIXELS: isize = 25_000_000;
    objc2::rc::autoreleasepool(|_| {
        let data = NSData::from_vec(bytes);
        // SAFETY: The immutable NSData lives through both calls. Core Image
        // describes the image bounds without rendering the bitmap.
        let bounds = unsafe { CIImage::imageWithData(&data).map(|image| image.extent()) }
            .ok_or("Could not decode the clipboard image")?;
        let pixels = bounds.size.width * bounds.size.height;
        if !(1.0..=MAX_PIXELS as f64).contains(&pixels) {
            return Err("The clipboard image is too large to paste".into());
        }
        let bitmap = NSBitmapImageRep::imageRepWithData(&data)
            .ok_or("Could not decode the clipboard image")?;
        let pixels = bitmap.pixelsWide().checked_mul(bitmap.pixelsHigh());
        if !pixels.is_some_and(|count| (1..=MAX_PIXELS).contains(&count)) {
            return Err("The clipboard image is too large to paste".into());
        }
        // SAFETY: PNG encoding accepts an empty options dictionary.
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or("Could not convert the clipboard image")?;
        if png.len() > max_encoded_bytes {
            return Err("The clipboard image is too large to paste".into());
        }
        Ok(png.to_vec())
    })
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
    html: Option<String>,
) -> Result<(), String> {
    if let Some(html) = html {
        if clear_after_secs.is_some() {
            return Err("Rich secret copies are not supported".to_owned());
        }
        return write(&app, move |clipboard, _| {
            clipboard
                .set_html(html, Some(text))
                .map_err(|_| "Could not copy message".to_owned())
        })
        .await;
    }
    let Some(secs) = clear_after_secs else {
        return write(&app, move |clipboard, _| {
            clipboard
                .set_text(text)
                .map_err(|_| "Could not copy text".to_owned())
        })
        .await;
    };
    let text = Zeroizing::new(text);
    let copied = fingerprint(&text);
    let generation = write(&app, move |clipboard, secrets| {
        copy_secret(clipboard, secrets, &text).map_err(|_| "Could not copy text".to_owned())
    })
    .await?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(secs.min(600))).await;
        if !READ_OFF_MAIN_THREAD {
            let _ = write(&app, move |clipboard, secrets| {
                clear_secret(clipboard, secrets, generation, &copied);
                Ok(())
            })
            .await;
            return;
        }
        if app.state::<Clipboard>().1 .0.load(Ordering::SeqCst) != generation {
            return;
        }
        let Some(reading) = Reading::begin(&READING) else {
            return;
        };
        // The worker gets only the fingerprint: a read that never returns
        // can't be stopped, so it must not hold the key.
        let read = tauri::async_runtime::spawn_blocking(move || {
            let _reading = reading;
            arboard::Clipboard::new()
                .ok()
                .is_some_and(|mut board| holds(&mut board, &copied))
        });
        // A clipboard owner that never answers leaves the key in place.
        let unchanged = matches!(
            tokio::time::timeout(std::time::Duration::from_secs(10), read).await,
            Ok(Ok(true))
        );
        if unchanged {
            let _ = write(&app, move |clipboard, secrets| {
                clear_if_latest(clipboard, secrets, generation);
                Ok(())
            })
            .await;
        }
    });
    Ok(())
}

/// On Linux the clipboard owner can be this app's own GTK main loop: a copy
/// inside Buzz after the key makes WebKitGTK the owner. A read on that loop
/// would wait on itself (arboard waits up to 4 s on X11, without limit on
/// Wayland), so the expiry check reads from a worker with its own handle and
/// only the clear runs on the main thread.
const READ_OFF_MAIN_THREAD: bool = cfg!(all(unix, not(target_os = "macos")));

/// Set while an expiry read runs. A blocking read can't be stopped, and a
/// Wayland owner that never finishes a transfer holds it forever, so later
/// checks leave the clipboard alone instead of stacking workers behind it.
static READING: AtomicBool = AtomicBool::new(false);

/// Holds `READING` until dropped.
struct Reading(&'static AtomicBool);
impl Reading {
    /// `None` while another read holds `flag`. A guard exists only once the
    /// flag is taken, so a refusal leaves the holder's flag set.
    fn begin(flag: &'static AtomicBool) -> Option<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Self(flag))
        }
    }
}
impl Drop for Reading {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// What the expiry check compares the clipboard against, so the copied key
/// itself isn't kept for the wait.
type Fingerprint = [u8; 32];
fn fingerprint(text: &str) -> Fingerprint {
    Sha256::digest(text.as_bytes()).into()
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
fn clear_secret(board: &mut impl Board, secrets: &Secrets, generation: u64, copied: &Fingerprint) {
    if secrets.0.load(Ordering::SeqCst) == generation && holds(board, copied) {
        clear_if_latest(board, secrets, generation);
    }
}

/// Whether the clipboard still holds the text `copied` fingerprints;
/// unreadable counts as no.
fn holds(board: &mut impl Board, copied: &Fingerprint) -> bool {
    board
        .text()
        .map(Zeroizing::new)
        .is_ok_and(|now| fingerprint(&now) == *copied)
}

/// Clears unless a later secret copy restarted the wait.
fn clear_if_latest(board: &mut impl Board, secrets: &Secrets, generation: u64) {
    if secrets.0.load(Ordering::SeqCst) == generation {
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
        clear_secret(&mut board, &secrets, first, &fingerprint("nsec1key"));
        assert_eq!(board.text, None);
    }

    #[test]
    fn copying_the_same_key_again_restarts_the_wait() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        let second = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        clear_secret(&mut board, &secrets, first, &fingerprint("nsec1key"));
        assert_eq!(board.text.as_deref(), Some("nsec1key"));
        clear_secret(&mut board, &secrets, second, &fingerprint("nsec1key"));
        assert_eq!(board.text, None);
    }

    #[test]
    fn a_failed_copy_leaves_the_earlier_copys_clear_in_place() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        board.refuse = true;
        assert!(copy_secret(&mut board, &secrets, "nsec1key").is_err());
        clear_secret(&mut board, &secrets, first, &fingerprint("nsec1key"));
        assert_eq!(board.text, None);
    }

    #[test]
    fn the_split_check_still_spares_a_later_copy() {
        // Linux reads off the main thread, then clears on it: a copy that
        // lands between the two keeps its own wait.
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        assert!(holds(&mut board, &fingerprint("nsec1key")));
        copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        clear_if_latest(&mut board, &secrets, first);
        assert_eq!(board.text.as_deref(), Some("nsec1key"));
        board.text = None;
        assert!(!holds(&mut board, &fingerprint("nsec1key")));
    }

    #[test]
    fn anything_else_on_the_clipboard_is_left_alone() {
        let (mut board, secrets) = (Fake::default(), Secrets::default());
        let first = copy_secret(&mut board, &secrets, "nsec1key").unwrap();
        board.text = Some("something else".into());
        clear_secret(&mut board, &secrets, first, &fingerprint("nsec1key"));
        assert_eq!(board.text.as_deref(), Some("something else"));
        board.text = None;
        clear_secret(&mut board, &secrets, first, &fingerprint("nsec1key"));
        assert_eq!(board.text, None);
    }

    #[test]
    fn only_one_expiry_read_runs_at_a_time() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let stuck = Reading::begin(&FLAG).unwrap();
        // A refused admission must not release the read that holds the flag.
        assert!(Reading::begin(&FLAG).is_none());
        assert!(Reading::begin(&FLAG).is_none());
        drop(stuck);
        assert!(Reading::begin(&FLAG).is_some());
    }
}
