# Buzz pairing protocol

Ported from [`block/buzz`](https://github.com/block/buzz/tree/ac0ad7c3004683e5db813492846d787404a2b475/crates/buzz-core/src/pairing),
PR [#8085](https://github.com/block/buzz/pull/8085), under the repository's
Apache-2.0 license. The imported protocol and tests preserve the source's
cryptography, event validation, timeout, replay protection, legacy confirmation,
and encrypted `desktop-code-v1` capability. Local changes extract the module as its
own crate, make kind 24134 local, update crate paths in documentation, and format
with this repository's pinned tools.

This crate has no network or Keychain access. Desktop transport and account
export are owned by `src-tauri/src/pairing`. Its tests include the exact source
protocol vectors and code-entry proof regressions. Run `bin/cargo test -p
buzz-pairing` for unit tests and doctests.

The desktop-code port also fails closed when an oversized rejection cannot be
serialized: exhausting the guess budget clears the code and aborts before the
fallible reply construction. A regression covers that boundary.
