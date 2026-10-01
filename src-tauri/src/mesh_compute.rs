//! App-owned Mesh lifetime. Plugins cannot supply keystore paths or admission policy.

#[cfg(feature = "mesh")]
mod discovery;
#[cfg(feature = "mesh")]
mod lease;

#[derive(Default)]
pub struct MeshHost {
    #[cfg(feature = "mesh")]
    preparing: tokio::sync::Mutex<()>,
    #[cfg(feature = "mesh")]
    lifecycle: buzz_mesh_compute::lifecycle::Lifecycle,
    #[cfg(feature = "mesh")]
    lease: lease::Lease,
}

impl MeshHost {
    pub fn shutdown(&self) {
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
        serde_json::json!({
            "available": true,
            "lifecycle": host.lifecycle.phase(),
            "startAvailable": true,
            "reason": null
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
        {
            host.lease.clear();
            host.lifecycle.stop();
        }
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
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    lease: String,
) -> Result<(), String> {
    let _guard = host
        .preparing
        .try_lock()
        .map_err(|_| "Mesh start is already preparing")?;
    if host.lifecycle.phase() != buzz_mesh_compute::lifecycle::Phase::Stopped {
        return Err("Previous Mesh runtime shutdown is not confirmed".into());
    }
    let community = host.lease.community(&lease)?;
    let (mut owners, targets) = discovery::read(identity.inner(), &community).await?;
    host.lease.with_current(&lease, |_| {
        let path = mesh_owner_path()?;
        let owner = buzz_mesh_compute::identity::ensure_owner_at(&path)
            .map_err(|error| error.to_string())?;
        owners.push(owner.clone());
        let mut targets = targets.into_iter();
        host.lifecycle
            .start(buzz_mesh_compute::config::ClientConfig {
                api_port: mesh_port("BUZZ_MESH_API_PORT", 19337)?,
                console_port: mesh_port("BUZZ_MESH_CONSOLE_PORT", 13131)?,
                owner_key: path,
                owner_id: owner,
                trusted_owners: owners,
                join_token: targets.next(),
                mesh_name: Some(buzz_mesh_compute::config::mesh_name_for_relay(&community)),
            })
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
pub fn mesh_compute_select(
    host: tauri::State<'_, MeshHost>,
    community: String,
) -> Result<String, String> {
    crate::relay::mesh_origin(&community)?;
    host.lease.select_with(community, || host.lifecycle.stop())
}
#[cfg(feature = "mesh")]
#[tauri::command]
pub fn mesh_compute_release(host: tauri::State<'_, MeshHost>, lease: String) -> Result<(), String> {
    if host.lease.revoke(&lease)? {
        host.lifecycle.stop();
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
