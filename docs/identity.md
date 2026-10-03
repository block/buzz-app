# Packaged human identity and relay access

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
into this app's separate agent namespace; it never writes the old blob. Agent
import remains macOS-only; Create also saves new agent keys through the
Windows/Linux adapters (see [local agent controls](agent-control.md)).
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

## Packaged connection

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. On macOS, Windows and Linux, app composition supplies the shared
native relay adapter after identity restoration. Windows/Linux installed-app
transport acceptance remains unverified. Only the selected saved community opens on restart; Personal
space stays disconnected. Discovery failure leaves the community retryable.
Native sessions do **not** fall through to the dev broker signer.

An enterprise-enabled build can bind a configured trusted relay allowlist to a
separately configured identity adapter. Native NIP-11 discovery, not the
adapter URL, decides whether a matching relay requires enterprise sign-in.
Ordinary relays continue without this gate. Required sign-in opens the
adapter in the external browser, returns through a nonce-bound loopback
callback, and exchanges the code with a SHA-256 handoff verifier. The native
host validates the returned session and exact expiry, then stores the session
in OS secure storage scoped to the adapter, active human identity, and
debug/release build. Restore checks the adapter session again; transient
network failures preserve the saved credential, while failed or inconsistent
checks clear only the matching session when secure storage permits. JavaScript
receives status and expiry only, never the session secret.

Profile settings can clear the saved enterprise session on this device for the
current adapter, active identity, and build. This is local sign-out only: it
does not remove the Nostr identity, community memberships, or remote access.
The native session is shared by the applicable communities in that scope; it
is not a per-community token store.

The native identity owner signs event templates and authenticates HTTP with
NIP-98, including the exact request URL, method, a body hash on POST and a fresh nonce
for each attempt. Native networking permits only discovery, join-policy, invite
mint/acceptance/claim, relay-advertised GIF search, query, event and bounded
workflow run-history routes on HTTPS origins, with bounded bodies, timeouts and
no redirects. JavaScript never obtains the private key for transport.
NIP-11 `self` establishes relay authority; the operator-contact `pubkey` is not
a substitute. The existing live owner handles WSS/NIP-42 authentication and
signature verification. IPC permissions remain limited to the main WebView.

Channel lifecycle/details and identity archive commands, channel recipe preparation/decoding,
and opening direct messages use purpose-bound native commands. Creation kind 9007 is
advertised only when NIP-11 reports NIP-29 support. NIP-44 stays in the native
identity owner; recipe plaintext is never returned by a generic decrypt command.

Community admission, kind-0 profile reads/publication, the NIP-43 leave request
(kind 28936, signed only in its empty protected shape) and the adapter's advertised
message/event writes use this identity. [Join recovery](communities.md#packaged-admission-and-recovery)
records public progress before remote changes. The existing durable outbox retains
uncertain delivery across restart; retry uses the same signed event with fresh HTTP
authentication. Events older than 15 minutes get a strong ID readback instead of
being republished or silently re-dated. Missing/failed readback retains uncertainty;
the user must inspect the conversation before explicitly sending a new message.

Protected media and uploads are native, because the webview cannot attach Blossom
(kind 24242) authentication itself: `<img>`, `<video>` and `<audio>` send no custom
headers, and the CSP keeps `connect-src` closed to general HTTPS. Relay `/media/`
URLs selected by shared TypeScript render through the `buzz-media` URI scheme,
which validates HTTPS and the `/media/<hash>` URL shape but does not enforce
saved-community membership; the selected server receives a short-lived token
scoped to its origin. The scheme signs a fresh 60-second `get` token per request
and forwards only a bounded single `Range`; non-image/video/audio types (and SVG)
are served with download disposition and `nosniff`. The main webview does not navigate to protected media for downloads: a narrowly scoped native command authenticates the bounded media GET, saves to the OS Downloads directory without replacing existing files, and rejects unsafe filenames. `relay_upload`
hashes, signs (`upload` + `x`) and sends the exact bytes JavaScript passes it;
shared TypeScript (`hostUpload`) owns limits, error mapping and descriptor
validation. JavaScript never signs kind 24242. Packaged HEIC and video
preparation uses fixed demuxers and ffmpeg arguments in the native host, then
hashes and uploads only the converted bytes; JavaScript receives the descriptor,
not the prepared file. ffmpeg must be installed on the computer.
Member changes, repository HTTP and other broker-only helpers are not claimed
by this adapter. For relays on the build's trusted enterprise list, the native
host obtains a NIP-FI assertion from the enterprise adapter (session in
`Authorization: Bearer`, a host-signed NIP-98 proof in `Nostr-Authorization`)
and sends it as `Nostr-Federated-Identity` on protected relay HTTP, upload and
media requests. The live socket for those relays is a native WebSocket
(`relay_socket.rs`) that fetches a fresh assertion and sends the same header
itself, so neither the assertion nor the session token reaches JavaScript.
Frames are delivered only after JavaScript starts the socket, and every ended
connection releases its native stream. Only 401
`session_required`/`session_expired` clear the session and reopen sign-in, and
only while the refused token is still the current session: a refusal of a
session already removed or replaced is retried, and never cancels or undoes a
newer login, including one still in the browser. Native stops using the
refused token before it asks secure storage to remove it, so badge and media
requests no longer send it even if removal is slow or fails. If removal fails,
the refusal is also recorded in the app data directory, so the stored session
stays refused after a restart until a later session check removes it or a new
login replaces it; if that record cannot be written either, a restart may send
the token once more and the adapter's refusal is handled the same way. When
native reports sign-in required, the selected enterprise community shows
sign-in without rechecking the refused session, rediscovering the relay or
waiting for a sign-out already in progress, and a background community's
prompt does not replace it. A login in progress is never canceled by it. 403 `authorization_denied` keeps the session and stops that relay with
access denied. Every other refusal, and a malformed badge response, keeps the
session, stops that relay and shows the error. Only 429, 503, network
failures and a native connect that misses its 30 s bound (which covers secure
storage, signing, the badge request and the handshake) use the bounded
reconnect backoff.
Windows/Linux custody, credential migration and release-signing acceptance remain
separate limitations.

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

Deferred until agent import/create is enabled on Windows/Linux: explicitly import
a throwaway old-Buzz agent, restart and verify the exact key, then delete only the
destination agent and verify the old source remains. This is not a reachable UI
acceptance step for this storage slice and does not establish Windows execution.

Attended Windows/Linux execution and human confirmation are release gates, not
claims made by cross-compilation, fake-store tests, or the browser fixture.
