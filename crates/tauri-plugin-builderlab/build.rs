fn main() {
    tauri_plugin::Builder::new(&["auth", "login", "cancel", "sign_out"]).build();
}
