//! Headless prerequisite checks. Child output is bounded and never returned.
use super::*;
use std::os::{fd::OwnedFd, unix::net::UnixStream};
use tokio::io::AsyncReadExt;

pub(super) async fn login(context: &Context) -> Result<(), ModelError> {
    // Adapter 1.3.0 intercepts --version even after `cli`; -V reaches Codex.
    let (success, version, _) = probe(context, &["-V"]).await?;
    let version = std::str::from_utf8(&version)
        .ok()
        .and_then(|s| s.trim().strip_prefix("codex-cli "));
    if !success
        || !version.is_some_and(|v| {
            let parts: Vec<_> = v.split('.').collect();
            parts.len() == 3 && parts.iter().all(|part| part.parse::<u32>().is_ok())
        })
    {
        return Err(ModelError::new(
            "unavailable",
            "Codex CLI did not report a valid version. Repair the CLI installation and refresh.",
        ));
    }
    let (success, mut output, diagnostics) = probe(context, &["login", "status"]).await?;
    output.extend(diagnostics);
    classify_login(success, &output)
}

async fn probe(context: &Context, args: &[&str]) -> Result<(bool, Vec<u8>, Vec<u8>), ModelError> {
    let (reader, writer) = UnixStream::pair()
        .map_err(|_| ModelError::new("unavailable", "Could not open Codex CLI probe."))?;
    // Version output is stdout; harmless CLI warnings on stderr must not make
    // a successful version response invalid. Still bound both streams together.
    let (diagnostics, stderr) = UnixStream::pair()
        .map_err(|_| ModelError::new("unavailable", "Could not open Codex CLI probe."))?;
    reader
        .set_nonblocking(true)
        .map_err(|_| ModelError::new("unavailable", "Could not configure Codex CLI probe."))?;
    let mut reader = tokio::net::UnixStream::from_std(reader)
        .map_err(|_| ModelError::new("unavailable", "Could not configure Codex CLI probe."))?;
    diagnostics
        .set_nonblocking(true)
        .map_err(|_| ModelError::new("unavailable", "Could not configure Codex CLI probe."))?;
    let mut diagnostics = tokio::net::UnixStream::from_std(diagnostics)
        .map_err(|_| ModelError::new("unavailable", "Could not configure Codex CLI probe."))?;
    let mut command = context.cli_command()?;
    command
        .args(args)
        .env_remove("SSH_AUTH_SOCK")
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::from(OwnedFd::from(stderr)));
    let mut process = ContainedProcess::spawn(&mut command).map_err(|_| {
        ModelError::new(
            "unavailable",
            "Could not start Codex CLI check. Repair the CLI or its interpreter, then refresh.",
        )
    })?;
    // Command retains its copies of the sockets after spawn.
    drop(command);
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut output = [Vec::new(), Vec::new()];
        let mut closed = [false, false];
        let mut stdout_buffer = [0; 1024];
        let mut stderr_buffer = [0; 1024];
        while !closed.iter().all(|closed| *closed) {
            let (stream, read) = tokio::select! {
                read = reader.read(&mut stdout_buffer), if !closed[0] => (0, read),
                read = diagnostics.read(&mut stderr_buffer), if !closed[1] => (1, read),
            };
            let count = read.map_err(|_| {
                ModelError::new("unavailable", "Could not read Codex CLI status. Retry.")
            })?;
            if output[0].len() + output[1].len() + count > 16 * 1024 {
                return Err(ModelError::new(
                    "unavailable",
                    "Codex CLI output exceeded its limit. Check the CLI configuration and retry.",
                ));
            }
            closed[stream] = count == 0;
            let buffer = if stream == 0 {
                &stdout_buffer
            } else {
                &stderr_buffer
            };
            output[stream].extend_from_slice(&buffer[..count]);
        }
        let success = loop {
            if let Some(success) = process.exit_success()? {
                break success;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        };
        let [stdout, stderr] = output;
        Ok((success, stdout, stderr))
    })
    .await
    .unwrap_or_else(|_| {
        Err(ModelError::new(
            "timeout",
            "Codex CLI check timed out. Retry after checking the CLI.",
        ))
    });
    process.stop()?;
    result
}

fn classify_login(success: bool, bytes: &[u8]) -> Result<(), ModelError> {
    if success {
        return Ok(());
    }
    let output = String::from_utf8_lossy(bytes);
    // Only the CLI's explicit result is authoritative logout evidence. All
    // other nonzero exits remain configuration errors or unknown readiness.
    if output.trim() == "Not logged in" {
        Err(ModelError::new("authentication", "Codex is not logged in. Run codex login in the same HOME/CODEX_HOME context, then refresh."))
    } else if output.lines().any(|line| {
        line.starts_with("Error loading configuration") || line.starts_with("Error loading config")
    }) {
        Err(ModelError::new("configuration", "Codex could not load its configuration. Repair the effective Codex configuration, then refresh."))
    } else {
        Err(ModelError::new("unavailable", "Codex login check did not succeed. Check the CLI configuration and login in the same context, then refresh."))
    }
}

pub(super) fn adapter(initialize: &Value) -> Result<(), ModelError> {
    if initialize["agentInfo"]["name"] != "@agentclientprotocol/codex-acp" {
        return Err(ModelError::new("configuration", "Choose @agentclientprotocol/codex-acp 1.3.0. This adapter is not the supported Codex integration."));
    }
    match initialize["agentInfo"]["version"].as_str() {
        Some("1.3.0") if initialize["protocolVersion"] == 1 => Ok(()),
        Some(_) => Err(ModelError::new("configuration", "Codex adapter version is unsupported. Install @agentclientprotocol/codex-acp 1.3.0, select its absolute executable path, and refresh.")),
        None => Err(ModelError::new("unavailable", "Codex adapter did not report its version. Repair the installation and refresh.")),
    }
}
