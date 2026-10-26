//! Buzz was `dev.local.buzz.foundation` before 1.0. Its first launch as
//! `xyz.block.buzz.desktop` renames what Tauri and the WebView keep under the
//! old identifier, with any sign-out trash and pending sign-out marker, so an
//! update keeps its data and still finishes a sign-out the old build committed.
//! Development builds shared that storage until they became `.dev`; the first
//! development launch copies the installed app's, leaving it in place.
use super::{agents_stopped, marker_name, trash, wait_for};
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub(crate) const LEGACY: &str = "dev.local.buzz.foundation";
pub(crate) const CURRENT: &str = "xyz.block.buzz.desktop";
/// What `just desktop` and debug bundles run as (`scripts/desktop-config.mjs`).
pub(crate) const DEV: &str = "xyz.block.buzz.desktop.dev";
const BUSY: &str = "Quit every other Buzz window, then open Buzz again to finish moving its storage. Nothing was moved.";
const AGENT_STOPPING: &str =
    "An agent is still stopping. Open Buzz again in a moment to finish moving its storage.";
const FAILED: &str = "Buzz couldn't finish moving its storage. Open Buzz again to retry.";

/// Each path the legacy identifier names, with its new name. The release
/// identifier takes them all; development (`.dev`) only its own pending sign-out,
/// copying the rest (`seeds`); test identifiers none.
pub(super) fn moves(identifier: &str) -> Option<Vec<(PathBuf, PathBuf)>> {
    if identifier != CURRENT && identifier != DEV {
        return Some(Vec::new());
    }
    let data = dirs::data_dir()?;
    let service = buzz_credential_store::HUMAN_SERVICE;
    let marker = (
        data.join(marker_name(LEGACY, service)),
        data.join(marker_name(identifier, service)),
    );
    if identifier == DEV {
        return Some(vec![marker]);
    }
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
    moves.push(marker);
    Some(moves)
}

/// Where a first development launch copies the installed app's folders: config,
/// local data (the Windows and Linux WebView), macOS WebKit storage, and app data
/// last, since its copy marks the seed finished. Caches are left. None unless
/// this is the development identifier.
pub(super) fn seeds(identifier: &str) -> Option<Vec<PathBuf>> {
    if identifier != DEV {
        return Some(Vec::new());
    }
    let data = dirs::data_dir()?;
    let mut bases = vec![dirs::config_dir()?, dirs::data_local_dir()?];
    #[cfg(target_os = "macos")]
    bases.push(dirs::home_dir()?.join("Library/WebKit"));
    bases.retain(|base| *base != data);
    bases.sort();
    bases.dedup();
    bases.push(data);
    Some(bases)
}

/// Rename each legacy path that is still due, before this launch takes its
/// locks, once no other Buzz or agent runs. A failure exits; the next launch
/// resumes with what is still due.
#[allow(clippy::incompatible_msrv)] // File locking, like the owning sign_out module.
pub(super) fn migrate(
    moves: &[(PathBuf, PathBuf)],
    seeds: &[PathBuf],
    all: &File,
    ownership: &Path,
) -> Result<(), String> {
    // Every Buzz, older builds included, holds the all-Buzz lock shared while
    // it runs. Without the lock a scan is only a hint: one that finished the move
    // leaves nothing due, but a conflict may be a rename seen half done.
    let mut done = false;
    let ready = wait_for(|| {
        done =
            matches!(due(moves), Ok(due) if due.is_empty()) && matches!(seeding(seeds), Ok(None));
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
        // Look again under the lock, so a conflict is reported before any wait.
        if due(moves)?.is_empty() && seeding(seeds)?.is_none() {
            return Ok(());
        }
        // An agent still stopping may write its folders; look once more after.
        if !wait_for(|| agents_stopped(ownership)) {
            return Err(AGENT_STOPPING.to_owned());
        }
        for (old, new) in due(moves)? {
            fs::rename(old, new).map_err(failed)?;
        }
        if let Some(source) = seeding(seeds)? {
            seed(seeds, source).map_err(failed)?;
        }
        Ok(())
    })();
    all.unlock().map_err(failed)?;
    moved
}

/// The pairs still to move. Both paths present, after a rollback to an older
/// build for instance, refuses every move and any pending sign-out: neither copy
/// is safely the one to keep, and an erase would miss the legacy one. The refusal
/// names every such pair, so one round of moving them aside is enough.
fn due(moves: &[(PathBuf, PathBuf)]) -> Result<Vec<&(PathBuf, PathBuf)>, String> {
    let (mut due, mut conflicts) = (Vec::new(), String::new());
    for pair in moves {
        match (
            present(&pair.0).map_err(failed)?,
            present(&pair.1).map_err(failed)?,
        ) {
            (true, true) => conflicts.push_str(&format!(
                "\n{} beside {}",
                pair.0.display(),
                pair.1.display()
            )),
            (true, false) => due.push(pair),
            _ => {}
        }
    }
    if !conflicts.is_empty() {
        return Err(format!(
            "Buzz found storage from before 1.0 beside this version's:{conflicts}\nMove one of each pair elsewhere, then open Buzz again. Nothing was moved."
        ));
    }
    Ok(due)
}

/// The installed app's identifier to copy from while this development launch
/// has no app data of its own: its 1.0 folders once it has moved them.
fn seeding(bases: &[PathBuf]) -> Result<Option<&'static str>, String> {
    let Some(data) = bases.last() else {
        return Ok(None);
    };
    if present(&data.join(DEV)).map_err(failed)? {
        return Ok(None);
    }
    for source in [CURRENT, LEGACY] {
        if present(&data.join(source)).map_err(failed)? {
            return Ok(Some(source));
        }
    }
    Ok(None)
}

/// Copy each folder this launch lacks through a sibling renamed into place, so
/// an interrupted seed leaves only what the next launch discards and redoes.
fn seed(bases: &[PathBuf], source: &str) -> std::io::Result<()> {
    for base in bases {
        let (from, to) = (base.join(source), base.join(DEV));
        if !present(&from)? || present(&to)? {
            continue;
        }
        let partial = base.join(format!("{DEV}.seeding"));
        match fs::remove_dir_all(&partial) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        copy(&from, &partial)?;
        fs::rename(&partial, &to)?;
    }
    Ok(())
}

/// Copies a tree, recreating links rather than following them (on Unix; other
/// platforms skip them, as they skip every other special file).
fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
    let kind = fs::symlink_metadata(from)?.file_type();
    if kind.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if kind.is_file() {
        fs::copy(from, to)?;
    } else if kind.is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    }
    Ok(())
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
