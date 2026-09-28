# Packaged human identity — first slice

Native macOS, Windows and Linux without the live development broker offer
**Use an existing key** or **Create a new identity**. These are alternatives. Import accepts an nsec,
validates its checksum and secp256k1 scalar, and persists that exact key before
adopting its public identity. It never generates a replacement after an import,
read or write failure. Denied/unavailable/corrupt storage is not first run.

One native owner keeps the key in memory after successful restore. The new
create-only secure-storage item is service `dev.local.buzz.foundation.identity` in release
builds, or `dev.local.buzz.foundation.identity.debug` with Rust debug assertions,
account `human`. Debug worktrees share the debug item, not the release identity;
ports and frontend dev mode do not isolate it. macOS keeps its existing default
file Keychain/security-framework implementation. Windows uses Credential Manager;
Linux uses Secret Service through keyring 3.6.3, as old Buzz does. Linux requires
a running desktop Secret Service with a default collection (for example GNOME
Keyring), reachable on the user's session D-Bus. Missing, inaccessible or ambiguous
storage fails closed: unlock/configure the store and explicitly retry.

Human storage does not use or change agent credentials or old Buzz's
`buzz-desktop/secrets` blob. A competing item refuses overwrite. Windows/Linux
creates and agent deletes share a per-user, service/account file lock under the
OS account's home `.buzz-foundation/credential-locks`, independent of HOME/XDG,
profile and worktree overrides. Lock files are empty, retained, and never hold keys;
a busy lock reports a retryable error rather than waiting behind another process's
consent dialog. Locks serialize cooperating Buzz instances, not arbitrary other
programs or other machines. Windows credentials use keyring's enterprise persistence
and may roam under Windows policy; locks do not coordinate machines.
Neither Windows Credential Manager nor Secret Service supplies per-app access
isolation from other programs running as the same OS user.

There is no file/environment fallback, automatic legacy migration, human key
replacement or human delete command. The existing **explicit agent import** may
read only the selected old Buzz service/account and copy the selected agent key
into this app's separate agent namespace; it never writes the old blob.
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
fixture key, not an OS credential store or a relay. Import accepts only the
displayed fixture key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.

### Windows/Linux native acceptance (not established by the fixture)

Use a disposable **OS account/VM**, not a profile, port or HOME override: credentials
are per OS user. Use only throwaway keys, keep old Buzz closed for import handover,
and do not connect that identity to a real community for this storage check.

- On Windows and Linux with a working Secret Service/default collection, create
  or import, export the throwaway key, quit/relaunch, and confirm the same public
  identity and export. Repeat separately for debug and release builds.
- With an existing Linux key locked, dismiss the unlock request. Expect a storage
  error/retry, not first-run create/import choices; unlock and retry to restore.
  Without Secret Service, expect an error rather than key generation/fallback.
- Where two development instances can run, an occupied human/agent item must not
  be overwritten. Lock contention must be retryable; after exit, locks release.
- Explicitly import a throwaway old-Buzz agent into this app, restart and verify
  the exact key. Delete only the destination agent; its old source must remain.
  This does **not** establish Windows agent execution, which remains separate work.

Attended Windows/Linux execution and human confirmation are release gates, not
claims made by cross-compilation, fake-store tests, or the browser fixture.
