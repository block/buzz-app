fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notification_show",
            "terminal_create_owner",
            "terminal_spawn",
            "terminal_read",
            "terminal_write",
            "terminal_resize",
            "terminal_close",
            "terminal_close_owner",
            "plugin_import_folder",
            "plugin_import_git",
            "plugin_import_install",
            "plugin_import_discard",
            "plugin_catalog",
            "plugin_change",
            "plugin_module",
            "plugin_recover",
            "browser_open",
            "browser_navigate",
            "browser_action",
            "browser_status",
        ]),
    ))
    .expect("failed to generate native command permissions")
}
