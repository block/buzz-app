//! Cooperating new-app profiles only. Old Buzz does not participate in this lock.
use crate::Result;
use std::fs::{File, OpenOptions};
use std::path::Path;
pub(crate) struct Ownership(File);
impl Ownership {
    pub fn acquire(root: &Path, id: &str) -> Result<Self> {
        let (key, community) = id
            .split_once('-')
            .ok_or("Invalid agent ownership identity")?;
        if !crate::config::canonical_key(key) || !crate::config::canonical_key(community) {
            return Err("Invalid agent ownership identity".into());
        }
        if !root.is_absolute() {
            return Err("Agent ownership storage must be absolute".into());
        }
        crate::connection::private_directory(root)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(root.join(format!("{id}.lock")))
            .map_err(|_| "Could not open agent ownership lock")?;
        if !file
            .metadata()
            .map_err(|_| "Could not inspect agent ownership lock")?
            .is_file()
        {
            return Err("Invalid agent ownership lock".into());
        }
        file.try_lock().map_err(|_| {
            "Another buzz-app profile is already running this exact agent/community"
        })?;
        Ok(Self(file))
    }
}
impl Drop for Ownership {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
