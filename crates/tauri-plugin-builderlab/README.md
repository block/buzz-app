# Builderlab native companion

The `block.builderlab` Settings plugin owns the UI; this optional Tauri plugin
owns the session. The app includes it only with `--features builderlab`, paired
with `BUZZ_BUILD_BUILDERLAB=1` for the frontend. See
[configuration](../../docs/configuration.md#builderlab-session-shared-with-the-bl-cli).

## Ownership and protocol

- `auth`, `login`, `cancel`, and `sign_out` return only account metadata or fixed
  errors over `plugin:builderlab|…`. The local main webview is the only recipient
  of the plugin's capability. No generic OAuth, credential or authenticated-fetch
  API is exposed.
- Storage is the source of truth. Each operation opens the `builderlab-auth`
  store under the resolved `bl` profile/service key. A mutex serializes this
  process's read/replace/compare-and-delete operations. Writes commit or roll
  back under that same lock; the state lock never spans a Keychain prompt.
- A second login supersedes the first. Cancel/sign-out fence pending writes.
  Once an exchange starts, its spawned finish task survives a lost IPC caller:
  it either persists a verified session or attempts to revoke it. Both displaced
  and canceled minted sessions are revoked. Revocation has a five-second cap;
  server/network failures cannot guarantee remote revocation, and local sign-out
  still proceeds. A rotation observed before local delete is preserved.
- The private callback receiver adapts Jarrod Sibbison's
  [PR #581](https://github.com/block/buzz-app/pull/581) at `5d84bb9174515aa8a50c5a0075c538633c7024c9`:
  loopback-only bind, random single-use path, exact Host, no Origin, GET only,
  8 KiB request cap, 4 KiB code cap, five-second connection deadline and ten-minute
  attempt deadline. Malformed callbacks do not consume the attempt. The response
  uses CSP, no-store and no-referrer, and says the code was received, not that
  verification succeeded. The socket closes before publishing the result.
- kgoose's CLI protocol accepts `{code}` and echoes `returnTo`. It does not offer
  client-bound PKCE or echo OAuth state; those require a server protocol change.
  This is not a general OAuth receiver.
- Exchange credentials must be bounded printable ASCII; `/me` must have a
  nonblank subject. Redirects are disabled, bodies bounded, and only 401/403
  invalidate saved sessions. Transport, truncated/stalled-body, malformed-body
  and 5xx failures preserve the shared item. HTTPS is required except for local
  development loopback endpoints.
- Owned credentials and response buffers use `Zeroizing`; plain credentials
  returned/required by the CLI crate are wiped after use. HTTP, serde, OS and
  storage internals may retain copies. No credential is delivered to JavaScript
  or interpolated into an error.

`builderlab-auth` supplies no transaction shared with other processes. Simultaneous
`bl`/Buzz writes, including whole-file updates across profiles, remain a limitation.
No app-owned credential cache, migration, retry loop or provider registry is added.
Native identity binding and community management remain outside this plugin.

## Validation

```sh
CARGO_TARGET_DIR=target bin/cargo test -p tauri-plugin-builderlab --locked
CARGO_TARGET_DIR=target bin/cargo test -p buzz-foundation --features builderlab --lib browser_permissions_tests --locked
CARGO_TARGET_DIR=target bin/cargo test -p buzz-foundation --lib browser_permissions_tests --locked
CARGO_TARGET_DIR=target bin/cargo test -p buzzodz-plugins --features builderlab --locked
bin/pnpm exec vitest run src/bundled/builderlab src/bundled/hosted-communities
```

The native suite uses a fake HTTP service, real TCP callbacks, the CLI's real
file-store format and gated/failing storage handles. It never touches Keychain.
The app ACL test uses a marker handler, without opening windows or resolving
the real session. Frontend tests mount React and exercise the real adapter with
controlled IPC responses. No browser journeys are added or removed: the changed
contract is plugin registration and account lifecycle, not browser geometry.
Existing broker tests remain; shared-session wording moved to the new card.
Tests for the removed unused `/v1/buzz/*` helper were removed with that API.

Attended macOS Keychain/`bl` interoperability and Windows/Linux file-store runs
remain required before native live-use acceptance. Independent review and human
testing are separate from these automated checks.
