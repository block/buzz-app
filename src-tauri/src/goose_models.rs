//! One-shot Goose ACP catalog lookup. The child never receives a Buzz identity.
use buzz_agent_controller::GooseModelContext;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const METHOD: &str = "_goose/unstable/providers/supported-models/list";

struct CheckChild(tokio::process::Child);
impl Drop for CheckChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.id() {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.0.start_kill();
    }
}

/// Run one Goose turn through its normal session path without saving a session
/// or loading extensions. Databricks rejects `info --check`'s empty system prompt.
/// The selected draft and write-only overrides are resolved by the controller.
pub(super) async fn test(context: GooseModelContext) -> Result<(), String> {
    if context.model_id.trim().is_empty()
        || context.model_id.len() > 512
        || context.model_id.chars().any(char::is_control)
    {
        return Err("Choose a valid Goose model to test".into());
    }
    if !context.workspace.is_absolute() || !context.workspace.is_dir() {
        return Err("Choose an existing absolute workspace before testing Goose".into());
    }
    let mut command = tokio::process::Command::new(context.command);
    command
        .args([
            "run",
            "--text",
            "Reply OK.",
            "--no-session",
            "--no-profile",
            "--max-turns",
            "1",
            "--quiet",
        ])
        .current_dir(context.workspace)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for name in [
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .envs(context.environment)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    command
        .env("GOOSE_PROVIDER", context.provider_id)
        .env("GOOSE_MODEL", context.model_id)
        .env("GOOSE_MAX_TOKENS", "10")
        .env("GOOSE_THINKING_EFFORT", "off");
    #[cfg(unix)]
    command.process_group(0);
    let mut child = CheckChild(
        command
            .spawn()
            .map_err(|_| "Could not start Goose to test the model".to_owned())?,
    );
    let status = tokio::time::timeout(Duration::from_secs(30), child.0.wait()).await;
    match status {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err("Goose could not complete a request with this provider and model. Check its credentials, model and network, then test again.".into()),
        Err(_) => Err("Goose connection test timed out. Check the network, then test again.".into()),
    }
}

pub(super) async fn fetch(context: GooseModelContext) -> Result<Vec<String>, String> {
    let provider_id = context.provider_id.clone();
    let mut command = tokio::process::Command::new(context.command);
    command
        .arg("acp")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for name in [
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .envs(context.environment)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Goose to list models".to_owned())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Goose catalog input unavailable")?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": METHOD,
        "params": { "providerId": provider_id }
    });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|_| "Could not request Goose models".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Goose catalog output unavailable")?;
    let mut reader = BufReader::new(stdout.take(MAX_RESPONSE_BYTES + 1));
    let response = tokio::time::timeout(Duration::from_secs(60), async {
        for _ in 0..100 {
            let mut line = String::new();
            if reader
                .read_line(&mut line)
                .await
                .map_err(|_| "Could not read Goose models")?
                == 0
            {
                break;
            }
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| "Goose returned an invalid model response")?;
            if value.get("id") == Some(&json!(1)) {
                return parse_response(&value, &provider_id);
            }
        }
        Err("Goose did not return a model list".to_owned())
    })
    .await
    .map_err(|_| "Goose model lookup timed out; retry explicitly".to_owned())?;
    drop(stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;
    response
}

fn parse_response(value: &Value, provider_id: &str) -> Result<Vec<String>, String> {
    if let Some(error) = value.get("error") {
        if error.get("code").and_then(Value::as_i64) == Some(-32000) {
            return Err("Goose needs authentication for this provider. Enter its API key in Buzz if it uses one, then retry".into());
        }
        return Err("Goose could not list models for this provider. Check its credentials or try again when its API is available".into());
    }
    if value
        .get("result")
        .and_then(|result| result.get("providerId"))
        .and_then(Value::as_str)
        != Some(provider_id)
    {
        return Err("Goose returned models for a different provider".into());
    }
    let models = value
        .get("result")
        .and_then(|result| result.get("models"))
        .and_then(Value::as_array)
        .ok_or("Goose returned an invalid model list")?;
    if models.len() > 10_000 {
        return Err("Goose model list is too large to display".into());
    }
    models
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|name| {
                    !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .ok_or_else(|| "Goose returned an invalid model name".to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_model_names() {
        assert_eq!(
            parse_response(
                &json!({"result":{"providerId":"anthropic","models":["claude-opus-4-8"]}}),
                "anthropic"
            )
            .unwrap(),
            vec!["claude-opus-4-8"]
        );
        assert!(parse_response(
            &json!({"result":{"providerId":"anthropic","models":["bad\nname"]}}),
            "anthropic"
        )
        .is_err());
        assert!(
            parse_response(&json!({"error":{"message":"secret"}}), "anthropic")
                .unwrap_err()
                .contains("Check its credentials")
        );
        let auth_error = parse_response(
            &json!({"error":{"code":-32000,"data":"secret"}}),
            "anthropic",
        )
        .unwrap_err();
        assert!(auth_error.contains("needs authentication"));
        assert!(!auth_error.contains("secret"));
        assert!(parse_response(
            &json!({"result":{"providerId":"openai","models":[]}}),
            "anthropic"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn one_shot_acp_request_reads_catalog_before_closing_stdin() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("goose");
        std::fs::write(
            &command,
            "#!/bin/sh\nread request\n[ \"$OPENAI_API_KEY\" = 'test-key' ] || exit 1\ncase \"$request\" in\n  *\\\"providerId\\\":\\\"openai\\\"*) printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"providerId\":\"openai\",\"models\":[\"gpt-6-sol\"]}}' ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = fetch(GooseModelContext {
            command,
            workspace: dir.path().into(),
            provider_id: "openai".into(),
            model_id: "gpt-6-sol".into(),
            environment: [("OPENAI_API_KEY".into(), "test-key".into())]
                .into_iter()
                .collect(),
            model_overridden: false,
        })
        .await
        .unwrap();
        assert_eq!(result, vec!["gpt-6-sol"]);
    }
}
