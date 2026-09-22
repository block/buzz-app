/// Display-only projection. No signing keys or node lifecycle are exposed here.
#[tauri::command]
pub async fn community_compute_snapshot(
    events: Vec<nostr::Event>,
    authority: String,
    viewer: String,
) -> Result<buzz_community_compute::MeshSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        buzz_community_compute::project(events, &authority, &viewer)
    })
    .await
    .map_err(|error| error.to_string())?
}

use crate::compute_host::{ComputeHost, Status};
use buzz_community_compute::worker::StartRequest;
#[tauri::command]
pub fn community_compute_status(host: tauri::State<'_, ComputeHost>) -> Result<Status, String> {
    host.status()
}
#[tauri::command]
pub async fn community_compute_models() -> Result<buzz_community_compute::MeshModelCatalog, String>
{
    tauri::async_runtime::spawn_blocking(buzz_community_compute::model_catalog)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn community_compute_start(
    host: tauri::State<'_, ComputeHost>,
    request: StartRequest,
) -> Result<Status, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.start(request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn community_compute_stop(
    host: tauri::State<'_, ComputeHost>,
    generation: u64,
) -> Result<Status, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.stop(Some(generation), true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn community_compute_test(
    host: tauri::State<'_, ComputeHost>,
    generation: u64,
    prompt: String,
) -> Result<String, String> {
    let lease = host.begin_test(generation)?;
    let result = buzz_community_compute::consumer::test_request(
        lease
            .status
            .api_base_url
            .as_deref()
            .ok_or("Compute API unavailable")?,
        &prompt,
        || lease.is_current(),
    )
    .await
    .map_err(|e| e.to_string());
    if !lease.is_current() {
        return Err("Compute session changed during the request".into());
    }
    result
}
