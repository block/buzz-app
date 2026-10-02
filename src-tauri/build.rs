#[path = "src/enterprise_relay_url.rs"]
mod enterprise_relay_url;

fn main() {
    configure_enterprise_auth();
    // Release builds enable the updater only when both values are supplied; its
    // `plugins.updater` config comes from the same values via `tauri build --config`.
    println!("cargo:rerun-if-env-changed=BUZZ_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=BUZZ_UPDATER_ENDPOINT");
    println!("cargo:rustc-check-cfg=cfg(buzz_updater_enabled)");
    let configured = |name| std::env::var(name).is_ok_and(|value| !value.trim().is_empty());
    if configured("BUZZ_UPDATER_PUBLIC_KEY") && configured("BUZZ_UPDATER_ENDPOINT") {
        println!("cargo:rustc-cfg=buzz_updater_enabled");
    }
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource linker covers bin targets, not the lib unit-test EXE.
        // Link the same manifest into both without changing icons/version resources.
        // https://github.com/tauri-apps/tauri/issues/13419
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(
        attributes.app_manifest(tauri_build::AppManifest::new().commands(&[
            "identity_restore",
            "identity_import",
            "identity_create",
            "identity_export",
            "identity_prepare_remote_agent_authorization",
            "enterprise_login_gate",
            "relay_sign",
            "relay_decode_read_state",
            "relay_sign_read_state",
            "relay_publish_read_state",
            "relay_http",
            "relay_workflow_runs",
            "relay_channel_sign",
            "relay_channel_publish",
            "relay_kit_sign",
            "relay_kit_prepare",
            "relay_kit_decode",
            "relay_direct_message",
            "relay_decode_sidebar",
            "relay_sign_sidebar",
            "relay_agent_resolve",
            "relay_agent_log_proof",
            "relay_agent_observer",
            "relay_agent_memories_read",
            "relay_agent_library",
            "relay_upload",
            "relay_upload_cancel",
            "media_download",
            "get_os_idle_seconds",
            "plugin_import_folder",
            "plugin_import_git",
            "plugin_import_install",
            "plugin_import_discard",
            "plugin_catalog",
            "plugin_change",
            "plugin_reload",
            "plugin_module",
            "plugin_recover",
            "plugin_host_run_command",
            "plugin_host_request",
            "agent_control_create_prepare",
            "agent_control_create_authorize",
            "agent_control_create_commit",
            "agent_control_creation_profile",
            "agent_control_snapshot",
            "agent_control_log_challenge",
            "agent_control_read_log",
            "pi_install",
            "agent_security",
            "agent_control_save",
            "agent_control_save_defaults",
            "agent_control_start_on_app_launch",
            "agent_control_delete",
            "agent_control_action",
            "agent_control_attach_mention",
            "agent_control_import_preview",
            "agent_control_import_commit",
            "agent_control_local_clone_settings",
            "agent_control_clone_settings",
            "agent_control_use_here",
            "agent_models_begin",
            "agent_models_cancel",
            "agent_models_run",
            "title_bar_double_click",
            "notification_show",
            "dock_permission",
            "unread_indicator_set",
            "deep_link_take",
            "deep_link_watch",
            "terminal_create_owner",
            "terminal_spawn",
            "terminal_read",
            "terminal_write",
            "terminal_resize",
            "terminal_close",
            "terminal_close_owner",
            "update_restart",
            "browser_attach",
            "browser_set_bounds",
            "browser_detach",
            "browser_navigate",
            "browser_action",
            "browser_status",
        ])),
    )
    .expect("Could not build Tauri resources")
}

fn configure_enterprise_auth() {
    const RELAYS: &str = "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS";
    const ADAPTER: &str = "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL";
    println!("cargo:rerun-if-env-changed={RELAYS}");
    println!("cargo:rerun-if-env-changed={ADAPTER}");

    let relays = std::env::var(RELAYS)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let adapter = std::env::var(ADAPTER)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty());

    if relays.is_some() && adapter.is_none() {
        panic!("{ADAPTER} is required when {RELAYS} is configured");
    }
    if let Some(relays) = relays.as_deref() {
        enterprise_relay_url::parse_enterprise_relay_allowlist(relays)
            .unwrap_or_else(|_| panic!("{RELAYS} contains an unsupported or unsafe URL"));
        println!("cargo:rustc-env={RELAYS}={relays}");
    }
    if let Some(adapter) = adapter.as_deref() {
        enterprise_relay_url::validate_enterprise_adapter_url(adapter)
            .unwrap_or_else(|_| panic!("{ADAPTER} contains an unsupported or unsafe URL"));
        println!("cargo:rustc-env={ADAPTER}={adapter}");
    }
}
