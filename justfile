# FOUNDATION: Shared developer commands. Keep this interface small and stable.

# List available commands.
default:
    @just --list

[private]
install:
    pnpm install --frozen-lockfile

# Run the shared frontend in a browser.
web: install
    pnpm dev

# Run the shared frontend in Tauri (requires native toolchain).
desktop: install
    pnpm tauri dev

# Run buzzodz; forward arguments unchanged (Rust required).
[positional-arguments]
cli *args:
    @cargo run --quiet --locked --manifest-path crates/plugin-manager/Cargo.toml --bin buzzodz -- "$@"

# Reserved for the frontend and local Docker relay backend.
fullstack:
    @echo "Not implemented: fullstack will run Buzz with a local Docker relay backend." >&2
    @exit 1

# Fast feedback: safe fixes, formatting, type checking, and frontend build; no tests.
iterate: install
    cargo fmt --all
    pnpm exec biome check --write --error-on-warnings .
    pnpm build

# Broader validation; does not auto-fix source files. First Rust build can be slow.
scan: install
    pnpm check
    pnpm test
    cargo fmt --all --check
    pnpm build
    cargo clippy --workspace --locked --all-targets -- -D warnings
    cargo test --manifest-path src-tauri/Cargo.toml --locked
