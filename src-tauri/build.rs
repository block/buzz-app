mod build_config;
mod build_resources;
fn main() {
    println!("cargo:rerun-if-env-changed=BUZZ_BUILD_AGENT_ENV");
    println!("cargo:rerun-if-changed=build_config.rs");
    let raw = std::env::var("BUZZ_BUILD_AGENT_ENV").unwrap_or_default();
    let (host, filter) =
        build_config::parse(&raw).expect("Invalid private agent build configuration");
    // Write even when unset: a same-target public rebuild must clear prior defaults.
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::write(
        output.join("agent_defaults.rs"),
        format!("pub const HOST: &str = {host:?};\npub const FILTER: &str = {filter:?};\n"),
    )
    .expect("Could not write native connection defaults");
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
    tauri_build::try_build(attributes).expect("Could not build Tauri resources");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let profile = output.ancestors().nth(3).expect("Cargo profile directory");
        build_resources::refresh_runtime_inodes(&profile.join("agent-runtime"))
            .expect("Could not publish fresh agent runtime resources");
    }
}
