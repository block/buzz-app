//! One-shot Goose ACP catalog lookup. The child never receives a Buzz identity.
use buzz_agent_controller::GooseModelContext;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const METHOD: &str = "_goose/unstable/providers/supported-models/list";

pub(super) async fn fetch(context: GooseModelContext) -> Result<Vec<String>, String> {
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
        "params": { "providerId": "databricks_v2" }
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
                return parse_response(&value);
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

fn parse_response(value: &Value) -> Result<Vec<String>, String> {
    if value.get("error").is_some() {
        return Err("Goose could not list Databricks v2 models. Check Goose sign-in with `goose configure`, then retry".into());
    }
    if value
        .get("result")
        .and_then(|result| result.get("providerId"))
        .and_then(Value::as_str)
        != Some("databricks_v2")
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
            parse_response(&json!({"result":{"providerId":"databricks_v2","models":["catalog.schema.goose-glm-5-3"]}})).unwrap(),
            vec!["catalog.schema.goose-glm-5-3"]
        );
        assert!(parse_response(
            &json!({"result":{"providerId":"databricks_v2","models":["bad\nname"]}})
        )
        .is_err());
        assert!(parse_response(&json!({"error":{"message":"secret"}})).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn one_shot_acp_request_reads_catalog_before_closing_stdin() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("goose");
        std::fs::write(
            &command,
            "#!/bin/sh\nread request\ncase \"$request\" in\n  *supported-models/list*) printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"providerId\":\"databricks_v2\",\"models\":[\"catalog.schema.goose-glm-5-3\"]}}' ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = fetch(GooseModelContext {
            command,
            environment: Default::default(),
            model_overridden: false,
        })
        .await
        .unwrap();
        assert_eq!(result, vec!["catalog.schema.goose-glm-5-3"]);
    }
}
