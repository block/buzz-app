//! Tauri copies resources in place. On macOS, an executed Mach-O's inode can
//! retain stale code-signature state after that copy, even when codesign verifies
//! the bytes on disk. Publish fresh inodes after Tauri finishes staging resources.
use std::{fs, io, path::Path};

pub fn refresh_runtime_inodes(directory: &Path) -> io::Result<()> {
    let entries = fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    for entry in entries {
        if !entry.file_type()?.is_file() {
            continue;
        }
        let mut staged = tempfile::NamedTempFile::new_in(directory)?;
        let mut source = fs::File::open(entry.path())?;
        io::copy(&mut source, staged.as_file_mut())?;
        staged
            .as_file()
            .set_permissions(source.metadata()?.permissions())?;
        staged.as_file().sync_all()?;
        staged.persist(entry.path()).map_err(|error| error.error)?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    #[test]
    fn refresh_preserves_bytes_permissions_and_replaces_executed_inode() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("buzz-acp");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(std::process::Command::new(&executable)
            .status()
            .unwrap()
            .success());
        let original = fs::File::open(&executable).unwrap();
        let inode = original.metadata().unwrap().ino();
        refresh_runtime_inodes(directory.path()).unwrap();
        assert_ne!(fs::metadata(&executable).unwrap().ino(), inode);
        assert_eq!(
            fs::metadata(&executable).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(fs::read(&executable).unwrap(), b"#!/bin/sh\nexit 0\n");
        assert!(std::process::Command::new(&executable)
            .status()
            .unwrap()
            .success());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
