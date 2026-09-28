//! Bounded test request through the owned consumer's loopback API.
use anyhow::{bail, Context};
use serde_json::{json, Value};
use std::time::Duration;

async fn read(mut response: reqwest::Response) -> anyhow::Result<Value> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 65536 {
            bail!("Compute response exceeds limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        bail!("Compute request failed ({status}); check provider and connection");
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn test_request(
    api: &str,
    prompt: &str,
    is_current: impl Fn() -> bool,
) -> anyhow::Result<String> {
    if !is_current() {
        bail!("Compute session changed");
    }
    let cancelled = async {
        while is_current() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::select! {
        result = run_request(api, prompt) => result,
        _ = cancelled => anyhow::bail!("Compute request cancelled"),
    }
}
async fn run_request(api: &str, prompt: &str) -> anyhow::Result<String> {
    let url = url::Url::parse(api)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/v1"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Invalid owned compute API");
    }
    if prompt.trim().is_empty() || prompt.len() > 2000 {
        bail!("Enter a prompt of up to 2,000 bytes");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()?;
    let models = read(client.get(format!("{api}/models")).send().await?).await?;
    let model = models.pointer("/data/0/id").and_then(Value::as_str).context("No remote model is available yet. Start the provider, then reconnect if admission changed.")?;
    let request = completion_request(model, prompt);
    let response = read(
        client
            .post(format!("{api}/chat/completions"))
            .json(&request)
            .send()
            .await?,
    )
    .await?;
    let text = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .context("The provider returned no text")?;
    Ok(text.to_owned())
}

fn completion_request(model: &str, prompt: &str) -> Value {
    let mut request = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 128,
        "stream": false,
    });
    // Qwen 3.5 defaults to reasoning mode. The short connectivity probe's
    // 128-token budget can be consumed entirely by its hidden reasoning output,
    // yielding `content: null` even though the provider is healthy.
    if model.to_ascii_lowercase().contains("qwen3.5") {
        request["chat_template_kwargs"] = json!({"enable_thinking": false});
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };
    #[test]
    fn short_probe_disables_qwen_35_reasoning_only_for_that_model_family() {
        let qwen = completion_request("unsloth/Qwen3.5-9B-GGUF:Q4_K_M", "hello");
        assert_eq!(qwen["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(qwen["max_tokens"], 128);

        let other = completion_request("some/other-model", "hello");
        assert!(other.get("chat_template_kwargs").is_none());
    }
    #[tokio::test]
    async fn refuses_non_owned_endpoints_and_cancels_pending_model_lookup() {
        assert!(test_request("https://example.com/v1", "hello", || true)
            .await
            .is_err());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!(
            "http://127.0.0.1:{}/v1",
            listener.local_addr().unwrap().port()
        );
        let current = Arc::new(AtomicBool::new(true));
        let (started, receive) = tokio::sync::oneshot::channel();
        let server_current = current.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buf = [0; 4096];
            let count = stream.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..count]).starts_with("GET /v1/models"));
            started.send(()).unwrap();
            while server_current.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
        });
        let request_current = current.clone();
        let request = tokio::spawn(async move {
            test_request(&api, "private test prompt", || {
                request_current.load(Ordering::SeqCst)
            })
            .await
        });
        receive.await.unwrap();
        current.store(false, Ordering::SeqCst);
        assert!(tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        server.join().unwrap();
    }
}
