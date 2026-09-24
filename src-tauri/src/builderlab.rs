use buzz_builderlab_client::{get_auth_status, SessionStatus};

#[tauri::command]
pub async fn builderlab_session_status() -> SessionStatus {
    get_auth_status().await
}
