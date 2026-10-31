//! Compiles the build's credential namespace into `namespaced!`, so every
//! key-custody name stays a `const` and one build input moves all of them.
fn main() {
    const NAME: &str = "BUZZ_BUILD_CREDENTIAL_NAMESPACE";
    println!("cargo:rerun-if-env-changed={NAME}");
    let namespace = std::env::var(NAME).unwrap_or_else(|error| match error {
        std::env::VarError::NotPresent => String::new(),
        std::env::VarError::NotUnicode(_) => panic!("Invalid {NAME}"),
    });
    // `debug` would make release names equal the development build's.
    let valid = namespace.len() <= 32
        && namespace != "debug"
        && namespace.split('-').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if !namespace.is_empty() && !valid {
        panic!("Invalid {NAME}: use lowercase letters, digits and inner hyphens, at most 32, not `debug`");
    }
    let suffix = if namespace.is_empty() {
        String::new()
    } else {
        format!(".{namespace}")
    };
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("namespaced.rs");
    std::fs::write(
        out,
        format!(
            "/// Appends this build's `{NAME}`, if any, to a key-custody name.\n\
             #[macro_export]\n\
             macro_rules! namespaced {{\n    ($name:literal) => {{\n        concat!($name, {suffix:?})\n    }};\n}}\n"
        ),
    )
    .unwrap();
}
