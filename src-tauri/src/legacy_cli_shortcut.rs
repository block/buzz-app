//! Old Buzz linked `~/.local/bin/buzz` to the CLI inside its `Buzz.app`. This app
//! replaces that bundle without a CLI, and on a case-insensitive volume the link's
//! `Contents/MacOS/buzz` then opens this app's `Buzz` executable, so every `buzz`
//! command launches and foregrounds Buzz. Startup removes the link once no file
//! named exactly `buzz` is beside its target; a dangling link is removed too,
//! because installing this app at its target turns it into the same launcher.
use std::path::Path;

pub(crate) fn remove_stale(local_bin: &Path) -> std::io::Result<()> {
    let link = local_bin.join("buzz");
    // Old Buzz linked only to the absolute `buzz` inside its own `Buzz.app`.
    let Ok(target) = std::fs::read_link(&link) else {
        return Ok(());
    };
    let Some(directory) = target.parent() else {
        return Ok(());
    };
    if !target.is_absolute()
        || target.file_name() != Some("buzz".as_ref())
        || !directory.ends_with("Buzz.app/Contents/MacOS")
    {
        return Ok(());
    }
    match std::fs::read_dir(directory) {
        Ok(entries) => {
            for entry in entries {
                if entry?.file_name() == "buzz" {
                    return Ok(());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::remove_file(link)
}

#[cfg(test)]
mod tests {
    use super::remove_stale;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::Path;

    fn bundle(root: &Path, name: &str, executables: &[&str]) -> std::path::PathBuf {
        let directory = root.join("Applications").join(name).join("Contents/MacOS");
        fs::create_dir_all(&directory).unwrap();
        for name in executables {
            fs::write(directory.join(name), "").unwrap();
        }
        directory.join("buzz")
    }

    fn linked(root: &Path, target: &Path) -> std::path::PathBuf {
        let local_bin = root.join(".local/bin");
        fs::create_dir_all(&local_bin).unwrap();
        symlink(target, local_bin.join("buzz")).unwrap();
        local_bin
    }

    fn kept(local_bin: &Path) -> bool {
        local_bin.join("buzz").symlink_metadata().is_ok()
    }

    #[test]
    fn removes_a_link_that_reaches_the_app_only_by_case() {
        let root = tempfile::tempdir().unwrap();
        let local_bin = linked(root.path(), &bundle(root.path(), "Buzz.app", &["Buzz"]));

        remove_stale(&local_bin).unwrap();
        assert!(!kept(&local_bin));
        // Repeating the migration finds nothing to do.
        remove_stale(&local_bin).unwrap();
        assert!(!kept(&local_bin));
    }

    #[test]
    fn removes_a_dangling_link_into_buzz_app() {
        let root = tempfile::tempdir().unwrap();
        let local_bin = linked(
            root.path(),
            &root
                .path()
                .join("Applications/Buzz.app/Contents/MacOS/buzz"),
        );

        remove_stale(&local_bin).unwrap();
        assert!(!kept(&local_bin));
    }

    #[test]
    fn keeps_a_link_to_old_buzz_cli() {
        let root = tempfile::tempdir().unwrap();
        let local_bin = linked(
            root.path(),
            &bundle(root.path(), "Buzz.app", &["buzz-desktop", "buzz"]),
        );

        remove_stale(&local_bin).unwrap();
        assert!(kept(&local_bin));
    }

    #[test]
    fn keeps_links_and_files_old_buzz_did_not_make() {
        let root = tempfile::tempdir().unwrap();
        bundle(root.path(), "Buzz.app", &["Buzz"]);
        let local_bin = linked(root.path(), &root.path().join("tools/buzz"));
        remove_stale(&local_bin).unwrap();
        assert!(kept(&local_bin));

        fs::remove_file(local_bin.join("buzz")).unwrap();
        symlink(
            "../../Applications/Buzz.app/Contents/MacOS/buzz",
            local_bin.join("buzz"),
        )
        .unwrap();
        remove_stale(&local_bin).unwrap();
        assert!(kept(&local_bin));

        fs::remove_file(local_bin.join("buzz")).unwrap();
        fs::write(local_bin.join("buzz"), "").unwrap();
        remove_stale(&local_bin).unwrap();
        assert!(kept(&local_bin));

        remove_stale(&root.path().join("missing")).unwrap();
    }

    #[test]
    fn keeps_links_into_other_bundles() {
        let root = tempfile::tempdir().unwrap();
        let local_bin = linked(root.path(), &bundle(root.path(), "Other.app", &["Buzz"]));
        remove_stale(&local_bin).unwrap();
        assert!(kept(&local_bin));

        fs::remove_file(local_bin.join("buzz")).unwrap();
        symlink(
            root.path()
                .join("Applications/Missing.app/Contents/MacOS/buzz"),
            local_bin.join("buzz"),
        )
        .unwrap();
        remove_stale(&local_bin).unwrap();
        assert!(kept(&local_bin));
    }
}
