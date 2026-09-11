# Channels, relay data, and plugin panels

## Run the integration

Configure your public `BUZZ_DEV_VIEWER` pin in `.env.local` using the
[development setup](../README.md#relay-channels), then run `BUZZ_LIVE=1 just web`
or `BUZZ_LIVE=1 just desktop` (one at a time) to enable the development broker.
Add a community using the top-left community switcher, open Messages and click a supported GitHub URL in a message to open its object
in a side panel. Pull requests show title, state, author, branches, change counts,
and description; issues, commits, and repositories show their relevant details.
The panel reads GitHub's public API on demand. Private or unavailable objects and
API limits show an explanation with a direct GitHub link. File and branch links
continue to open normally. No GitHub account connection is configured yet.

Settings independently enables/disables Channels and GitHub. Disabling GitHub
removes its link handler and open panel; shared channel data remains available.
Disabling Channels removes its page while the app-owned data survives.

The broker uses the existing authorized Buzz identity in the macOS Keychain and
signs authenticated reads and channel messages in Node. No private key reaches browser JavaScript; there is
a bounded message-signing and publishing endpoint. The broker is restricted to loopback hosts, same-origin
POSTs, valid Nostr kinds/event IDs, and bounded filters. Without `BUZZ_LIVE=1`, the shell and Messages empty state remain available, while the live identity/join flow explains that it needs the development broker. Packaged builds do not include the development broker.
The broker supports explicitly scoped typed relay origins;
see [destination routing and trust limits](communities.md#development-broker-boundary).
This is not a new native login.

## Ownership

- `app/services.ts` constructs client/community, pages, and panels services.
  See [community ownership](communities.md) for selection and join lifetimes.
- `features/relay` owns the [session query core](relay-queries.md), shared profiles,
  and retained channel snapshots. Components use
  its React hooks without creating connections or owning persistence.
- `features/panels` owns target resolution and panel rendering. Panels receive
  `{ target, close }`; their plugins inject additional capabilities as needed.
- `features/messages` owns reusable `ChannelTimeline`, `MessageRow`, `ThreadPanel`,
  `MessageComposer`, delivery presentation, styles and reading geometry. They accept
  ordinary props over the shared session; none owns a connection or outbox.
- `bundled/channels` owns page registration, channel selection/navigation, sidebar,
  diagnostics, layout and panel placement. `shared/view-state.ts` partitions persisted
  drafts and view intent by community/viewer scope.
- `bundled/github` registers and implements the panel. Channels uses the panel
  contract and does not import the GitHub implementation.
- `plugins/contributions.ts` owns registration identity, readiness, and disposal
  for both extension points.

See [plugin architecture](plugin-architecture.md) for the authoring contracts.
To build another page, follow `bundled/channels/index.tsx`: declare injected
capabilities, register the page, and pass those capabilities to its React tree.
Keep page-specific navigation and arrangement in the plugin; compose shared message
components rather than copying them. Session reconciliation, authorization, retained
reads and durable outbox recovery remain host-owned even if Channels is disabled.

The workspace React key includes community/viewer scope **and** connection
generation. This resets session-owned component state on switching or reconnecting;
drafts, channel selection and reading geometry retain their stable scope keys.

Saved sidebar groups, ordering, assignments and stars live in the session's
`sidebarPreferences` snapshot, not in the mounted Messages page. `ensure()` shares
one initial read; `refresh()` explicitly reloads/retries while retaining the last
good snapshot through loading/errors. Page exits neither restart nor cancel that
read. Cache clearing and session disposal cancel it and discard decoded data;
late completion cannot repopulate a retired snapshot. These are account-owned
preferences, not channel access grants: sidebar sections still intersect the
authorized roster. There is no new disk cache or automatic cross-device sync.

Search, collapsed section keys and sidebar scroll remain separate, scoped view
intent. They are saved on page exit and restored before paint when the roster and
groups are available; navigation history does not own them. The saved-groups
browser regression records every visible return frame and holds the redundant
decode path, so eventual restoration cannot conceal a fallback-group/scroll jump.

## Performance and correctness carried from Astra

The port retains the prepared-store implementation and its behavior tests:

- 64 prepared heads / 4 MiB serialized memory budget, separate from history.
- Three unpinned history windows; each caps at 2,400 rows or 8 MiB. Mounted readers
  are not evicted by speculative preparation. A budget cap is distinct from EOF.
- Three read slots, at most one background request, with foreground promotion and
  deduplication. Hover/focus prepares likely next channels. Discovery restores
  authorized disk heads but does not fetch heads across the roster; network reads
  belong to intent, selection and retained-window live catch-up. Optional profile
  enrichment stays background. Selecting an already-queued catch-up promotes that
  existing read without adding a request or resetting its deadline.
- 1,024 profile entries / 2 MiB signed-record budget, narrow row profile selectors,
  and a bounded avatar preparation cache. Signature verification yields in batches.
- Account/relay-scoped IndexedDB: 64 records / 8 MiB global disk budget, 24-hour
  expiry. Cached events are reverified only after fresh roster authorization.
- A 60-second head freshness lease; warm revisits reuse heads without new reads.
  Partial discovery never treats an omitted channel as a membership revocation.
  Explicit denial or signed membership removal invalidates private cached views.
- Conventional top-down virtua timeline, prepend anchoring, near-bottom following,
  and three cached geometries keyed by session, channel, content, profiles, and width.

Connection generations and store epochs reject late results after disconnect,
replacement, disposal, or access revocation. The data service outlives plugin
components; it is disposed with the app runtime.

## DM label recovery invariant

Access-loss purges remain authoritative: never keep old profiles just to preserve
sidebar names. After roster membership changes, visible DMs must reacquire their
missing names through the shared profile directory at background priority, without
blocking conversation opening. Recovery must cover both loaded profiles being
purged and an initial profile read being cancelled before any name arrives.

`ChannelsPage` passes the **full** roster to `useChannelLabels`; the hook filters
visible conversations for display/profile demand, but derives its recovery trigger
from all channel IDs. Deleting an already-hidden or archived channel can still
invalidate shared profiles. Missing-profile and membership keys remain stable on
ordinary message/preview updates: missing/failed responses must not start a
render-driven request loop. Key fragments remain the fallback for unavailable names.

`useChannelLabels.test.tsx` binds the mounted hook to real session roster omission,
including hidden/archived deletion, stale in-flight replies and unsuccessful name
reads. `tests/browser/dm-labels.spec.mjs` guards the production page wiring and DOM
labels through the real Refresh channels control and broker. These are foundational
recovery constraints, not a new shared-session API or a guarantee of general
profile retry after every cache clear/network failure. See [browser coverage and
limits](browser-testing.md#dm-label-recovery).

## Viewing threads

Click a message's reply count to open its root and replies in the right column.
Up to three overlapping participant avatars appear beside the count, with `+N`
for additional summary participants; missing/unavailable pictures use initials.
They reuse the channel's existing shared profile/media path, not extra per-row reads.
The panel automatically traverses the reader’s bounded history range before initial
bottom positioning; there is no Load more replies button. A prior user scroll gesture
wins. New replies arrive through the existing session and the panel follows while
near the bottom, preserving reading position when scrolled up. Sending a reply is
explicit navigation intent and reveals the new local row.

**Long-thread limitation:** traversal is oldest-first, capped at ten pages of 50.
Bottom means bottom of returned history, not necessarily the newest reply in a long
thread. A limit notice is not a completeness claim. True newest-page opening needs
a relay query extension; automatic traversal alone does not solve that requirement.
The thread and a linked object panel share that slot; a companion can remain below.
Close or Escape returns focus to the reply button when it is still mounted. Changing
channel/community or disabling Channels disposes the owned thread view.

The footer reuses `MessageComposer` and sends direct replies to the resolved root
through `session.messages.reply`. Channel and thread drafts are separate and survive
reconnection; failed replies remain inline with the shared retry action. Read-only
connections keep the existing composer capability notice; missing/revoked roots do
not expose a composer. There is no jump-to-specific-reply navigation yet.

Replies use ascending timestamp/event-ID order, including nested replies. Retry
appears only after a failed read; there is no routine Refresh control. Names are
optional shared background enrichment. The panel describes **replies shown**, not
complete history.
The relay can filter rows after its limit, and summaries/EOSE are not proof of
exhaustion. See [the thread owner and bounds](relay-queries.md#thread-views).

## Validation and limits

`just scan` runs frontend checks/build, runtime/CLI tests, relay behavior tests,
panel lifecycle tests, GitHub parsing/API tests, headless Chromium/WebKit scroll
journeys, and native checks. See [browser setup, structural limits and diagnostic
measurements](browser-testing.md). Reading intent includes a message anchor for
cold/oversized geometry; legacy positions or anchors outside retained history fall
back to an offset without a same-message guarantee.

Channels supports basic text sending with a shared durable outbox and bounded history.
Authenticated live traffic reconciles through that same session. Channel creation
is not implemented; basic text thread composition is supported. Reply counts open a bounded thread
view; attachments are links. Routine freshness labels are not shown; Conversation options → Diagnostics
exposes refresh, outbox inspection and timings. Packaged builds do not
include the development relay broker. GitHub fetches public data only; signed-in
GitHub actions remain on GitHub. A saved-groups/stars failure keeps its specific
reason under **Conversation options → Diagnostics → Saved groups and stars**.
`Preference query` includes reader queueing, transport and verification; use relay
timings to separate those. `Preference decode` identifies the local decoder stage.
The diagnostic does not trigger another request or change retry policy.

Sending appears immediately in the timeline and shared channel-preview data;
the current sidebar does not render preview text. Delivery
status and retries come from the [unified relay session](relay-queries.md), and a
stale read cannot erase the retained local operation.

Use `session.messages.send(channelId, text)` for channel messages or
`session.messages.reply(channelId, resolvedRootId, text)` for thread replies. Confirmed sends
leave the pending outbox automatically and remain in bounded retained data.
**Outbox → Relay timings** captures and exports stage timings, including in-flight
signing and publishing, without logging message content.


## Reusing conversation UI

Source plugins can import from `features/messages` without depending on bundled
Channels. Pass the current `RelaySession`, stable community/viewer `scope`, channel
identity and navigation callbacks. `ChannelTimeline` also receives the current
`ChannelWindow`; `ThreadPanel` owns allocation/disposal of its thread reader.

`ChannelTimeline`, `ThreadPanel` and `MessageComposer` reset their internal state on
session, scope or destination changes. Callers may retarget ordinary props without
supplying React keys; old thread evidence, scroll state or drafts cannot pair with
a new destination. Persistent draft keys remain `draft:<channelId>` and
`draft:<channelId>:thread:<resolvedRootId>` inside stable scope, not connection generation.
`MessageRow` receives folded data, profiles/media and optional reply/retry callbacks.

This is shared source composition, not a new registry or versioned external UI SDK.
See `tests/fixtures/messages.tsx` for a second consumer that deliberately supplies no
caller remount keys. Its browser regression runs real React StrictMode/session/outbox
with local ephemeral signing keys; it does not contact the deployed relay.

## Community emoji

The smile button in channel and thread composers opens Emoji Mart with standard
Unicode emoji, skin tones, and the selected community's custom category. Its data
and search load only when opened. Search by name/shortcode, then choose an emoji
to insert at the cursor; Enter selects a search result and Escape closes the picker
and returns focus. You can also type `:shortcode:`. The picker follows the host
Light/Dark choice, including while already open, without recreating its search or
dictionary. It does not independently follow the operating system.

The session owns the catalog and its live updates. Reopening reuses the ready
catalog, without hiding custom results behind a fresh read. Catalog failures expose
Retry while leaving Unicode available and retaining drafts. Only one picker owns
Emoji Mart's global dictionary at a time; scoped custom IDs and disposal prevent
old community entries leaking into search or Frequent. Historical messages and
existing reactions keep their signed emoji URLs after catalog changes.
Emoji uploads and management remain in the existing community workflow.

See [the shared catalog/send contract](relay-queries.md#community-emoji). The local
`/tests/fixtures/emoji.html` diagnostic uses ephemeral identities and no live relay.


## Unread badges and reading intent

The sidebar renders the session-owned [unread capability](unread.md): observed
counts, not exact relay totals. Selecting/preloading a channel is not reading.
Focused, fully visible, settled timeline/thread rows receive an individual marker
after dwell; no automatic channel-prefix advance hides unseen siblings. Conversation
options exposes local-only manual unread, explicit mark-through and sync recovery.
Older synchronized hints may expire under bounded retention. Synced manual-unread
and OS notifications are not enabled by this feature.
