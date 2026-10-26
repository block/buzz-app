//! Buzz was `dev.local.buzz.foundation` before 1.0. Its first launch as
//! `xyz.block.buzz.desktop` renames what Tauri and the WebView keep under the
//! old identifier, with any sign-out trash and pending sign-out marker, so an
//! update keeps its data and still finishes a sign-out the old build committed.
use super::{agents_stopped, marker_name, trash, wait_for};
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub(crate) const LEGACY: &str = "dev.local.buzz.foundation";
pub(crate) const CURRENT: &str = "xyz.block.buzz.desktop";
const BUSY: &str = "Quit every other Buzz window, then open Buzz again to finish moving its storage. Nothing was moved.";
const AGENT_STOPPING: &str =
    "An agent is still stopping. Open Buzz again in a moment to finish moving its storage.";
const FAILED: &str = "Buzz couldn't finish moving its storage. Open Buzz again to retry.";

/// Each path the legacy identifier names, with its new name; none unless this
/// is the release identifier, so development (`.dev`) and test identifiers never take it.
pub(super) fn moves(identifier: &str) -> Option<Vec<(PathBuf, PathBuf)>> {
    if identifier != CURRENT {
        return Some(Vec::new());
    }
    let data = dirs::data_dir()?;
    // Where Tauri resolves app data, config, local data (the Windows and Linux
    // WebView) and cache, and macOS keeps WebKit storage.
    let mut bases = vec![
        data.clone(),
        dirs::config_dir()?,
        dirs::data_local_dir()?,
        dirs::cache_dir()?,
    ];
    #[cfg(target_os = "macos")]
    bases.push(dirs::home_dir()?.join("Library/WebKit"));
    bases.sort();
    bases.dedup();
    let mut moves: Vec<_> = bases
        .iter()
        .flat_map(|base| {
            let (old, new) = (base.join(LEGACY), base.join(CURRENT));
            [(trash(&old), trash(&new)), (old, new)]
        })
        .collect();
    let service = buzz_credential_store::HUMAN_SERVICE;
    moves.push((
        data.join(marker_name(LEGACY, service)),
        data.join(marker_name(CURRENT, service)),
    ));
    Some(moves)
}

/// Rename each legacy path that is still due, before this launch takes its
/// locks, once no other Buzz or agent runs. A failure exits; the next launch
/// resumes with what is still due.
#[allow(clippy::incompatible_msrv)] // File locking, like the owning sign_out module.
pub(super) fn migrate(
    moves: &[(PathBuf, PathBuf)],
    all: &File,
    ownership: &Path,
) -> Result<(), String> {
    // Every Buzz, older builds included, holds the all-Buzz lock shared while
    // it runs. Without the lock a scan is only a hint: one that finished the move
    // leaves nothing due, but a conflict may be a rename seen half done.
    let mut done = false;
    let ready = wait_for(|| {
        done = matches!(due(moves), Ok(due) if due.is_empty());
        if done {
            Ok(())
        } else {
            all.try_lock()
        }
    });
    if !ready {
        return Err(BUSY.into());
    }
    if done {
        return Ok(());
    }
    let moved = (|| {
        // An agent still stopping may write its folders.
        if !wait_for(|| agents_stopped(ownership)) {
            return Err(AGENT_STOPPING.to_owned());
        }
        // Look again under the lock.
        for (old, new) in due(moves)? {
            fs::rename(old, new).map_err(failed)?;
        }
        Ok(())
    })();
    all.unlock().map_err(failed)?;
    moved
}

/// The pairs still to move. Both paths present, after a rollback to an older
/// build for instance, refuses every move and any pending sign-out: neither copy
/// is safely the one to keep, and an erase would miss the legacy one.
fn due(moves: &[(PathBuf, PathBuf)]) -> Result<Vec<&(PathBuf, PathBuf)>, String> {
    let mut due = Vec::new();
    for pair in moves {
        match (present(&pair.0).map_err(failed)?, present(&pair.1).map_err(failed)?) {
            (true, true) => {
                return Err(format!(
                    "Buzz found storage from before 1.0 at {} beside this version's at {}. Move one of them elsewhere, then open Buzz again. Nothing was moved.",
                    pair.0.display(),
                    pair.1.display()
                ))
            }
            (true, false) => due.push(pair),
            _ => {}
        }
    }
    Ok(due)
}

fn failed(error: std::io::Error) -> String {
    eprintln!("buzz: move legacy storage: {error}");
    FAILED.to_owned()
}

/// Whether anything is at `path`. A link counts and is never followed: renaming
/// it moves the link, never what it points to.
fn present(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        other => other.map(|_| true),
    }
}
