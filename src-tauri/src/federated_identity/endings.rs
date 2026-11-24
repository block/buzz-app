//! Why each recent sign-in ended, and when, so Settings can say what
//! happened instead of only asking the person to sign in again. Each entry
//! holds a reason code, a failure code and a time. Never an email, a token,
//! or anything else from the session.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// How many endings are kept, newest last.
const KEPT: usize = 10;
/// A file larger than this is not ours; it is ignored and replaced.
const LIMIT: u64 = 16 * 1024;

/// Why a sign-in ended (or, for `NotConfirmed`, could not be checked).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Reason {
    /// The session reached the end of its fixed lifetime.
    Expired,
    /// The sign-in server said the session is no longer valid.
    EndedByServer,
    /// The person signed out on this device.
    SignedOut,
    /// Another Buzz copy on this device signed out.
    SignedOutElsewhere,
    /// A saved sign-in could not be checked (network, clock or storage); it
    /// was kept, and checked again.
    NotConfirmed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Ending {
    /// RFC 3339, UTC, whole seconds.
    pub(crate) at: String,
    pub(crate) reason: Reason,
    /// The failure code that came with it, when one did.
    pub(crate) failure: Option<String>,
}

/// The endings saved at `path`; none when it is missing or unreadable.
pub(super) fn load(path: Option<&Path>) -> Vec<Ending> {
    let Some(path) = path else {
        return Vec::new();
    };
    let read = std::fs::metadata(path)
        .ok()
        .filter(|meta| meta.len() <= LIMIT)
        .and_then(|_| std::fs::read(path).ok());
    let mut endings: Vec<Ending> = read
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    endings.retain(|ending| {
        chrono::DateTime::parse_from_rfc3339(&ending.at).is_ok()
            && ending.failure.as_ref().is_none_or(|code| {
                code.len() <= 64 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
            })
    });
    let excess = endings.len().saturating_sub(KEPT);
    endings.drain(..excess);
    endings
}

/// Adds an ending at `at` (Unix seconds), unless it repeats the newest, and
/// saves the list to `path`. True when the list changed.
pub(super) fn push(
    endings: &mut Vec<Ending>,
    path: Option<&Path>,
    at: i64,
    reason: Reason,
    failure: Option<&str>,
) -> bool {
    if endings
        .last()
        .is_some_and(|last| last.reason == reason && last.failure.as_deref() == failure)
    {
        return false;
    }
    let Some(at) = chrono::DateTime::from_timestamp(at, 0) else {
        return false;
    };
    endings.push(Ending {
        at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        reason,
        failure: failure.map(Into::into),
    });
    let excess = endings.len().saturating_sub(KEPT);
    endings.drain(..excess);
    if let Some(path) = path {
        let written = serde_json::to_vec(endings)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                path.parent()
                    .map_or(Ok(()), std::fs::create_dir_all)
                    .and_then(|()| std::fs::write(path, bytes))
            });
        if written.is_err() {
            eprintln!("The sign-in server's sign-in history could not be saved");
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_and_skips_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account.endings");
        let mut endings = Vec::new();
        assert!(push(&mut endings, Some(&path), 0, Reason::Expired, None));
        assert!(!push(&mut endings, Some(&path), 1, Reason::Expired, None));
        for at in 0..KEPT as i64 {
            push(
                &mut endings,
                Some(&path),
                at,
                if at % 2 == 0 {
                    Reason::NotConfirmed
                } else {
                    Reason::SignedOut
                },
                (at % 2 == 0).then_some("network-timeout"),
            );
        }
        assert_eq!(endings.len(), KEPT);
        assert_eq!(endings.last().unwrap().reason, Reason::SignedOut);
        assert_eq!(load(Some(&path)), endings);
    }

    #[test]
    fn ignores_a_file_that_is_not_ours() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account.endings");
        std::fs::write(&path, b"{\"token\":\"x\"}").unwrap();
        assert!(load(Some(&path)).is_empty());
        std::fs::write(
            &path,
            br#"[{"at":"2026-01-01T00:00:00Z","reason":"expired","failure":"Not A Code"}]"#,
        )
        .unwrap();
        assert!(load(Some(&path)).is_empty());
        assert!(load(None).is_empty());
    }
}
