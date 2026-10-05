# Buzz pairing protocol

Ported from [`block/buzz`](https://github.com/block/buzz/tree/530c3a454ecf4808237ca566c515d3d5a10d59a9/crates/buzz-core/src/pairing),
PR [#8085](https://github.com/block/buzz/pull/8085), under the repository's
Apache-2.0 license. The imported protocol and tests preserve the source's
cryptography, event validation, timeout, replay protection, legacy confirmation,
and encrypted `code-entry` capability. Local changes extract the module as its
own crate, make kind 24134 local, update crate paths in documentation, and format
with this repository's pinned tools.

This crate has no network or Keychain access. Desktop transport and account
export are owned by `src-tauri/src/pairing`. Its tests include the exact source
protocol vectors and code-entry proof regressions. Run `bin/cargo test -p
buzz-pairing` for unit tests and doctests.
