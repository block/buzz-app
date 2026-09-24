use buzz_builderlab_client::{check_from_env, SessionStatus};

#[tauri::command]
pub async fn builderlab_session_status() -> SessionStatus {
    check_from_env().await
}
