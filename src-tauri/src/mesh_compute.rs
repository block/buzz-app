//! Stable disabled-build response; the optional runtime stays outside default builds.

#[tauri::command]
pub fn mesh_compute_status() -> serde_json::Value {
    #[cfg(feature = "mesh")]
    {
        serde_json::json!(buzz_mesh_compute::status())
    }
    #[cfg(not(feature = "mesh"))]
    {
        serde_json::json!({
            "available": false,
            "reason": "Mesh native runtime is not included in this build"
        })
    }
}
