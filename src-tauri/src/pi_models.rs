//! Ephemeral Pi RPC catalog. No Buzz identity, prompt, or saved Pi session.
use buzz_agent_controller::pi::PiContext;
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const FAILURE: &str = "Pi models unavailable. Check Pi sign-in and extension configuration, then retry or enter a custom ID";

// Extensions may spawn helpers. Cancellation must retire the whole lookup group.
struct LookupChild(tokio::process::Child);
impl Drop for LookupChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.0.start_kill();
    }
}

pub(super) async fn fetch(context: PiContext) -> Result<Vec<String>, String> {
    let mut command = tokio::process::Command::new(&context.command);
    command
        .args(["--mode", "rpc", "--no-session", "--no-themes"])
        .args(context.catalog_args()?)
        .current_dir(&context.workspace)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in [
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(context.environment).env("PATH", context.path);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = LookupChild(
        command
            .spawn()
            .map_err(|_| "Could not start Pi to list models")?,
    );
    let mut stdin = child.0.stdin.take().ok_or(FAILURE)?;
    stdin
        .write_all(b"{\"id\":\"catalog\",\"type\":\"get_available_models\"}\n")
        .await
        .map_err(|_| FAILURE)?;
    let stdout = child.0.stdout.take().ok_or(FAILURE)?;
    let mut reader = BufReader::new(stdout.take(8 * 1024 * 1024 + 1));
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        for _ in 0..100 {
            let mut line = String::new();
            if reader.read_line(&mut line).await.map_err(|_| FAILURE)? == 0 {
                break;
            }
            let value: Value = serde_json::from_str(&line).map_err(|_| FAILURE)?;
            if value.get("id") == Some(&json!("catalog")) {
                return parse_response(&value);
            }
        }
        Err(FAILURE.into())
    })
    .await
    .map_err(|_| "Pi model lookup timed out; retry explicitly")?;
    drop(stdin);
    // Drop kills helpers too, even after a successful response.
    drop(child);
    result
}
fn parse_response(value: &Value) -> Result<Vec<String>, String> {
    if value["type"] != "response"
        || value["command"] != "get_available_models"
        || value["success"] != true
    {
        return Err(FAILURE.into());
    }
    let models = value["data"]["models"].as_array().ok_or(FAILURE)?;
    if models.len() > 10_000 {
        return Err("Pi model catalog is too large".into());
    }
    let mut result = Vec::new();
    for model in models {
        let provider = model["provider"].as_str().ok_or(FAILURE)?;
        let id = model["id"].as_str().ok_or(FAILURE)?;
        if provider.is_empty() || id.is_empty() {
            return Err("Pi returned an invalid model ID".into());
        }
        buzz_agent_controller::pi::validate_selection(provider, id)
            .map_err(|_| "Pi returned an invalid model ID")?;
        result.push(format!("{provider}/{id}"));
    }
    result.sort();
    result.dedup();
    Ok(result)
}

#[cfg(test)]
mod tests;
