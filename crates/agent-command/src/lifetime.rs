//! Attention commands belong to one app process and one saved watch across builds.
use crate::{private_directory, Result};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::time::Duration;

pub(super) fn watch() -> Result<Option<File>> {
    let Some(key) = std::env::var_os("BUZZ_ATTENTION_COMMAND") else {
        return Ok(None);
    };
    // The native host puts each helper and its descendants in their own group.
    // Refuse an uncontained launch rather than signal an unrelated process group.
    let parent = unsafe { libc::getppid() };
    let group = unsafe { libc::getpgrp() };
    if parent == 1 || group != std::process::id() as i32 {
        return Err("Attention commands need a live host and their own process group".into());
    }
    let directory = private_directory("attention-commands")?;
    let name = format!("{:x}.lock", Sha256::digest(key.as_encoded_bytes()));
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(name))?;
    let metadata = lease.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err("The Attention command lease is not private".into());
    }
    // Never unlink the file: all builds must lock the same inode, including when
    // a previous app died. The OS releases its lock when its helper exits.
    lease
        .try_lock()
        .map_err(|error| format!("This Attention command is already running: {error}"))?;
    std::thread::Builder::new()
        .name("attention-parent".into())
        .spawn(move || loop {
            if unsafe { libc::getppid() } != parent {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        })?;
    Ok(Some(lease))
}
