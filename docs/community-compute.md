# Compute plugin

Bundled UI, verified status, and development-native sharing implementation for porting [block/buzz#7691](https://github.com/block/buzz/pull/7691)
to this app. The bundled `buzz.community-compute` plugin contributes a Settings
section and an active-provider widget launcher, and participates in the normal
browser and desktop enable/disable catalog.

For another developer to build and test this branch with their own accounts, use
the [Compute tester setup guide](compute-testing.md).

## Implemented

- Ported snapshot types, map projection, contiguous hex layout and original
  map regression coverage from PR head `372e5407f937c13801cc80ce6d16e33c97000d02`.
  Source array access was adapted to this repository's stricter TypeScript settings.
- Sharing controls with recommended/custom model input, memory limit, startup
  and download progress, failure/retry presentation and a successful sharing state.
- Serve/client distinction: consuming a remote model does not select that model
  for a local download or permit the share switch to stop the consuming runtime.
- A startup completion is retired once authoritative running/failed status arrives;
  a later Stop remains locked until its actual completion, even if status is off.
- Community map at six contributing members, host theme/typography, and keyboard
  territory disclosure. Missing capacity remains unknown rather than showing zero.
- A separate sample-data preview that never starts native compute or accesses an account.

The normal **desktop** page now reads live community status through its connected
relay session. `src/features/community-compute/status.ts` owns demand-driven reads,
complete author-batched pagination, cancellation, retry and expiry. It rechecks the
roster after pagination. The Tauri command projects signed evidence through
`crates/community-compute`; the plugin receives only display fields. Browsers
without that native validator explicitly report that desktop is required.

The native projection verifies event signatures and the host-provided explicit
NIP-11 `self` authority, current membership, owner and endpoint bindings, freshness,
and the old transport policy. It ignores future notes; newer owner reports replace
older ones deterministically. A serving label without usable targets cannot inflate
the headline. Raw GPU totals, endpoint tokens, signatures and operational payloads
are not returned to the page. This display command does **not** authorize admission
or accept instructions to run a node.

Sharing is implemented in the development desktop app using its existing authorized
relay broker. Packaged sign-in, agent creation, and a separately distributed external
artifact remain separate work. Status reads never create keys, download a model, or
start sharing. No sample values replace live status.

## Try the UI

From the feature worktree, activate Hermit and run:

```sh
BUZZ_DEV_VIEWER='' bin/pnpm exec vite --host 127.0.0.1 --port 1442 --strictPort
```

Open `/tests/fixtures/community-compute.html`. The explicit empty viewer override
keeps the development broker off even when bootstrap copied a public viewer pin.
Choose a sample community, turn on sharing, and use **Finish sample download** to
advance to the sharing state. **Show startup failure** and **Show consuming state**
exercise other presentation states. **Switch to dark/light** changes the preview
theme. All values and transitions on this fixture are simulated and labeled.

In a rebuilt desktop development app with its existing authorized relay broker,
select a community and open Compute to read live status. The page polls
every 15 seconds while observed; leaving it or disabling the plugin cancels reads.
Switching communities binds the view to that community and session generation.
Any read failure removes the headline instead of retaining a stale success; device
reports also expire independently of an in-flight refresh. Settings → Plugins can
disable/re-enable the page. The browser fixture above remains sample data.

## Native sharing ownership

The approved first integration uses `dev/relay-broker.mjs`; sharing is unavailable
in packaged builds until a native account/signing service exists. Rebuild the desktop
app and restart its matching development broker to use the new commands and narrow
compute-status endpoint. The sample browser fixture cannot exercise native sharing.

`src-tauri/src/compute_host.rs` owns one dedicated child of the desktop executable.
The worker in `crates/community-compute/src/worker.rs` loads the hardware-aware model
catalog, downloads the selected model and signed native runtime through the pinned
SDK, starts serving, and publishes verified status. A saved opt-in restores sharing
on the next development app launch. User Stop and plugin disable clear that opt-in;
app exit stops the process but retains it. Leaving the page only stops observation.
Stop remains reachable when the selected community disconnects. Cancel startup uses
the same cleanup path, with a bounded graceful shutdown followed by killing and
reaping only the owned worker. Occupied runtime ports fail clearly without stopping
another app's runtime.

The native parent supplies an app-specific persistent owner-key path. The renderer
cannot choose it, and the Buzz account signing key stays in the broker. This avoids
old Buzz idle notes replacing this app's owner status. The broker accepts only the
narrow compute-status schema, verifies owner/member/endpoint proofs, checks the
publication receipt, and serializes signing timestamps so a stopped note supersedes
an immediately preceding serving note. The generic event signer is unchanged.

Admission is independently derived from signed, current authority rosters and owner
proofs fetched through the authorized loopback broker. The worker rechecks evidence
during startup and serving; membership/owner roster changes or verification failures
stop sharing and require a manual retry. Peer discovery additionally requires fresh,
verified endpoint bindings and the existing transport policy. Renderer snapshots do
not authorize peers. No account key or endpoint token is exposed to the plugin UI.

`CommunityComputeView` still takes ordinary presentation props and controls, not a
promised public SDK. Agent creation remains separate: the host currently reads the
existing Buzz agent library, and the old flow needs real creation and runner
capabilities before the disabled action can be enabled. See [Agents](agents.md).

## Activity widgets

The page and plugin catalog are named **Compute**; the stable plugin ID remains
`buzz.community-compute` so existing enable/disable preferences keep working.
**Open activity widget** opens one reusable, draggable, always-on-top native window.
Left/Right cycles LED, Flying Bee, Orbit, or Signal. Number keys preview visual
states; Escape returns to live activity. There is no dropdown or preview caption.
Closing the widget does not stop sharing;
disabling Compute closes the widget and stops the worker.

The widget reads the native host's worker generation and sampled usage, never the
old app's console port. All designs show runtime-session totals, not lifetime
contribution or payments. Missing counters stay unknown; stale samples expire in
five seconds, runtime replacement resets totals, and delayed reads cannot overwrite
newer polling results. A single sampler owns counters independently of admission
heartbeats so slow broker publication cannot rewind activity.

Source: old `block/buzz` branch `mesh-buddy-window`, head
`49510696044dec38fa770058d93325d92694a788`, plus the four-design native integration
study in `design-explorations/mesh-buddy/native-integration/mesh-buddy.html`
in the old Buzz working tree.
`public/compute-widget.js` preserves those dot-matrix designs with a new scoped
host-status adapter, native controls and no simulated token totals.

## Verification

Focused map tests cover stable placement, connected/nonoverlapping territories,
scale buckets, device/model identities and dense samples. Mounted UI tests use real
React/StrictMode and shared controls for input validation, serve/client distinction,
progress, errors and late completion. App composition tests cover actual plugin
activation/removal; Rust management tests cover native catalog toggles and reserved IDs.

The new read path has focused tests for complete same-second pagination, author
batching, missing/empty/changed membership, invalid pages, read errors and retry,
missing explicit authority, unsubscribe/disposal fencing, and expiry during a hung
refresh. Mounted page tests cover community replacement and correct retry ownership.
Native tests use generated in-memory signing keys to check roster and event forgery,
owner/endpoint tampering, nonmembers, stale/future notes, stopped-note replacement,
distinct-device/member counts and unknown allocation, plus the ported endpoint-policy
tests (including signed-token verification).

The current focused suite passes 55 frontend/broker tests, 29 native protocol,
catalog, identity and worker tests, and five owned-process lifecycle tests. A separate 51-test broker regression run
also passes (including the four compute publication tests above). Fixtures
exercise real local HTTP broker publication and signing, process cancellation,
forced cleanup, persistence/restore, stale generations, crash reporting and a
reachable Stop while disconnected. Independent review covered the native lifecycle,
broker signing boundary and app-specific owner identity.

A native debug binary build and an invalid-input worker-entry smoke test pass without
creating an identity or starting a runtime. Subsequent manual macOS testing verified
two distinct accounts, real shared-model completions, and an agent reply hosted by
the new consumer while the old agent desktop was closed. The activity widget
reflected real requests and token totals. These are development checks, not release
or cross-platform acceptance. The macOS debug
linker reports a large unwind-table warning; the binary builds and the entry smoke
check succeeds.

## Source attribution

The original map algorithms, fixtures and map tests come from the contributors to
[PR #7691](https://github.com/block/buzz/pull/7691) / #7014 in `block/buzz` (Apache-2.0).
The new view and adapted SVG presentation replace imports from the old settings,
agent-dialog and Tauri API modules with this host's UI components and explicit props.

Native discovery, binding, owner identity, hardware-aware catalogue, model status
extraction and transport validation were adapted from the local old Buzz checkout. Signed bootstrap validation deliberately uses the same pinned SDK
(`v0.76.0-rc9`, resolved in Cargo.lock) instead of duplicating its signature format.
That SDK brings a substantial native dependency tree even with default features off.

## Two-app local test

`scripts/build-compute-pair.mjs [output-directory]` builds macOS Provider and
Consumer development app bundles from the activated Hermit environment. Each has
a distinct compiled identifier/dev URL, launcher-owned broker, plugin home, owner
key and runtime ports. The launcher uses the existing authorized account rather
than copying keys. The bundles remain dependent on this checkout and are not
signed distributable releases.

The client worker uses SDK client mode with the same verified admission and endpoint
rules. It skips local model/runtime downloads and publishes ownership-only notes,
never another node's models as its own capacity. Both Provider and Consumer render
the same Compute settings page. When the selected community is ready, the page
connects automatically; **Share this machine** remains an independent opt-in and
switches from client to serving mode. The page can send a bounded text request
through its owned loopback API while in client mode. A test lease prevents port
reuse until the request is cancelled/settled, while Stop remains available. Session
changes cancel pending model lookup or generation and discard late results. The
model comes from the mesh API's first advertised model; a shared community with
other providers can route to those providers too.

For first pairing, open Settings → Compute in each app so both register against the
selected community before enabling Provider sharing. Initial registration can
change the verified owner roster; the affected app reconnects automatically while
the Compute page is open. The local pair can use separate accounts through
`account-env.sh`; see the tester guide. Accounts and community membership must
already be provisioned.
