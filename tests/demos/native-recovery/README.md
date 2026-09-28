# Native admission and recovery recordings

Manual, paced recordings of the **unchanged Buzz application**, covering
`78d986c0` and `d6f0748e`. This imports the real `src/main.tsx`, bundled plugins,
community dialog, native adapter, relay session, composer and outbox. It extends
the IPC-fixture approach in `tests/browser/native-relay.spec.mjs`; it does not
draw a substitute application or add a CI browser matrix.

## Reproduce

From this worktree with locked dependencies and Playwright Chromium installed:

```sh
source bin/activate-hermit
node tests/demos/native-recovery/capture.mjs
node tests/demos/native-recovery/finish.mjs
open artifacts/native-recovery/index.html
```

`finish.mjs` also requires `ffmpeg` and `ffprobe` with H.264 encoding. The capture
command accepts individual clip IDs as arguments. `DEMO_OUTPUT` can override the
output folder; keep any alternate output outside Git. The default durable folder
`artifacts/native-recovery/` is ignored and is not inside disposable test results.
Reruns replace named outputs; copy an old recording directory first if retaining
another snapshot matters.

The scripts start an environment-free Vite server on an available loopback port,
create fresh browser contexts, and close both at completion. No `.env.local`,
development broker, existing browser profile, Keychain, installed app, real
identity, shared community, or external service is used. HTTP is restricted to
loopback; the fake `.invalid` relay WebSocket is intercepted.
Native plugin catalog/agent/window/notification/deep-link IPC is modeled only as
needed to mount the actual app. There is no native process or agent execution.
Source watching is disabled so artifact writes cannot reload a recording.

## Coverage

Every ID names an MP4, raw WebM, JSON assertion record, subtitles, and sample
frames. The generated `index.html` is a playable gallery. `TIMESTAMPS.md` maps
cases to capture-clock chapter timestamps and `verification.json` records media
properties, SHA-256, sampled pixel variation, full decode and Chromium playback.
Chapters mark observed outcomes; preceding visible actions demonstrate how the
app reached them. MP4s trim only the initial loading interval before the first
ready-app marker; the timestamp map and subtitles subtract that same offset.
The raw WebMs retain the whole capture. Timestamps are not performance measurements.

| Clip | Visible workflow and checked outcome | Owning regression coverage |
| --- | --- | --- |
| `01-member-messaging-restoration` | Existing profile opens with no invite claim or profile publication; history loads, composer sends, live reply arrives; selected community/conversation and Personal selection restore on reload | `relay/native.test.ts`, `communities/native-join.test.tsx` |
| `02-invite-policy-profile` | Policy/age gates, invite admission, profile completion, verified readback and selected membership | `communities/native-join.test.tsx` |
| `03-uncertain-send` | Lost receipt, durable IndexedDB state, reload without automatic resend, explicit retry of identical signed bytes and one visible message | `browser/native-relay.spec.mjs`, `relay/native.test.ts` |
| `04-interrupted-invite` | Lost invite response, offline recovery, profile completion without a second claim; journal contains no invite code | `communities/native-join.test.tsx` |
| `05-profile-and-local-save` | Lost profile response, recovered draft, local membership-save failure, reload and successful open with one profile write and one invite claim | `communities/native-join.test.tsx` |
| `06-superseded-profile` | Acknowledged write is not current; dialog retains submitted fields; reload and newer retry succeed, preserving extra profile fields | `communities/native-join.test.tsx` |
| `07-missing-profile` | Acknowledged write is missing at readback; retained draft survives reload and explicit publication succeeds | `communities/native-join.test.tsx` |
| `08-read-before-publication` | Failed pre-publication read preserves the draft and sends no profile write; reload/retry publishes once | `communities/native-join.test.tsx` |
| `09-read-after-publication` | Failed confirmation read preserves the draft; reload finds the current profile and opens without another write | `communities/native-join.test.tsx` |
| `10-alias-changes` | Add an alias during pending recovery, edit again, remove the alias, recover newest fields under the same canonical origin | `communities/join-journal.test.ts`, `communities/native-join.test.tsx` |
| `11-journal-save-failure` | Journal storage failure stops policy/claim dispatch; restored storage permits explicit retry | `communities/native-join.test.tsx` |
| `12-expired-send-readback` | Old uncertain send: offline and missing-ID readback keep uncertainty; finding the original ID confirms delivery with no new signature or publication | `relay/native.test.ts` |
| `13-interrupted-verification` | A held profile readback keeps Working disabled; reload interrupts it, preserves draft, and completes once after explicit open | `communities/native-join.test.tsx` |
| `14-legacy-alias-overlap` | Seeded legacy aliases without mappings do not block origin recovery; restoring an overlapping alias keeps newest draft; unrelated unresolved draft remains | `communities/join-journal.test.ts` |
| `15-public-identity-restoration` | Settings displays the same public key before/after reload, without create/import/export IPC | `app/services.test.ts`, `browser/native-relay.spec.mjs` |

Paths in the last column are relative to `src/features/`, except `app/` under
`src/` and `browser/` under `tests/`. The coverage list also follows the contracts
in `docs/identity.md` and `docs/communities.md`. Nonvisual signing rejection,
request limits, cancellation races, malformed journal data and transaction
replacement matrices remain in their existing lower-layer tests; these videos
do not substitute for that coverage.

## What Is Real

The app components, service composition, native **JavaScript** adapter, Nostr
event verification, localStorage journals and IndexedDB outbox run normally.
Visible inputs, button clicks, reloads and error states are recorded from the app.
The host signs with public test scalars and checks the production four-field IPC
template, destination, signature, publisher, NIP-42 challenge and subscription.
The private test scalar stays in the Node fixture, never the app page.

What is mocked: `identity_restore`, Rust `relay_sign`/`relay_http`, remote HTTP
responses, the WSS peer, policy enforcement and persistence faults. The HTTP
fixture does **not** generate or verify Rust's NIP-98 authentication. An accepted
fixture publication and a verified live event are not deployed-relay acceptance.
The video caption band makes these boundaries visible outside the app pixels.

The ten-second delivery notice grace is advanced with Playwright's controlled
clock in clips 03/12. Clip 06 advances Date by 90 seconds past the seeded newer
profile; clip 12 advances Date by sixteen minutes and changes fixture readback
availability. Clip 14 explicitly seeds legacy public journal records. Alias
configuration is supplied before app module initialization on each reload.
No product code, signing rules, storage owner or retry behavior is replaced.

Receipt acceptance and a message observed in history are distinct app states.
Clips 03/12 finish with a history reload so the pending-delivery notice clears
and the conversation visibly contains one copy of the recovered message.

## Acceptance Limits

These recordings prove observable browser-fixture workflows only. They cannot
demonstrate native-process restart, Keychain consent/denial or persistence, Rust
NIP-98 exact-byte authentication, TLS, deployed-relay interoperability, native
window behavior, release signing/notarization, or Windows/Linux custody.
Debug packages use the shared `dev.local.buzz.foundation.identity.debug` item
in the default Keychain; a separate port/worktree would not isolate it. Avoiding
that shared item would require a different native identity-storage setup. No
native build or user's installed app was launched for this recording task.

Review the gallery and sample frames, not just the assertion results. Media
verification checks all output videos with ffprobe, decodes every frame, samples
start/middle/end app pixels, then plays and seeks each MP4 in Chromium. This is
not a cross-browser product test or a manual human acceptance sign-off.

## Recorded Snapshot

On 2026-09-28, all 15 scenarios passed against application commit `d6f0748e`,
using Playwright Chromium `153.0.8010.12`. All MP4s passed full decoding,
start/middle/end nonblank checks, and Chromium play/seek checks. Representative
frames were inspected, including retained drafts, local-save errors, the held
verification state, expired delivery and public identity details. TypeScript and
focused Biome checks passed. No production files or existing CI tests changed.
Native and live-relay acceptance remain deferred as described above.
