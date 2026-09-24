//! Discovery stderr is bounded and reduced to fixed, actionable messages.
use super::*;
use std::os::{fd::OwnedFd, unix::net::UnixStream};
use tokio::io::AsyncReadExt;

pub(super) struct Diagnostics(tokio::task::JoinHandle<Option<&'static str>>);
impl Diagnostics {
    pub(super) fn capture(command: &mut std::process::Command) -> Result<Self, ModelError> {
        let (reader, writer) = UnixStream::pair()
            .map_err(|_| ModelError::new("unavailable", "Could not open Codex diagnostics."))?;
        reader.set_nonblocking(true).map_err(|_| {
            ModelError::new("unavailable", "Could not configure Codex diagnostics.")
        })?;
        let mut reader = tokio::net::UnixStream::from_std(reader).map_err(|_| {
            ModelError::new("unavailable", "Could not configure Codex diagnostics.")
        })?;
        command.stderr(Stdio::from(OwnedFd::from(writer)));
        Ok(Self(tokio::spawn(async move {
            let mut tail = Vec::new();
            let mut chunk = [0; 4096];
            let mut total = 0;
            loop {
                let count = match reader.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(_) => return None,
                };
                total += count;
                if total > 4 * 1024 * 1024 {
                    return Some("Codex diagnostics exceeded their size limit. Check the adapter configuration and refresh.");
                }
                tail.extend_from_slice(&chunk[..count]);
                if tail.len() > 16 * 1024 {
                    tail.drain(..tail.len() - 16 * 1024);
                }
            }
            let tail = String::from_utf8_lossy(&tail);
            if tail.contains("Error loading config") || tail.contains("CODEX_HOME") {
                Some("Codex could not load its configuration. Check the effective CODEX_HOME and configuration, then refresh.")
            } else if tail.contains("ENOENT")
                || tail.contains("Cannot find module")
                || tail.contains("command not found")
            {
                Some("Codex could not find a required executable or module. Repair the adapter and CLI installation, then refresh.")
            } else if tail.contains("Not logged in") {
                Some("Codex requires login in the same HOME/CODEX_HOME context. Sign in, then refresh.")
            } else {
                None
            }
        })))
    }
    // Called after stopping the contained process. Never wait on an escaped writer.
    pub(super) async fn finish(&mut self) -> Option<&'static str> {
        tokio::time::timeout(Duration::from_secs(1), &mut self.0)
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
    }
}
impl Drop for Diagnostics {
    fn drop(&mut self) {
        self.0.abort();
    }
}
