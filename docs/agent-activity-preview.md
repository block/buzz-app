# Agent Activity preview: testing guide

**Experimental macOS test candidate, not merge-ready or release-validated.**
Branch: `feature/agent-activity-preview`.

This branch integrates main through `1f71ee94` with the Activity implementation.
Main's identity, packaged communities, harness setup, profiles and close-to-hide
behavior remain authoritative. Native Activity/history uses that same identity;
the temporary preview-only account connection has been retired. This preview is
for trying Activity, not replacing an everyday installation.

## What to try

- Multiple agents with exact identities, including namesakes.
- Human-facing messages visible; explicitly tagged coordination grouped and
  initially collapsed. Human follow-ups stay outside, and the composer remains usable.
- Opening Activity exposes progress, not the coordination transcript. Inside the
  same group, **View N coordination messages** explicitly reveals the transcript.
  Incoming messages stay unmounted until that control is opened. Exact-message
  navigation can reveal its target; collapsing the outer group resets transcript
  expansion. Human-facing answers remain outside both disclosures.
- Hover/click response Activity popups, expandable tools/messages, and the profile Activity tab.
  Profile human request text is expanded by default; agent communications are not.
- Channel thread controls show exact working agents only with fresh evidence;
  pending requests say awaiting response, never a fabricated reply.
- Tagged coordination ancestors keep their bodies collapsed even when a visible
  human-facing answer is nested below them. Exact-message navigation can reveal
  its own target, but opening the answer does not reveal its ancestors.
- Side-panel opening by dragging or the Activity context menu, without losing the thread.
- Working, unknown, error and ended-without-reply states. Coordination/ended telemetry
  does not mean a human-facing answer was delivered.
- Coordination alerts suppressed; normal human-facing alerts still follow preferences.
  Unread counts and badges are not cleared by suppression.

The bundled producer is pinned to upstream `19da8950`. `buzz messages send` now
requires `--audience agents|everyone`. Untagged historical messages remain visible
and retain legacy alerts; there is no wording-based classification or backfill.

## Safety first

**Run only one Buzz native controller at a time.** Normally quit installed Buzz and
other development copies and verify their agents have stopped before launching this
candidate. Different ports do not isolate keys or agent ownership. This branch can
restore agents previously enabled in the shared new-app data directory.

Use your own existing account and a disposable test channel. Do not copy another
person's `.env.local`, Keychain entries, agent configuration or archive. Never put
private keys in environment files. Existing agent settings are preserved by a
normal runtime handover; inspect settings before starting imported agents.

## Dev UI feedback

Requirements: Apple Silicon macOS, the repository's Hermit tools, Tauri prerequisites,
and an existing Buzz account in the OS credential store.

```sh
git fetch origin
git switch feature/agent-activity-preview
bin/pnpm install --frozen-lockfile
# Configure your own public BUZZ_DEV_VIEWER and optional relay origin
# in git-ignored .env.local as described in README, then:
bin/just desktop
```

The first build prepares five pinned runtime tools and can take several minutes.
Approve OS Keychain access yourself if prompted. The README explains the public
viewer pin and community configuration. Do not use someone else's public pin.

**Broker-backed dev Activity is live-only.** It does not test saved history. Closing
or reloading a development session can lose its current Activity evidence.

## Packaged saved-history acceptance (still pending)

```sh
bin/just desktop-bundle
```

Normally stop the dev app and its agents, then open the produced
`target/debug/bundle/macos/Buzz Foundation.app`. This is a local debug build, not a
notarized release. Follow the native identity setup/import flow and select your existing community;
approve the OS Keychain prompt yourself. Never paste a key into a fixture.

Required attended checks:
1. Run a bounded three-agent handoff in a test thread. Verify collapsed coordination,
   visible human answer, and exact reply/profile Activity.
2. Close/reopen Activity, quit normally, reopen and restore the selected community. Verify
   Saved Activity restores without reviving a working indicator.
3. Disable/re-enable Activity: capture stops, saved history remains.
4. Confirm deletion only if you intend to erase **all new-app Activity for that
   account/community**, not merely the selected agent. Verify deletion and restart.

[History policy](activity-history.md): encrypted message bodies, plaintext public
routing metadata; 30 days / 20,000 envelopes / 128 MiB logical payload globally,
with an earlier physical-space limit. Exact saved reply lookup is deliberately
bounded and can report unavailable. Deletion may withhold new saved frames for up
to five minutes to prevent replay. No old Buzz archive import, secure-erasure or
complete-transcript promise.

## Evidence and outstanding gates

Local development evidence includes actual signed three-agent audience tags, focused
React/relay tests, both-engine Activity journeys, signed staged-CLI smoke tests, and
native controller/credential/account/history tests. These are not proof of packaged
real-account persistence. The current package still needs the attended checks above.

The preview publication repairs stale test fixtures without production behavior
changes: message capability stubs, the DOM-only ResizeObserver stub, and Activity
identity-name selectors. The merged adapter retains main HTTP writes and adds a scoped native socket/history
lease. Legacy preview team snapshots remain readable without rewriting saved agents.

The main-integration batch passed 22 representative Activity, thread-navigation and
mocked-native browser journeys across Chromium and WebKit; Rust Clippy, the native
build, controller tests and focused identity/relay/Activity-history/IPC tests passed.
Independent source reviews found no remaining merge blocker in the inspected
ownership/lifecycle and conversation/profile boundaries. These are local synthetic
checks, not a whole-feature security certification. The staged-runtime ignored
native gates and packaged real-account acceptance have not been rerun for this
reconciled identity path. The profile channel selector's cycling label remains a
known accessibility follow-up outside the merge.

No hosted CI approval, code-owner approval, release signing,
or cross-platform acceptance is claimed. A branch push alone does not run PR CI.
Report the commit, launch mode (dev/package), steps, expected/actual behavior and
whether the message had a valid audience tag. Do not attach credentials or raw
private Activity transcripts to public issues.
