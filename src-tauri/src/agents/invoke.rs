//! One-shot provider processes that act as a provider-backed agent. The renderer
//! chooses the program and input; native supplies only this agent's credential.
use super::{run, AgentHost};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT: u64 = 600;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InvokeRequest {
    id: String,
    provider: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    input: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InvokeResult {
    exit_code: Option<i32>,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

// Tokio kills only the direct child on drop; the group also owns descendants.
#[cfg(unix)]
struct ProcessGroup(i32, bool);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if self.1 {
            unsafe { libc::kill(-self.0, libc::SIGKILL) };
        }
    }
}

/// Keep the head and keep draining, so a chatty child never blocks on a full pipe.
async fn bounded(stream: Option<impl AsyncRead + Unpin>) -> String {
    let mut bytes = Vec::new();
    if let Some(mut stream) = stream {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stream.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            let room = MAX_OUTPUT_BYTES.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..n.min(room)]);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tauri::command]
pub(crate) async fn agent_control_invoke(
    state: tauri::State<'_, AgentHost>,
    request: InvokeRequest,
) -> Result<InvokeResult, String> {
    if request.input.len() > MAX_INPUT_BYTES {
        return Err("Provider input is too large".into());
    }
    let timeout = request
        .timeout_seconds
        .unwrap_or(DEFAULT_TIMEOUT)
        .clamp(1, 3600);
    let (id, provider, program) = (
        request.id.clone(),
        request.provider.clone(),
        request.program.clone(),
    );
    // Only the lookup holds the host; the process itself never blocks other controls.
    let (invocation, credentials) = run(state.inner().clone(), move |host| {
        let invocation = host.controller.invocation(&id, &provider, &program)?;
        Ok((invocation, host.credentials.clone()))
    })
    .await?;
    let (credential, pubkey) = (invocation.credential_id.clone(), invocation.pubkey.clone());
    let key = tauri::async_runtime::spawn_blocking(move || credentials.read(&credential, &pubkey))
        .await
        .map_err(|_| "Native credential operation failed".to_owned())??
        .ok_or("Saved agent key is unavailable; nothing was run")?;
    let (std_command, _temporary) = invocation.command(&key, &request.args)?;
    drop(key);
    let mut command = tokio::process::Command::from(std_command);
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the provider program")?;
    #[cfg(unix)]
    let mut group = ProcessGroup(child.id().unwrap_or(0) as i32, child.id().is_some());
    let stdin = child.stdin.take();
    let input = request.input.into_bytes();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let outcome = tokio::time::timeout(Duration::from_secs(timeout), async {
        let write = async {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(&input).await;
            }
        };
        let (_, stdout, stderr, status) =
            tokio::join!(write, bounded(stdout), bounded(stderr), child.wait());
        (stdout, stderr, status)
    })
    .await;
    match outcome {
        Ok((stdout, stderr, status)) => {
            #[cfg(unix)]
            {
                group.1 = false;
            }
            Ok(InvokeResult {
                exit_code: status.ok().and_then(|s| s.code()),
                timed_out: false,
                stdout,
                stderr,
            })
        }
        Err(_) => {
            #[cfg(unix)]
            drop(group);
            let _ = child.start_kill();
            let _ = child.wait().await;
            Ok(InvokeResult {
                exit_code: None,
                timed_out: true,
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }
}
