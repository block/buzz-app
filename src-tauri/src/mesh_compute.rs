//! App-owned Mesh lifetime. Plugins cannot supply keystore paths or admission policy.

#[derive(Default)]
pub struct MeshHost {
    #[cfg(feature = "mesh")]
    lifecycle: buzz_mesh_compute::lifecycle::Lifecycle,
}

impl MeshHost {
    pub fn shutdown(&self) {
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
            "startAvailable": false,
            "reason": "Verified community Mesh admission is not connected yet"
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
