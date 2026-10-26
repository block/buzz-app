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
/// is the current identifier, so test and development overlays never take it.
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
/// locks, once no other Buzz or agent runs. A new path that already exists is
/// never replaced, and its legacy path stays. A failure exits; the next launch
/// resumes with what is still due.
#[allow(clippy::incompatible_msrv)] // File locking, like the owning sign_out module.
pub(super) fn migrate(
    moves: &[(PathBuf, PathBuf)],
    all: &File,
    ownership: &Path,
) -> Result<(), String> {
    let failed = |error: std::io::Error| {
        eprintln!("buzz: move legacy storage: {error}");
        FAILED.to_owned()
    };
    if due(moves).map_err(failed)?.is_empty() {
        return Ok(());
    }
    // Every Buzz, older builds included, holds the all-Buzz lock shared while it runs.
    if !wait_for(|| all.try_lock()) {
        return Err(BUSY.into());
    }
    let moved = (|| {
        // An agent still stopping may write its folders.
        if !wait_for(|| agents_stopped(ownership)) {
            return Err(AGENT_STOPPING.to_owned());
        }
        // Look again: another launch may have moved them while this one waited.
        for (old, new) in due(moves).map_err(failed)? {
            fs::rename(old, new).map_err(failed)?;
        }
        Ok(())
    })();
    all.unlock().map_err(failed)?;
    moved
}

fn due(moves: &[(PathBuf, PathBuf)]) -> std::io::Result<Vec<&(PathBuf, PathBuf)>> {
    let mut due = Vec::new();
    for pair in moves {
        if present(&pair.0)? && !present(&pair.1)? {
            due.push(pair);
        }
    }
    Ok(due)
}

/// Whether anything is at `path`. A link counts and is never followed: renaming
/// it moves the link, never what it points to.
fn present(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        other => other.map(|_| true),
    }
}
