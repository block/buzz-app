//! The app's speech-to-text service. The webview picks the provider (see
//! `features/speech/service.ts`); native owns each provider's endpoint,
//! credentials and deadline, so every provider answers the same way or fails
//! for the same reasons.
//!
//! - Hosted providers transcribe over WebRTC. The webview holds the peer
//!   connection, since it has the microphone, and sends its SDP offer here.
//!   `speech_connect` answers it through the provider: `builderlab` posts it
//!   to the build's Builderlab (`v3/builderlab/transcription/calls`) with the
//!   same sign-in decisions send (an FI build's native NIP-FI session, or the
//!   live development broker's) and the community the call bills. Builderlab
//!   answers with OpenAI's SDP, and audio then streams peer to peer.
//! - On-device: Apple speech (`speech.swift`, linked in by build.rs) on macOS,
//!   the free fallback. It runs one listen at a time and sends its events to
//!   the webview on the channel it passed.
use crate::federated_identity::FederatedIdentity;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

mod builderlab;

/// Hints bias recognition toward the names the caller expects to hear. Beyond
/// this many (Apple's limit for contextual strings) they are dropped, as are
/// longer ones.
const HINT_LIMIT: usize = 100;
const HINT_CHARS: usize = 100;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum SpeechEvent {
    /// The microphone is on.
    Listening,
    /// The transcript so far, each time it changes.
    Text { text: String },
    /// The final transcript; nothing follows.
    Ended { text: String },
    /// Listening failed; nothing follows.
    Error { message: String },
    /// The language model is downloading, the first time only; listening
    /// follows once it's installed.
    Downloading,
    /// Microphone or speech recognition access is denied; nothing follows.
    Denied { message: String },
}

impl SpeechEvent {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn from_native(kind: i32, text: String) -> Option<Self> {
        Some(match kind {
            0 => Self::Listening,
            1 => Self::Text { text },
            2 => Self::Ended { text },
            3 => Self::Error { message: text },
            4 => Self::Downloading,
            5 => Self::Denied { message: text },
            _ => return None,
        })
    }

    fn last(&self) -> bool {
        matches!(
            self,
            Self::Ended { .. } | Self::Error { .. } | Self::Denied { .. }
        )
    }
}

/// The listen in progress and where its events go.
static CURRENT: Mutex<Option<(u64, Channel<SpeechEvent>)>> = Mutex::new(None);

fn current() -> std::sync::MutexGuard<'static, Option<(u64, Channel<SpeechEvent>)>> {
    CURRENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Delivers one event to its listen's channel, if that listen is current.
fn deliver(session: u64, event: SpeechEvent) {
    let mut current = current();
    let Some((id, channel)) = current.as_ref() else {
        return;
    };
    if *id != session {
        return;
    }
    let last = event.last();
    let _ = channel.send(event);
    if last {
        *current = None;
    }
}

/// Newline-separated hints for native code: trimmed, single-line, capped.
fn hint_lines(hints: &[String]) -> String {
    hints
        .iter()
        .map(|hint| {
            hint.split(|c: char| c.is_control())
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_owned()
        })
        .filter(|hint| !hint.is_empty() && hint.chars().count() <= HINT_CHARS)
        .take(HINT_LIMIT)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(target_os = "macos")]
mod native {
    use std::ffi::{c_char, CStr, CString};

    type Callback = extern "C" fn(u64, i32, *const c_char);

    extern "C" {
        fn buzz_speech_available() -> bool;
        fn buzz_speech_prepare();
        fn buzz_speech_start(session: u64, hints: *const c_char, callback: Callback);
        fn buzz_speech_finish(session: u64);
        fn buzz_speech_cancel(session: u64);
    }

    extern "C" fn on_event(session: u64, kind: i32, text: *const c_char) {
        let text = if text.is_null() {
            String::new()
        } else {
            // SAFETY: native code passes a NUL-terminated string that lives
            // for the duration of this call.
            unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned()
        };
        if let Some(event) = super::SpeechEvent::from_native(kind, text) {
            super::deliver(session, event);
        }
    }

    pub(super) fn available() -> bool {
        // SAFETY: takes no arguments and only reads system state.
        unsafe { buzz_speech_available() }
    }

    pub(super) fn prepare() {
        // SAFETY: takes no arguments; the work runs on a Swift task.
        unsafe { buzz_speech_prepare() }
    }

    pub(super) fn start(session: u64, hints: &str) {
        // Hint lines never hold NUL: control characters are removed.
        let hints = CString::new(hints).unwrap_or_default();
        // SAFETY: `hints` outlives the call, which copies it; `on_event` is a
        // plain function that may be called from any thread.
        unsafe { buzz_speech_start(session, hints.as_ptr(), on_event) }
    }

    pub(super) fn finish(session: u64) {
        // SAFETY: an unknown session is ignored.
        unsafe { buzz_speech_finish(session) }
    }

    pub(super) fn cancel(session: u64) {
        // SAFETY: an unknown session is ignored.
        unsafe { buzz_speech_cancel(session) }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub(super) fn available() -> bool {
        false
    }
    pub(super) fn prepare() {}
    pub(super) fn start(session: u64, _hints: &str) {
        super::deliver(
            session,
            super::SpeechEvent::Error {
                message: "Speech recognition isn't available on this device".into(),
            },
        );
    }
    pub(super) fn finish(_session: u64) {}
    pub(super) fn cancel(_session: u64) {}
}

/// Whether on-device speech recognition can run here.
#[tauri::command]
pub(crate) fn speech_on_device_available() -> bool {
    native::available()
}

/// Fetches the on-device language model ahead of listening, if needed.
#[tauri::command]
pub(crate) fn speech_on_device_prepare() {
    native::prepare();
}

/// Starts on-device listening; `hints` bias recognition toward expected
/// words. Events arrive on `on_event` until `ended`, `error` or `denied`.
#[tauri::command]
pub(crate) fn speech_on_device_start(hints: Vec<String>, on_event: Channel<SpeechEvent>) -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let session = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    *current() = Some((session, on_event));
    native::start(session, &hint_lines(&hints));
    session
}

/// Stops listening; the final transcript follows as `ended`.
#[tauri::command]
pub(crate) fn speech_on_device_finish(session: u64) {
    native::finish(session);
}

/// Stops listening without reporting anything more.
#[tauri::command]
pub(crate) fn speech_on_device_cancel(session: u64) {
    {
        let mut current = current();
        if current.as_ref().is_some_and(|(id, _)| *id == session) {
            *current = None;
        }
    }
    native::cancel(session);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Provider {
    Builderlab,
}

/// Why a hosted call did not connect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    /// No sign-in, or the build has no Builderlab.
    MissingCredentials,
    /// The provider refused this account or community.
    Unauthorized,
    /// The provider refused the offer or the community.
    InvalidRequest,
    /// The community has used its calls for now.
    RateLimited,
    Timeout,
    ServiceError,
    InvalidResponse,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum Connected {
    Answered {
        /// The provider's SDP answer to the offer.
        sdp: String,
        /// The provider hangs up this long after answering.
        #[serde(skip_serializing_if = "Option::is_none")]
        max_seconds: Option<u32>,
    },
    Failed {
        reason: Failure,
    },
}

const TIMEOUT: Duration = Duration::from_secs(20);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    /// The webview's WebRTC SDP offer.
    offer: String,
    /// The Buzz community (its relay URL) the call bills.
    #[serde(default)]
    community: Option<String>,
    /// How long the caller waits, at most 20 seconds.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// The development broker's public session, as decisions take it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DevelopmentSession {
    origin: String,
    revision: String,
}

/// The FI session `revision`, if it is still the current one, the work it
/// owns, and the transcription route under the identity origin's API.
fn federated_sign_in(
    fi: &FederatedIdentity,
    revision: &str,
) -> Option<(CancellationToken, Option<String>, builderlab::SignIn)> {
    let cancel = fi.cancellation_for(revision).ok()?;
    fi.with_session(|token, current, config| {
        (current == revision).then(|| {
            (
                cancel,
                builderlab::endpoint(&config.identity_origin, &config.api_base_path),
                builderlab::SignIn::Bearer(token.clone()),
            )
        })
    })
    .flatten()
}

/// Answers a hosted provider's WebRTC offer. An FI build names its native
/// session by `federated` revision, and the token stays here; only that
/// session may answer, so a sign-out or account switch during the call drops
/// it. A Builderlab 401 refuses this call only, and the adapter, asked once in
/// the background, decides whether the session ended. Nothing is retried.
#[tauri::command]
pub(crate) async fn speech_connect(
    fi: tauri::State<'_, FederatedIdentity>,
    provider: Provider,
    request: ConnectRequest,
    broker: Option<DevelopmentSession>,
    federated: Option<String>,
) -> Result<Connected, String> {
    let Provider::Builderlab = provider;
    let timeout = request
        .timeout_ms
        .map(Duration::from_millis)
        .map_or(TIMEOUT, |t| t.clamp(MIN_TIMEOUT, TIMEOUT));
    let missing = Connected::Failed {
        reason: Failure::MissingCredentials,
    };
    if let Some(revision) = federated {
        if broker.is_some() {
            return Err("Invalid federated session".into());
        }
        let Some((cancel, endpoint, sign_in)) = federated_sign_in(&fi, &revision) else {
            return Ok(missing);
        };
        let Some(endpoint) = endpoint else {
            return Ok(missing);
        };
        let connected = tokio::select! {
            biased;
            () = cancel.cancelled() => return Ok(missing),
            connected = builderlab::connect(&endpoint, &sign_in, &request.offer, request.community.as_deref(), timeout) => connected,
        };
        if cancel.is_cancelled() {
            return Ok(missing);
        }
        return Ok(match connected {
            Err(builderlab::Refused::SessionExpired) => {
                let fi = fi.inner().clone();
                tokio::spawn(async move { fi.recheck(&revision).await });
                Connected::Failed {
                    reason: Failure::Unauthorized,
                }
            }
            other => builderlab::connected(other),
        });
    }
    if let Some(broker) = broker {
        #[cfg(not(debug_assertions))]
        {
            let _ = (broker.origin, broker.revision);
            return Err("Development sign-in unavailable".into());
        }
        #[cfg(debug_assertions)]
        {
            if broker.revision.is_empty() {
                return Err("Invalid development session".into());
            }
            let endpoint = builderlab::development_endpoint(&broker.origin)?;
            let sign_in = builderlab::SignIn::Session(Zeroizing::new(broker.revision));
            let connected = builderlab::connect(
                &endpoint,
                &sign_in,
                &request.offer,
                request.community.as_deref(),
                timeout,
            )
            .await;
            return Ok(builderlab::connected(connected));
        }
    }
    // Builderlab answers only an FI or broker sign-in.
    Ok(missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_are_single_lines_within_limits() {
        let hints = [
            "  buzz-security ".to_owned(),
            "two\nlines".to_owned(),
            "nul\0inside".to_owned(),
            String::new(),
            "x".repeat(HINT_CHARS + 1),
            "murderbot".to_owned(),
        ];
        assert_eq!(
            hint_lines(&hints),
            "buzz-security\ntwo lines\nnul inside\nmurderbot"
        );
        let many: Vec<String> = (0..HINT_LIMIT + 5).map(|n| format!("h{n}")).collect();
        assert_eq!(hint_lines(&many).lines().count(), HINT_LIMIT);
    }

    #[test]
    fn native_events_map_to_webview_events() {
        let text = || "said".to_owned();
        assert_eq!(
            SpeechEvent::from_native(0, text()),
            Some(SpeechEvent::Listening)
        );
        assert_eq!(
            SpeechEvent::from_native(1, text()),
            Some(SpeechEvent::Text { text: text() })
        );
        assert_eq!(
            SpeechEvent::from_native(2, text()),
            Some(SpeechEvent::Ended { text: text() })
        );
        assert_eq!(
            SpeechEvent::from_native(3, text()),
            Some(SpeechEvent::Error { message: text() })
        );
        assert_eq!(
            SpeechEvent::from_native(4, text()),
            Some(SpeechEvent::Downloading)
        );
        assert_eq!(
            SpeechEvent::from_native(5, text()),
            Some(SpeechEvent::Denied { message: text() })
        );
        assert_eq!(SpeechEvent::from_native(9, text()), None);
        assert!(!SpeechEvent::Listening.last());
        assert!(SpeechEvent::Ended { text: text() }.last());
        assert!(!SpeechEvent::Downloading.last());
        assert!(SpeechEvent::Denied { message: text() }.last());
    }
}
