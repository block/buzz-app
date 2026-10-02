//! Mainline pre-start path: reuse the selected node, then probe its inference route.
use buzz_agent_controller::{MeshLaunch, MeshRequest};
#[cfg(feature = "mesh")]
use tauri::Manager;

pub(crate) struct Prepared {
    #[cfg(feature = "mesh")]
    app: tauri::AppHandle,
    #[cfg(feature = "mesh")]
    lease: String,
    config: MeshLaunch,
}
impl Prepared {
    // Keep selection stable through final controller admission, not across async reads.
    pub(crate) fn with_current<T>(
        self,
        launch: impl FnOnce(MeshLaunch) -> Result<T, String>,
    ) -> Result<T, String> {
        #[cfg(feature = "mesh")]
        {
            let host = self.app.state::<super::MeshHost>();
            host.lease.with_current(&self.lease, |_| {
                if host.lifecycle.phase() != buzz_mesh_compute::lifecycle::Phase::Ready {
                    return Err("Shared compute stopped before agent launch".into());
                }
                launch(self.config)
            })
        }
        #[cfg(not(feature = "mesh"))]
        {
            let _ = (self.config, launch);
            Err("Mesh native runtime is not included in this build".into())
        }
    }
}

pub(crate) async fn prepare_agent(
    app: &tauri::AppHandle,
    request: MeshRequest,
) -> Result<Prepared, String> {
    #[cfg(not(feature = "mesh"))]
    {
        let _ = (app, request);
        Err("Mesh native runtime is not included in this build".into())
    }
    #[cfg(feature = "mesh")]
    {
        use buzz_mesh_compute::lifecycle::Phase;
        let host = app.state::<super::MeshHost>();
        let identity = app.state::<crate::identity::IdentityHost>();
        let mut community =
            url::Url::parse(&request.relay).map_err(|_| "Invalid agent community")?;
        let scheme = match community.scheme() {
            "wss" => "https",
            "ws" => "http",
            other => other,
        }
        .to_owned();
        community
            .set_scheme(&scheme)
            .map_err(|_| "Invalid agent community")?;
        let community = community.as_str().trim_end_matches('/');
        let lease = host.lease.for_community(community)?;
        if host.lifecycle.phase() == Phase::Stopped {
            super::start(&host, &identity, &lease).await?;
        }
        let port = super::mesh_port("BUZZ_MESH_API_PORT", 19337)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
        let mut last = "Shared compute is starting".to_owned();
        let ready = async {
            loop {
                host.lease.community(&lease)?;
                match host.lifecycle.phase() {
                    Phase::Failed(reason) => return Err(reason),
                    Phase::Stopped | Phase::Stopping => {
                        return Err("Shared compute stopped before agent launch".into())
                    }
                    Phase::Starting => {}
                    Phase::Ready => match probe(&client, port, &request.model).await {
                        Ok((model, context)) => return Ok((model, context)),
                        Err(error) => last = error,
                    },
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        };
        let (model, context) = tokio::time::timeout_at(deadline, ready)
            .await
            .map_err(|_| format!("Shared compute inference did not become ready: {last}"))??;
        host.lease.community(&lease)?;
        let config = MeshLaunch::new(
            request.agent_id,
            request.revision,
            request.relay,
            model,
            (port, context),
        )?;
        Ok(Prepared {
            app: app.clone(),
            lease,
            config,
        })
    }
}

#[cfg(feature = "mesh")]
async fn probe(client: &reqwest::Client, port: u16, model: &str) -> Result<(String, u64), String> {
    let base = format!("http://127.0.0.1:{port}/v1");
    let catalog = client
        .get(format!("{base}/models"))
        .bearer_auth("mesh-local")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    let resolved = buzz_mesh_compute::model_context::resolve(&catalog, model)?;
    client.post(format!("{base}/chat/completions")).bearer_auth("mesh-local")
        .json(&serde_json::json!({"model": resolved.0, "messages": [{"role":"user","content":"Reply OK"}], "max_tokens":1, "stream":false}))
        .send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    Ok(resolved)
}

#[cfg(all(test, feature = "mesh"))]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn readiness_requires_chat_success_and_maps_auto_without_virtual_catalog_entry() {
        for status in [200, 503] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                for chat in [false, true] {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    loop {
                        let mut buf = [0; 1024];
                        let n = socket.read(&mut buf).await.unwrap();
                        assert_ne!(n, 0);
                        request.extend_from_slice(&buf[..n]);
                        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                            let length: usize = header
                                .lines()
                                .find_map(|line| {
                                    line.strip_prefix("content-length:")
                                        .map(|v| v.trim().parse().unwrap())
                                })
                                .unwrap_or(0);
                            if request.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8(request).unwrap();
                    if chat {
                        assert!(text.starts_with("POST /v1/chat/completions"));
                        let body: serde_json::Value =
                            serde_json::from_str(text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                        assert_eq!(body["model"], "mesh");
                        assert_eq!(body["max_tokens"], 1);
                    } else {
                        assert!(text.starts_with("GET /v1/models"));
                    }
                    let body = if chat {
                        "{}"
                    } else {
                        r#"{"data":[{"id":"single-model","metadata":{"context_length":32768}}]}"#
                    };
                    let code = if chat { status } else { 200 };
                    socket.write_all(format!("HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap();
            let result = probe(&client, port, "auto").await;
            if status == 200 {
                assert_eq!(result.unwrap(), ("mesh".into(), 32768));
            } else {
                assert!(result.unwrap_err().contains("503"));
            }
            server.await.unwrap();
        }
    }
}
