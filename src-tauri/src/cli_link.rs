//! Links `~/.local/bin/buzz` to the CLI bundled in the running app, so `buzz`
//! works in a terminal. Startup relinks it, so it follows updates and moves.
//! Agents don't need it: `buzz-agent-command` puts its own `buzz` first.
use std::path::Path;

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
    use super::ensure;
    use std::fs;
    use std::os::unix::fs::symlink;

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
