# Unread and read-state ownership

`RelaySession.unread` is the shared capability. Plugins render its immutable
selectors and submit reading intent; they do not maintain counters, sign
requests, or write persistence. The relay's `/buzz/v1` sidebar API is the one
read-state authority: `sidebar-api.ts` is the wire client, `sidebar-state.ts`
owns the session projection and write flushing, `sidebar-journal.ts` owns the
durable local journal, and `unread.ts` adapts them into selectors and intents.
Disabling Channels does not erase saved intent. `src/plugins/author.ts` exports
the types through the existing host-matched author preview, not a cross-version
SDK or plugin sandbox.

## Consumer contract

```ts
const target = { kind: "channel", channelId } as const;
const snapshot = session.unread.snapshot(target);
const unsubscribe = session.unread.subscribe(target, render);
await session.unread.ensure(); // shared bounded observation, not per-row fetch

// A custom reading UI owns one cancellable observation lease.
const reading = session.unread.reading(channelId);
await reading.observe(visibleVerifiedMessageIds);
reading.dispose(); // on hide, retarget, focus loss, or unmount
unsubscribe();
```

Targets are `{kind:"channel",channelId}`, `{kind:"thread",channelId,rootId}`,
or `{kind:"message",channelId,messageId}`. The consumer must establish actual
reading intent before calling `observe`: this is a trusted in-process API, not
proof that a human read text. The engine resolves signed message identity,
timestamps, ancestry, deletion and current access; arbitrary timestamps are not
accepted. Cancelled leases cannot survive disposal, revocation/regrant, or a newer
manual-unread action. Restored channel heads pass signature/access verification
and supply evidence before their rows become observable.

Reusable `ChannelTimeline` and `ThreadPanel` own the standard observation policy:
focused active reading surface, visible document, settled positioning, fully
visible rows, and 750 ms dwell. Scroll/content/focus changes cancel/restart dwell.
Mounted virtualizer overscan, preload, selection, and composer focus are not
reading. After dwell, each context (channel timeline or thread) sends one
`mark_through` anchored on its **newest dwelled message**: the relay stores
a frontier for dwell rather than individual receipts, so earlier messages in that context read
too. Oversized rows that never fit fully are not auto-read.

- `unread` and `attention` are relay `ReadCount`s: `exact`, `at_least` (a lower
  bound, e.g. when participation could not be proven within the relay's budget)
  or `unknown`. Unknown is never rendered as zero. Counts come only from relay
  responses; live traffic invalidates a row and triggers a debounced (250 ms)
  targeted refetch, never a local increment.
- The roster is read in pages of 20 (`/buzz/v1/me/sidebar`), sequentially;
  targeted refetches take at most 20 channel IDs and context reads at most 20
  targets / 100 message IDs. A visible, requested session refreshes every 60 s and
  on window focus/visibility. Each thread summary lists at most 5 threads.
- `attention` is the directed subset: DMs, mentions, broadcasts and replies in
  threads the viewer participates in. It does not trigger notifications or
  implement mute policy.
- `markThrough(target, messageId)` is explicit prefix intent through a loaded,
  verified message in that target's context. It can mark unloaded earlier
  messages read; viewport observation goes through `reading()` instead, so dwell
  and lease rules apply. A channel prefix requires a top-level message, not a reply.
- `markChannelRead(channelId)` anchors on the relay row's `latest_message_id`
  when invoked and sends `mark_channel_read`: a fixed whole-channel cut covering
  the timeline and every thread through that timestamp. Later arrivals remain
  unread. It clears the channel's local manual-unread marks. With no latest
  message and a complete row it clears only local marks; an incomplete row is an
  error rather than an invented cut. It does not fetch history or select the row.
- `markAllChannelsRead()` sweeps accessible listed channels with visible unread
  evidence or a local mark. It captures every selected fixed cut and local clear
  at invocation, before yielding; the journal then commits them one channel at
  a time. Already-read channels cost no
  writes. Losing access to any channel in the community while the sweep saves
  cancels every channel not yet saved, not only the revoked one: the sweep
  rejects with `Reading context changed`, those channels keep their unread
  state and marks, and repeating the sweep clears them. Only when the revoked
  channel is the last one unsaved is it simply skipped. Other failures do not
  stop the sweep, and the first failure is rethrown afterwards. Newly granted
  channels wait for the next action and cancel nothing. The community rail uses
  this for the selected community only.
- `markUnreadLocal(target)` is durable **on this browser profile/device only**.
  Automatic reading does not clear it. An explicit mark-through clears that
  target's local mark. `syncedManualUnread` is `false`.
- The row menu's **Mark read through here** uses `markThrough` in the selected
  message's context. It advances a prefix, not an exact-message receipt or a
  loaded-subtree snapshot. **Mark unread** stores only that selected message's
  device-local mark; it does not force descendants or the channel.
- `refresh()` re-reads the sidebar; `retrySync()` flushes pending writes, then
  refreshes. `ReadMutationResult.durability === "saved"` means the local journal
  transaction committed, not that the relay accepted it. Relay-derived unread
  styling clears only after acknowledgement and the debounced targeted refresh;
  offline reading saves intent but does not optimistically clear the badge.

The sidebar separates ordinary unread from directed attention. Any unread state,
including activity that exists only in a relevant thread, strengthens the channel
label. Ordinary unread renders no row marker. DMs, mentions, broadcasts, and
relevant thread replies add one accent dot; non-DM row numerals are omitted and DM
avatars are reserved for promoted offscreen cues. Thread activity reuses that dot:
its hover/focus/click popover lists the relay's bounded set of newest unread
threads, dropping only those with exact-zero attention (unknown attention stays, as
possible attention), and opens the existing thread panel, so overlapping priority
and thread activity never produce duplicate dots. Each preview is the thread's
newest unread reply, not its newest attention reply, with agent envelopes unwrapped
and the author's edits applied as the relay returns them when the popover opens.
That read is neither live nor unbounded, so a preview can differ from the timeline:
an edit made or deleted while the popover is open shows on the next open, and the
read takes the newest 500 edits across the listed replies, so a reply can show an
older edit or its original text. The relay caps the list before
the client filters it, so an older attention thread can be omitted; an incomplete
list stays marked incomplete. Merely revealing the popover does not acknowledge a
reply.
A local manual-unread mark strengthens the label without fabricating priority; the
underlying relay count remains available.
The sidebar row menu offers **Mark as Unread** on read channels and **Mark as Read**
on unread channels. The message menu offers **Mark unread** and **Mark read through here**
for individual message contexts. Diagnostics has no read-state controls. Unknown and
zero both omit unread styling; the API preserves the distinction. There is no
notification or feed service here.

When unread rows are outside the sidebar's scroll viewport, floating “Unread”
buttons reveal the nearest destination in that direction without exposing a count.
The internal directional set is still deduplicated by destination for geometry and
priority: ordinary destinations use a quiet treatment; any DM, mention, broadcast,
or relevant thread destination promotes the same composition to primary. Thread-only
rows participate, and DMs remain promoted even when their only evidence is thread
activity. The controls measure existing rendered badges/dots—no extra unread
subscriptions or relay reads just to show them. Search-filtered rows do not
participate. Collapsed sections use the summary's position and expand when revealed.
A partly visible row is not outside the fold. Activation scrolls and focuses the
row, retaining its ordinary focus preparation; it does not select the channel or
acknowledge any messages. The count is destinations, not a potentially misleading
aggregate message total. Directional destination counts remain internal and are
not rendered or announced by the control.

Thread buttons keep the summary's total reply count and add a dot when the shared
thread selector has unread replies or explicit thread-unread intent. Accessible
names distinguish counts (with "At least" for lower bounds), stale data and
local-only intent; unknown and zero omit the dot.
Each mounted button subscribes to its own thread, without fetching thread history.
Opening/hovering a button does not acknowledge replies; the existing focused
viewport dwell in `ThreadPanel` supplies `mark_through` intent for the newest
dwelled message in its context.
The relay resolves thread ancestry for counts; the client resolves a dwelled
message's context with the same canonical marked-reference parser as thread
opening. References alone do not grant access or trigger a read.

## Explicit clearing matrix

| Intent | Relay write | Local manual-unread clears |
| --- | --- | --- |
| Automatic visible dwell | `mark_through` newest dwelled message, per context | None |
| `markThrough(target, messageId)` | `mark_through` that target through the message | That target |
| `markChannelRead(channelId)` | `mark_channel_read` through the row's latest message | Channel |
| Channel read with no messages | None | Channel |
| Selected row read through here | `mark_through` in the row's context | Selected message mark |
| Selected row unread | None | None (adds selected message mark) |
| Mute/Unmute | None | None |

Every write anchors on a message ID; the relay derives the timestamp and rejects
anchors outside the viewer's membership (`blocked`) or of an ineligible kind or
wrong context (`invalid`). The action has already resolved once its intent was
saved, so either outcome is recorded as the channel's `error` on the unread and
thread-activity snapshots, which the bundled UI does not render; the channel is
re-read, and its unread count returning is the feedback. Disposal, cache
clear, or an access revoke/regrant of any channel in the community, invalidates
all queued intent in that community, not only the affected channel's; a waiting
explicit action rejects with `Reading context changed` and can be repeated.
Automatic dwell leases are invalidated by a newer manual-unread action on the
channel.

## Durable sync

The journal lives in IndexedDB `buzz-sidebar-v1`, store `partitions`, one
`{pending, manual}` record per relay/community scope and viewer, separate from
disposable message caches. Leaving a community clears that scope's pending and
manual sets after disposing its session, retaining only an empty partition record;
other community/viewer partitions are untouched. Strict read/write transactions merge concurrent windows.
Intent is saved before sending; each flush sends captured batches of at most 100
intents and removes exactly the acknowledged operations. Writes are idempotent
frontier advances, so no publisher lock is needed: any window's flush (on
enqueue, focus/visibility or the periodic refresh) delivers every pending intent,
including one saved by a window that closed before sending. An `unknown` outcome
keeps the intent for retry. The journal holds at most 1,000 pending and 1,000
manual entries within 512 KiB. Exceeding that rejects the action: explicit read
and unread actions show the error, while automatic reading stops saving without
a notice.

Manual unread is **local to this browser profile**; `syncedManualUnread` is
`false`. The relay's advertised retention window (`retention_seconds` in NIP-11
`buzz_v1`) bounds the messages it counts as unread evidence; saved frontiers are
stored progress and are not bounded by that window.

Capability comes from the relay's NIP-11 `buzz_v1` descriptor. Only the exact
supported version and bounds enable `frontier-sync`; otherwise the capability is
`unsupported` and local manual intent still works. The Node development broker
owns the key, NIP-98 signing and same-origin checks for `/api/relay/sidebar-api`;
plugins receive no signing capability. Packaged builds do not include this
development broker.

## Bounds and failure semantics

Collapsed reply branches show total replies, not aggregated unread counts.
Message subscriptions retain their resolved context selectors until disposal.
The session admits at most 1,000 context leases and 1,000 distinct message selectors
across their contexts; a request exceeding either bound throws rather than
partially admitting selectors. Disposing a lease releases its demand. Context
reads batch at most 20 targets and 100 message IDs per request; these wire bounds
are separate from the retained-demand limits.

The journal coalesces dominated pending prefixes before sending. If a newer anchor
covers an older pending prefix but the relay subsequently blocks the newer anchor
(for example, unresolved ancestry), the older intent is no longer available as a
fallback. The blocked outcome is recorded but not shown, as above; progress
needs a refresh and a new action with a valid anchor, and the client does not
manufacture progress from it.

Deployment requires the compatible `/buzz/v1` extension, including five-thread
summaries and fixed-anchor whole-channel reads. An older or absent descriptor
leaves relay counts unknown; there is no legacy counting fallback. Deploy the
compatible relay before enabling this client contract. The write body cap is
256 KiB, route-local; context GETs retain their existing selector bounds.

## Verification

- `sidebar-api.test.ts`, `sidebar-state.test.ts`, `sidebar-journal.test.ts`,
  `sidebar-storage.test.ts`: wire validation, projection, flush/acknowledge, and
  journal storage ownership.
- `dev/sidebar-api-broker.test.mjs`: real local HTTP broker, NIP-11 discovery,
  NIP-98 signing and operation validation.
- `unread.test.ts`, `unread-message-actions.test.ts`, `unread-startup.test.ts`, `unread-invalidation.test.ts`: real
  session lifecycle, access, reading leases, startup and live invalidation.
- `use-reading.test.ts`, timeline/thread tests: dwell/geometry and owner wiring.
- `dev/sidebar-api-live.test.mjs` (opt-in): production broker, transport and
  sidebar state against a real relay, two sessions, lost acknowledgements.
- `MessageRow.test.tsx`, `tests/browser/thread-unread.spec.mjs`: thread selector
  presentation, unchanged summary counts, hover/keyboard-focus treatment,
  independent thread reading and reload through the production broker.
- `tests/browser/sidebar-unread.spec.mjs`: above/below destinations and priority,
  activity-only rows, resize/search/collapse, keyboard continuation, manual intent,
  paged roster reads, session retargeting, and no reading/selection from reveal.
- `tests/browser/unread.spec.mjs`: production build/React/session/IndexedDB/broker,
  sidebar → focused dwell → relay write, reload, cancellation, closed-window
  delivery and explicit local-unread clearing with network content held.
  The browser relay is a model (`tests/browser/policy-relay.mjs`); the relay's own
  suites and the live driver prove the contract, not these journeys.
