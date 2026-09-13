mod build_config;
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
    tauri_build::build()
}
