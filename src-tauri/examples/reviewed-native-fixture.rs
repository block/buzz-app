//! Explicit human-ready launch only; this example opens native windows.
fn main() {
    #[cfg(debug_assertions)]
    buzz_foundation_lib::run_reviewed_invocation_fixture();
    #[cfg(not(debug_assertions))]
    panic!("Manual fixture is available only in debug builds");
}
