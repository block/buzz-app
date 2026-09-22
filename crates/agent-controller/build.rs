fn main() {
    println!(
        "cargo:rustc-env=BUZZ_RUNTIME_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
}
