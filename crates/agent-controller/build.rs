mod build_config;

fn main() {
    println!(
        "cargo:rustc-env=BUZZ_RUNTIME_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let local = root.join("../../.env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    println!("cargo:rerun-if-changed=build_config.rs");
    for key in build_config::KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let values = build_config::load(&local, |key| match std::env::var(key) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("Native build inputs must be UTF-8"),
    })
    .expect("Invalid native build configuration");
    let raw = values
        .get("BUZZ_BUILD_AGENT_ENV")
        .map(String::as_str)
        .unwrap_or("");
    let (host, filter, model) = build_config::parse(raw).expect("Invalid agent build defaults");
    let provider = values
        .get("BUZZ_BUILD_BUZZ_AGENT_PROVIDER")
        .map(String::as_str)
        .unwrap_or("");
    build_config::selector(provider, 128).expect("Invalid agent provider default");
    let owner_only = values.contains_key("BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY");
    let session_policy = values
        .get("BUZZ_BUILD_ACP_SESSION_POLICY")
        .map(String::as_str)
        .unwrap_or("");
    build_config::session_policy(session_policy).expect("Invalid ACP session policy default");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    // Always overwrite: removing local/process inputs clears a warm build too.
    std::fs::write(output.join("agent_defaults.rs"), format!(
        "pub fn build_defaults() -> BuildDefaults {{ BuildDefaults {{ host: {host:?}.into(), filter: {filter:?}.into(), model: {model:?}.into(), provider: {provider:?}.into(), owner_only: {owner_only}, session_policy: {session_policy:?}.into() }} }}"
    )).expect("Could not write native build defaults");
}
