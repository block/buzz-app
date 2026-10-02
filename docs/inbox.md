# Inbox: relay-authoritative exported surface

Inbox remains a bundled placeholder. This merge exports the session capability;
it does not port the dependent Inbox UI (#499), selection policy, or an action
executor. Ordinary channel/thread reading retains its existing policy.

## One authority, bounded candidates

`session.unread.inbox()` is a stable snapshot projection. The relay context
answer alone admits a verified candidate: it must currently be `unread` with
reason `direct`, `mention`, or `conversation`. Broadcast-only and null-reason
messages are excluded. Read/not-counted candidates disappear; there is no
retained read-conversation archive, historical reason cache, client participation
query, or relevance reconstruction. Signed ancestry supplies grouping, not
eligibility. A reply with an absent root can still target that signed thread.

Candidates come from the existing verified session cache (4,096 events / 8 MiB),
including finite addressed feed results. Inbox adds no second event map and no
all-channel history repair. Other session traffic can evict candidates. Cold
coverage is smaller than main's former dedicated unread retention. Eligible
kinds follow the relay-advertised set (v1 currently 9, 40002, 45001, 45003, not
40008). The relay's 30-day retention window governs verdicts; the client does not
reconstruct its cutoff.

Before folding, channels with exact-zero relay attention and no unread live hint
contribute no candidates when their row request started after their last cache
admission/invalidation. Queued, in-flight, failed or newer mid-request invalidations
remain unproven. Refreshing, stale or error status alone does not revoke a row's
proof or its leases; owner status still determines snapshot freshness.
`subscribeInbox()` retains at most 100 candidate selectors while subscribed.
An older mention can leave the Inbox once 100 newer foreign messages are cached
in channels with attention.
Notification/message subscriptions have priority under the existing shared
1,000-selector/context-lease bounds, displacing Inbox leases only when admission
would otherwise exceed capacity. Disposal releases Inbox demand. Reading
`inbox()` never starts a request. Existing sidebar refresh, invalidation and
lifecycle scheduling supply context answers; there is no new timer.

Missing, unknown and over-capacity answers omit those rows and keep the snapshot
unresolved (`freshness: stale` once otherwise observed), without an error.
Unavailable message/context answers and unaskable ancestry (cycles, excessive
depth or cross-channel parents) are skipped, not pending answers.
Only error status carries an error. Unknown never becomes read or an exact zero.
Context request failure follows the context owner's `status: error`, `freshness: stale`; earlier
confirmed rows may remain stale, while a first failure has no rows. Unsupported
or not-yet-requested state is idle/unknown. Ready/observed means the currently
bounded candidates have resolved verdicts, not a complete historical Inbox.

## Rows and reads

Rows group admitted DM messages by channel and other messages by signed thread
root or standalone message. `messageIds` and `unreadCount` describe only the
admitted, observed subset, not the relay's total conversation count.
`messageId`/preview identify its oldest unread member; `latestMessageId` and
`createdAt` describe its newest. The shared author edit/deletion fold supplies
bodies. Own and deleted content is omitted.

Manual journal marks overlay admitted rows only. A mark without a relay reason
cannot materialize a row and is not erased when its row is omitted. Read intents
use the existing saving/pending/applied coverage overlay and durable journal;
saving is not proof that the relay applied the operation.

`readThrough` contains only a thread-prefix step anchored on the newest admitted
reply. A thread prefix never acknowledges its top-level root. A standalone
top-level mention has an empty `readThrough`: **empty on a non-DM means no Inbox
read action**. Never substitute a channel prefix or an exact-message receipt.
DM rows also have no steps; their separate explicit channel action can use
`prepareChannelRead`. This merge ships no executor for either action.

`prepareChannelRead(channelId)` captures the sidebar's latest-message ID/time,
current epoch and the manual-mark keys then present, once. Every invocation
reuses those operands. A mark on a key absent at preparation survives retries;
a re-mark on a frozen key is cleared by a subsequent invocation. There are no
journal mark versions. A complete empty channel permits only a local clear;
an unknown latest anchor rejects. Cache clear, disposal and access revocation
invalidate captured actions. No click-clock cut is invented.
`markChannelRead(id)` invokes that prepared action immediately.

`revision()` is the local journal's successful-intent save counter, not the
sidebar publication counter; reads, acknowledgements and sync refreshes do not
advance it. `generation()` exposes the current unread lifecycle epoch.

## Finite feed and preview completeness

`session.inboxFeed` owns finite verified addressed history demand and exact
incomplete-target metadata, not rows or unread authority. Its lazy query returns
up to 50 kind-9/40002 addressed messages. General `#e` queries page signed
40003 edits and 5/9005 deletions, then deletions of retained/returned author
edits. Both stages must finish before the feed is ready; each is bounded by
2,000 events / 4 MiB. Short authorized pages are not terminal; an empty page is.

Exact target IDs become incomplete **before** verified messages are published
to Inbox subscribers. Consumers must not show incomplete bodies as current.
Failures retain obligations and offer retry, including failed targets outside
the newest addressed page. This is not atomic content admission. Disconnect
and unrelated revocation preserve obligations for retained readable targets;
cache/session retirement clears them. Withheld auxiliary evidence fails the
attempt rather than masquerading as exhausted history. No reference-resolution
loop or participation repair is added.

Current membership/access fences apply to all rows, reads and publications.
Before joining, cached public messages create no demand or unresolved rows;
after joining, their relay verdict decides admission without replay or a join floor.
A finite feed completing does not imply context verdicts have completed. A
future UI must subscribe to both capabilities and honor both statuses. Neither
an empty list nor feed-ready establishes archive completeness.

## Validation scope

Colocated session tests cover verdict admission, local intent, bounded demand,
thread-only actions, frozen retries and feed edit/deletion/lifecycle closure.
They do not establish browser paint, real relay persistence, native acceptance
or human approval. Browser/hosted checks remain with the integration owner.
Reminders, follow/mute policy, full backlog discovery and the #499 UI are out of
scope; this is not a full original Inbox port.
