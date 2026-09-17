//! Native mesh capability: supervises a single in-process `mesh-llm-sdk`
//! serve node. Scaffold scope (1a+2a): start / stop / status only. No mesh
//! discovery, coordinator or recovery — those remain the legacy subsystem's
//! responsibility and are follow-up work. No-leak invariants match legacy:
//! never publish presence, never auto-join, no public Nostr relays.
use mesh_llm_sdk::{serve, EmbeddedNodeHandle, MeshDiscoveryMode};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

const DEFAULT_API_PORT: u16 = 9337;
const DEFAULT_CONSOLE_PORT: u16 = 3131;
/// First model load can include a multi-GB download plus warmup; the SDK
/// default (30s) times out long before that. Matches legacy `MESH_STARTUP_TIMEOUT`.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
/// Bound an explicit shutdown so app exit is never blocked indefinitely.
const STOP_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Default)]
struct Node {
    handle: Option<EmbeddedNodeHandle>,
    model: Option<String>,
}

/// One optional serve node, guarded for concurrent command access.
#[derive(Clone, Default)]
pub struct Mesh(Arc<Mutex<Node>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshStatus {
    running: bool,
    api_base_url: Option<String>,
    console_url: Option<String>,
    model: Option<String>,
}

impl MeshStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            api_base_url: None,
            console_url: None,
            model: None,
        }
    }
    fn running(handle: &EmbeddedNodeHandle, model: &str) -> Self {
        Self {
            running: true,
            api_base_url: Some(handle.api_base_url().to_string()),
            console_url: Some(handle.console_url().to_string()),
            model: Some(model.to_string()),
        }
    }
}

impl Mesh {
    /// Best-effort blocking stop for the app exit hook.
    pub fn shutdown(&self) {
        let state = self.0.clone();
        let _ = tauri::async_runtime::block_on(async move {
            let mut node = state.lock().await;
            if let Some(handle) = node.handle.take() {
                node.model = None;
                let _ = tokio::time::timeout(STOP_TIMEOUT, handle.stop()).await;
            }
        });
    }
}

#[tauri::command]
pub async fn mesh_status(mesh: tauri::State<'_, Mesh>) -> Result<MeshStatus, String> {
    let node = mesh.0.lock().await;
    Ok(match (&node.handle, &node.model) {
        (Some(handle), Some(model)) => MeshStatus::running(handle, model),
        _ => MeshStatus::stopped(),
    })
}

#[tauri::command]
pub async fn mesh_start(
    mesh: tauri::State<'_, Mesh>,
    model: String,
) -> Result<MeshStatus, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("A model id is required to serve".into());
    }
    let mut node = mesh.0.lock().await;
    if node.handle.is_some() {
        return Err("A mesh node is already running. Stop it first.".into());
    }
    let config = serve::EmbeddedServeConfig::builder()
        .model(model.clone())
        .api_port(DEFAULT_API_PORT)
        .console_port(DEFAULT_CONSOLE_PORT)
        // No-leak invariants (mirror legacy): never publish presence, never
        // auto-join, discover only via Nostr, no public Nostr relays.
        .publish(false)
        .auto_join(false)
        .discovery_mode(MeshDiscoveryMode::Nostr)
        .console_ui(true)
        .startup_timeout(STARTUP_TIMEOUT)
        .build();
    let handle = serve::start(config).await.map_err(|e| e.to_string())?;
    let status = MeshStatus::running(&handle, &model);
    node.handle = Some(handle);
    node.model = Some(model);
    Ok(status)
}

#[tauri::command]
pub async fn mesh_stop(mesh: tauri::State<'_, Mesh>) -> Result<MeshStatus, String> {
    let mut node = mesh.0.lock().await;
    if let Some(handle) = node.handle.take() {
        node.model = None;
        tokio::time::timeout(STOP_TIMEOUT, handle.stop())
            .await
            .map_err(|_| "Timed out stopping the mesh node".to_string())?
            .map_err(|e| e.to_string())?;
    }
    Ok(MeshStatus::stopped())
}
