//! Refreshes the packager's managed plugin policy from `BUZZ_BUILD_MANAGED_PLUGINS_URL`.
//! A failed or unusable fetch leaves the last good copy in place.
use buzzodz_plugins::{managed, Manager};
use std::time::Duration;

const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY: Duration = Duration::from_secs(15 * 60);
const TIMEOUT: Duration = Duration::from_secs(30);

pub fn spawn(manager: Manager) {
    if managed::PACKAGED_URL.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(TIMEOUT)
            .timeout(TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                eprintln!("Could not prepare the packaged plugin policy client: {error}");
                return;
            }
        };
        loop {
            let wait = match refresh(&client, &manager).await {
                Ok(()) => REFRESH,
                Err(error) => {
                    eprintln!("Could not refresh the packaged plugin policy: {error}");
                    RETRY
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

async fn refresh(client: &reqwest::Client, manager: &Manager) -> Result<(), String> {
    let bytes = fetch(client, managed::PACKAGED_URL).await?;
    let manager = manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.store_packaged_policy(&bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| ())
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if (body.len() + chunk.len()) as u64 > managed::MAX_BYTES {
            return Err("Managed plugin policy exceeds 256 KiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
