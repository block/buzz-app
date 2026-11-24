//! Why each recent sign-in ended, and when, so Settings can say what
//! happened instead of only asking the person to sign in again. Each entry
//! holds a reason code, a failure code and a time. Never an email, a token,
//! or anything else from the session.
//!
//! Every Buzz copy on a profile shares the list. Each change reads the list
//! on disk, adds to it and replaces it under a lock the other copies take
//! too, so no copy writes over entries another added since it started.

use serde::{Deserialize, Serialize};
use std::io::Write as _;
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
    /// Buzz found the session already ending: its record was marked for
    /// removal, by another copy of Buzz or before a restart, whether by a
    /// sign-out, an expiry or the server. Which one is not known.
    AlreadyEnded,
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
    keep_newest(&mut endings);
    endings
}

/// Adds an ending at `at` (Unix seconds) to the list saved at `path`, and
/// sets `endings` to the list as saved: every copy's entries and this one.
/// When the list can't be saved, it is still added to `endings`.
pub(super) fn push(
    endings: &mut Vec<Ending>,
    path: Option<&Path>,
    at: i64,
    reason: Reason,
    failure: Option<&str>,
) {
    let Some(at) = chrono::DateTime::from_timestamp(at, 0) else {
        return;
    };
    let ending = Ending {
        at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        reason,
        failure: failure.map(Into::into),
    };
    let saved = path.map(|path| save(path, ending.clone()));
    match saved {
        Some(Ok(saved)) => *endings = saved,
        failed => {
            if failed.is_some() {
                eprintln!("Buzz could not save why the sign-in ended");
            }
            endings.push(ending);
            keep_newest(endings);
        }
    }
}

/// Reads, adds to and replaces the list at `path` while holding its lock.
/// The new list is written beside it and renamed over it, so a reader sees
/// the old list or the new one, never part of either.
fn save(path: &Path, ending: Ending) -> std::io::Result<Vec<Ending>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("endings-lock"))?;
    lock.lock()?;
    let mut endings = load(Some(path));
    endings.push(ending);
    keep_newest(&mut endings);
    let bytes = serde_json::to_vec(&endings).map_err(std::io::Error::other)?;
    let next = path.with_extension("endings-new");
    let mut file = std::fs::File::create(&next)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(&next, path)?;
    Ok(endings)
}

fn keep_newest(endings: &mut Vec<Ending>) {
    let excess = endings.len().saturating_sub(KEPT);
    endings.drain(..excess);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_ten_each_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account.endings");
        let mut endings = Vec::new();
        // Two sign-outs at different times are two entries.
        push(&mut endings, Some(&path), 0, Reason::SignedOut, None);
        push(&mut endings, Some(&path), 1, Reason::SignedOut, None);
        assert_eq!(endings.len(), 2);
        for at in 2..20 {
            push(&mut endings, Some(&path), at, Reason::Expired, None);
        }
        assert_eq!(endings.len(), KEPT);
        assert_eq!(endings.last().unwrap().at, "1970-01-01T00:00:19Z");
        assert_eq!(load(Some(&path)), endings);
    }

    /// Two copies of Buzz each loaded the list when they started; each one's
    /// later entries survive the other's.
    #[test]
    fn copies_of_buzz_keep_each_others_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account.endings");
        let mut first = load(Some(&path));
        let mut second = load(Some(&path));
        push(&mut first, Some(&path), 1, Reason::SignedOut, None);
        push(&mut second, Some(&path), 2, Reason::Expired, None);
        let reasons = |endings: &[Ending]| endings.iter().map(|e| e.reason).collect::<Vec<_>>();
        assert_eq!(reasons(&second), [Reason::SignedOut, Reason::Expired]);
        assert_eq!(reasons(&load(Some(&path))), reasons(&second));
        // Writers on many threads lose nothing either.
        let threads: Vec<_> = (0..8)
            .map(|at| {
                let path = path.clone();
                std::thread::spawn(move || {
                    push(
                        &mut Vec::new(),
                        Some(&path),
                        10 + at,
                        Reason::SignedOut,
                        None,
                    )
                })
            })
            .collect();
        threads
            .into_iter()
            .for_each(|thread| thread.join().unwrap());
        assert_eq!(load(Some(&path)).len(), KEPT);
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
