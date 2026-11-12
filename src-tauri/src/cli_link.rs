//! Links `~/.local/bin/buzz` to the CLI bundled in the running app, so `buzz`
//! works in a terminal. Startup relinks it, so it follows updates and moves.
//! Agents don't need it: `buzz-agent-command` puts its own `buzz` first.
use std::path::Path;

/// A `tauri dev` run, or a debug build, which a packaged debug bundle is
/// though it keeps the release identifier.
pub(crate) fn development(tauri_dev: bool) -> bool {
    tauri_dev || cfg!(debug_assertions)
}

/// Whether this app owns the link: only the installed release does. A
/// development build's would
/// dangle once its worktree goes, and an AppImage runs from a mount that ends
/// when it quits.
pub(crate) fn owns(development: bool, identifier: &str, appimage: bool) -> bool {
    !development && !appimage && identifier == crate::sign_out::legacy_identifier::CURRENT
}

/// Points `local_bin/buzz` at `cli`. Replaces a symlink, the name being
/// Buzz's, and leaves a file or directory there alone.
pub(crate) fn ensure(local_bin: &Path, cli: &Path) -> std::io::Result<()> {
    let link = local_bin.join("buzz");
    match link.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            if std::fs::read_link(&link)? == cli {
                return Ok(());
            }
            std::fs::remove_file(&link)?;
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(local_bin)?;
        }
        Err(error) => return Err(error),
    }
    std::os::unix::fs::symlink(cli, link)
}

#[cfg(test)]
mod tests {
    use super::{development, ensure, owns};
    use crate::sign_out::legacy_identifier::CURRENT;
    use std::fs;
    use std::os::unix::fs::symlink;

    /// A packaged debug bundle keeps the release identifier and isn't
    /// `tauri dev`; this debug test build stands in for it by profile.
    #[test]
    fn only_the_installed_release_owns_the_link() {
        assert!(
            cfg!(debug_assertions) && development(false),
            "a debug build is development"
        );
        assert!(!owns(development(false), CURRENT, false));
        assert!(owns(false, CURRENT, false));
        assert!(!owns(false, CURRENT, true));
        assert!(!owns(false, "xyz.block.buzz.desktop.dev", false));
    }

    #[test]
    fn links_replaces_links_and_leaves_files_and_directories() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let (cli, other) = (root.join("cli"), root.join("other"));
        let local_bin = root.join(".local/bin");
        let link = local_bin.join("buzz");
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(
            fs::read_link(&link).unwrap(),
            cli,
            "created with its directory"
        );
        fs::remove_file(&link).unwrap();
        symlink(&other, &link).unwrap();
        ensure(&local_bin, &cli).unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), cli, "relinked");
        fs::remove_file(&link).unwrap();
        fs::write(&link, "mine").unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(fs::read_to_string(&link).unwrap(), "mine");
        fs::remove_file(&link).unwrap();
        fs::create_dir(&link).unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert!(link.is_dir());
    }
}
