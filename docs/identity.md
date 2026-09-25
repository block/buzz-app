# Packaged human identity — first slice

Native macOS without the live development broker asks the user to **Use an existing
key** or **Create a new identity**. These are alternatives. Import accepts an nsec,
validates its checksum and secp256k1 scalar, and persists that exact key before
adopting its public identity. It never generates a replacement after an import,
read or write failure. Denied/unavailable/corrupt storage is not first run.

One native owner keeps the key in memory after successful restore. The new
create-only Keychain item is service `dev.local.buzz.foundation.identity` in release
builds, or `dev.local.buzz.foundation.identity.debug` with Rust debug assertions,
account `human`, in the default macOS file Keychain. Debug worktrees share the debug
item, not the release identity; ports and frontend dev mode do not isolate it. It uses the same security-framework
primitives as the existing agent adapter, but does not use or change agent
credentials or old Buzz's `buzz-desktop/secrets` blob. A competing item refuses
overwrite. There is no file/environment fallback, automatic legacy migration,
key replacement or delete command. Windows/Linux storage is explicitly unavailable
in this slice; those platforms skip onboarding and keep the unavailable shell.
No user key belongs in release configuration.

A shared credential blob can reduce repeated OS prompts by caching many credentials
after one read. For this one human key, one cached item retains that read-once benefit without
coupling human writes to agent credentials or old-app blob writers. This is not a
claim that per-secret storage is always superior or that prompts are eliminated.
Consent, app signing and update behavior require attended native verification.

## UI and sensitive data

Settings exposes Profile in Personal space as well as in a selected community.
Identity details remains available if the community profile cannot load. The full
npub and hex public key can be copied. The nsec is absent from the rendered field
until Reveal; Copy can fetch it without revealing it. Hide, leaving Profile,
window blur and document hiding retire pending reveals and clear the displayed
secret. Failed private-key actions report fixed errors. Copy deliberately leaves
the key on the OS clipboard; the UI warns about that.

The app UI passes a private string through IPC only during explicit import/export
interaction. JavaScript/IPC string memory is not guaranteed zeroized. Native
key bytes and temporary storage buffers use zeroizing owners, but this is not a
claim that every framework allocation is wiped. No secret is put in public
snapshots, plugin service registrations, localStorage, logs or relay events.
The main app and its same-origin plugins are trusted, not isolated security
principals; plugin JavaScript can invoke `identity_export` directly. Not registering
a plugin key service is an API ownership choice, not a sandbox. The main-webview
command permission is not proof of a human gesture.

## Deliberately not live-ready

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. Native sessions do **not** fall through to the dev broker signer.
Packaged authenticated relay/HTTP/media transport is not implemented here. Identity
readiness is separate from `relayAvailable`: join and community profile editing
show unavailable states, and saved-community icon discovery makes no broker call.
Local profile editing and identity backup remain available. Remote profile
publishing and messaging are not established by this slice.

Development with `VITE_BUZZ_LIVE=1` continues to use its pinned legacy broker
identity, and does not offer native private-key controls. Creating/importing the
new native item does not update that old blob. Future reset/rotation would not
synchronize copies automatically; neither operation is in this scope.

## Try the UI without credentials

Use the existing environment-free fixture Vite config:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1547
```

Open `/tests/fixtures/identity.html`. It uses mock IPC and an in-memory public
fixture key, not Keychain or a relay. Import accepts only the displayed fixture
key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.
