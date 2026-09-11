# Pulse experiment

A bundled **source page plugin**, independently toggleable in Settings → Plugins.
This is not a self-contained external API-v1 install artifact. Run this branch of
buzz-app and choose **Pulse** in the top navigation. Messages is unchanged.

## Design reference

Inspired by [`block/buzz`'s `am-pulse-proto`](https://github.com/block/buzz/tree/2d620055e574f41f466ae13b88cfb0aa77ede068/desktop/src/features/pulse),
inspected against merge base `cec5c8fd9280d30f56effac701e1e19d5cfe6fea` with main.
The relevant additions are `UnifiedPulseView`, `PulseConversationSplitView`,
`PulseBriefing`, and the feature README—not the branch's unrelated mobile,
identity, agent-recovery, or broader shell changes.

Carried over:
- A centered 960px rounded canvas, quiet separators, compact 220px conversation
  navigation, and Search / For you / All messages destinations.
- Author-led activity with source-conversation links and in-place thread drill-in.
- Conversation selection independent of feed order; shared, separately scoped
  channel/thread drafts; responsive navigation and light/dark semantic tokens.

Adapted to buzz-app:
- The host keeps its own navigation, canvas, appearance and companion launcher.
- A page owns its React tree and CSS module; no host or `FOUNDATION` file changes.
- `relay` supplies one existing session. The page creates one bounded observed
  activity view after the roster is available, disposed on unmount/roster change.
  No new socket, cache, signer, outbox, polling loop, or model-provider connection.
- Reuses `ChannelTimeline`, `MessageRow`, `MessageComposer`, `ThreadPanel` and
  `PanelFrame`. Emoji/Mentions remain optional conversation contributions.
  Shared message styling is retained rather than copied or overridden with
  prototype bubble styles. Links keep ordinary external navigation in this pass;
  only the host companion dock is embedded, not a second local object dock.
- Session-owned state remounts by scope **and** generation. Navigation and drafts
  persist under stable scope, not generation. The full roster's membership key
  participates in missing DM-profile recovery; names never gate conversation reads.

## Honest boundaries

**For you is not an AI briefing.** It filters recent original top-level posts to
DMs and exact `p`-tag mentions of the viewer. It does not infer requests from prose,
agent runtime status or unread state. No provider receives messages. buzz-app does
not currently expose a shared summarization or read-marker capability.

The feed requests 200 recent events across the visible joined roster and shows at
most 30 conversations, one newest matching root each. Host retained-view limits
still apply. Busy channels may dominate the window; search covers retained activity,
not full history. The channel rail remains roster-ordered, not a fabricated activity
ranking. A partial roster is labeled. Hidden non-DM and archived channels are omitted.

Author edits/deletes use the shared fold. Delivery uncertainty remains visible.
Feed rows deliberately do not interpret relay thread summaries: the session does
not expose the signing identity needed to validate those summaries in this page.
Opening a thread uses the authoritative shared reader and its existing bounded,
oldest-first history behavior. Selected channel state survives reload; thread
selection and feed search do not become new URL routes.

## Trying it

From this worktree:

```sh
bin/just web
```

For actual community data, use the repository's existing opt-in live setup in
[README](../../../../README.md#relay-channels), then `BUZZ_LIVE=1 bin/just web`.
No identity configuration is added by this plugin. Packaged login and native
acceptance remain the host's existing limitations.

## Checks

- `feed.test.ts`: visible sources, deterministic grouping, author edits/deletes,
  failed-edit rollback, exact mentions, bounded search and DM names.
- App composition test: contribution registration, disable and shared-session lifetime.
- Native catalog test: independent enable/disable flag and reserved bundled identity.
- `tests/browser/pulse*.spec.mjs`: Chromium/WebKit search, conversation opening,
  separate retained drafts, thread reader, live source edits, access revocation,
  plugin unload/re-enable, companion placement, theme and narrow viewport.

Browser fixtures use synthetic signed data; they do not publish to a real relay.
The lifecycle fixture exercises reply draft composition, not successful publication.
A full `just scan`, attended live use, final design approval and packaged native
acceptance are required before calling this ready for integration.
