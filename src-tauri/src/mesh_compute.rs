//! App-owned Mesh lifetime. Plugins cannot supply keystore paths or admission policy.

mod agent;
#[cfg(feature = "mesh")]
pub(crate) mod sharing;
pub(crate) use agent::prepare_agent;
#[cfg(feature = "mesh")]
mod discovery;
#[cfg(feature = "mesh")]
mod lease;
#[cfg(feature = "mesh")]
mod preferences;
#[cfg(feature = "mesh")]
mod publisher;

#[derive(Default)]
pub struct MeshHost {
    #[cfg(feature = "mesh")]
    preparing: tokio::sync::Mutex<()>,
    #[cfg(feature = "mesh")]
    sharing: std::sync::Mutex<Option<sharing::Share>>,
    #[cfg(feature = "mesh")]
    preferences: std::sync::Mutex<preferences::Preferences>,
    #[cfg(feature = "mesh")]
    lifecycle: buzz_mesh_compute::lifecycle::Lifecycle,
    #[cfg(feature = "mesh")]
    lease: lease::Lease,
    #[cfg(feature = "mesh")]
    publisher: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl MeshHost {
    #[cfg(feature = "mesh")]
    pub fn initialize_preferences(&self, path: Result<std::path::PathBuf, String>) {
        if let Ok(mut prefs) = self.preferences.lock() {
            prefs.initialize(path);
        }
    }
    pub fn shutdown(&self) {
        #[cfg(feature = "mesh")]
        if let Ok(mut publisher) = self.publisher.lock() {
            if let Some(task) = publisher.take() {
                task.abort();
            }
        }
        #[cfg(feature = "mesh")]
        self.lease.clear();
        #[cfg(feature = "mesh")]
        if let Err(error) = tauri::async_runtime::block_on(self.lifecycle.stop_and_wait()) {
            eprintln!("Mesh shutdown could not be confirmed: {error}");
        }
    }
}

#[tauri::command]
pub fn mesh_compute_status(host: tauri::State<'_, MeshHost>) -> serde_json::Value {
    #[cfg(feature = "mesh")]
    {
        let (saved, settings_error) = host
            .preferences
            .lock()
            .map(|prefs| (prefs.hint().cloned(), prefs.error().map(str::to_owned)))
            .unwrap_or_default();
        serde_json::json!({
            "available": true,
            "savedSharing": saved,
            "settingsError": settings_error,
            "lifecycle": host.lifecycle.phase(),
            "download": host.lifecycle.download_progress(),
            "startAvailable": true,
            "reason": null,
            "sharing": host.sharing.lock().ok().and_then(|share| share.as_ref().map(|share| share.model.clone()))
        })
    }
    #[cfg(not(feature = "mesh"))]
    {
        let _ = host;
        serde_json::json!({
            "available": false,
            "reason": "Mesh native runtime is not included in this build"
        })
    }
}

#[tauri::command]
pub async fn mesh_compute_stop(host: tauri::State<'_, MeshHost>) -> Result<(), String> {
    #[cfg(feature = "mesh")]
    {
        let _guard = host.preparing.lock().await;
        {
            let mut sharing = host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?;
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .disarm()?;
            *sharing = None;
        }
        host.lease.clear();
        host.lifecycle.stop();
        host.lifecycle
            .stop_and_wait()
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "mesh"))]
    {
        let _ = host;
        Err("Mesh native runtime is not included in this build".into())
    }
}

#[cfg(all(test, feature = "mesh"))]
mod smoke;

#[cfg(feature = "mesh")]
#[tauri::command]
pub async fn mesh_compute_start(
    app: tauri::AppHandle,
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    lease: String,
) -> Result<(), String> {
    start(&app, host.inner(), identity.inner(), &lease).await
}

#[cfg(feature = "mesh")]
async fn start(
    app: &tauri::AppHandle,
    host: &MeshHost,
    identity: &crate::identity::IdentityHost,
    lease: &str,
) -> Result<(), String> {
    let _guard = host.preparing.lock().await;
    host.lease.community(lease)?;
    if matches!(
        host.lifecycle.phase(),
        buzz_mesh_compute::lifecycle::Phase::Starting | buzz_mesh_compute::lifecycle::Phase::Ready
    ) {
        return Ok(());
    }
    if host.lifecycle.phase() != buzz_mesh_compute::lifecycle::Phase::Stopped {
        return Err("Previous Mesh runtime shutdown is not confirmed".into());
    }
    let community = host.lease.community(lease)?;
    let (mut owners, targets) = discovery::read(identity, &community).await?;
    let viewer = identity.viewer().await?;
    let sharing = host
        .sharing
        .lock()
        .map_err(|_| "Mesh sharing unavailable")?
        .clone();
    if targets.is_empty() && sharing.is_none() {
        return Err(
            "No live community member is sharing compute; start serving on a member first".into(),
        );
    }
    host.lease.with_current(lease, |_| {
        let path = mesh_owner_path()?;
        let owner = buzz_mesh_compute::identity::ensure_owner_at(&path)
            .map_err(|error| error.to_string())?;
        owners.push(owner.clone());
        let mut targets = targets.into_iter();
        let node = buzz_mesh_compute::config::ClientConfig {
            api_port: mesh_port("BUZZ_MESH_API_PORT", 19337)?,
            console_port: mesh_port("BUZZ_MESH_CONSOLE_PORT", 13131)?,
            owner_key: path,
            owner_id: owner,
            trusted_owners: owners,
            join_token: targets.next(),
            mesh_name: Some(buzz_mesh_compute::config::mesh_name_for_relay(&community)),
        };
        match sharing {
            Some(share) => host.lifecycle.serve_observed(
                buzz_mesh_compute::config::ServeConfig {
                    node,
                    model: share.model.clone(),
                    max_vram_gb: share.max_vram_gb,
                },
                sharing::observer(
                    app.clone(),
                    preferences::Config::pending(viewer, community.clone(), &share),
                ),
            ),
            None => host.lifecycle.start(node),
        }
        .map_err(|error| error.to_string())?;
        queue_targets(targets, |token| {
            host.lifecycle
                .dial(token)
                .map_err(|error| error.to_string())
        });
        Ok(())
    })
}

#[cfg(feature = "mesh")]
fn mesh_owner_path() -> Result<std::path::PathBuf, String> {
    buzz_mesh_compute::identity::default_owner_path().map_err(|error| error.to_string())
}
#[cfg(feature = "mesh")]
fn mesh_port(name: &str, fallback: u16) -> Result<u16, String> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| format!("Invalid {name}")),
        Err(std::env::VarError::NotPresent) => Ok(fallback),
        Err(_) => Err(format!("Invalid {name}")),
    }
}

#[cfg(feature = "mesh")]
#[tauri::command]
pub async fn mesh_compute_select(
    app: tauri::AppHandle,
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    community: String,
) -> Result<String, String> {
    crate::relay::mesh_origin(&community)?;
    let viewer = identity.viewer().await?;
    let _guard = host.preparing.lock().await;
    let viewer_changed = host
        .preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .viewer_changed(&viewer);
    let lease = host
        .lease
        .try_select_with(community.clone(), viewer_changed, || {
            let mut sharing = host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?;
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .disarm()?;
            *sharing = None;
            host.lifecycle.stop();
            Ok(())
        })?;
    host.preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .select(viewer, community);
    let restore = host
        .preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .hint()
        .filter(|config| config.enabled)
        .cloned();
    publisher::ensure_started(app.clone(), &host)?;
    drop(_guard);
    if let Some(config) = restore {
        // Mesh owns cached/resumed/fresh acquisition; discovery re-verifies membership before start.
        if host.lifecycle.phase() == buzz_mesh_compute::lifecycle::Phase::Stopped {
            if let Err(error) = sharing::mesh_compute_share(
                app,
                lease.clone(),
                Some(config.model),
                config.max_vram_gb,
            )
            .await
            {
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .set_error(error);
            }
        }
    }
    Ok(lease)
}
#[cfg(feature = "mesh")]
#[tauri::command]
pub async fn mesh_compute_release(
    host: tauri::State<'_, MeshHost>,
    lease: String,
) -> Result<(), String> {
    let _guard = host.preparing.lock().await;
    if host.lease.community(&lease).is_ok() {
        host.lease.with_current(&lease, |_| {
            let mut sharing = host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?;
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .disarm()?;
            *sharing = None;
            host.lifecycle.stop();
            Ok(())
        })?;
        host.lease.revoke(&lease)?;
    }
    Ok(())
}

#[cfg(feature = "mesh")]
fn queue_targets(
    targets: impl IntoIterator<Item = String>,
    mut dial: impl FnMut(&str) -> Result<(), String>,
) {
    for token in targets {
        if dial(&token).is_err() {
            eprintln!("Mesh discovery target could not be queued; client remains started");
        }
    }
}

#[cfg(all(test, feature = "mesh"))]
mod queue_tests {
    #[test]
    fn rejected_secondary_target_does_not_fail_the_started_operation() {
        let mut calls = 0;
        super::queue_targets(["first".into(), "second".into()], |_| {
            calls += 1;
            if calls == 2 {
                Err("fixture rejection".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(calls, 2);
    }
}

/// Signed relay advertisements, not live node health. Does not start Mesh.
#[tauri::command]
pub async fn mesh_compute_inventory(
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    community: String,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "mesh")]
    {
        let inventory = discovery::inventory(identity.inner(), &community).await?;
        serde_json::to_value(inventory).map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "mesh"))]
    {
        let _ = (identity, community);
        Err("Mesh native runtime is not included in this build".into())
    }
}

#[cfg(feature = "mesh")]
#[tauri::command]
pub async fn mesh_compute_catalog() -> Result<buzz_mesh_compute::catalog::Catalog, String> {
    tokio::task::spawn_blocking(buzz_mesh_compute::catalog::catalog)
        .await
        .map_err(|error| format!("Mesh catalog task failed: {error}"))?
        .map_err(|error| error.to_string())
}
