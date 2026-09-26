# Account sync over one continuous stream

**Proposal for team review · 2026-09-22.** Direction, not a VISION, NIP, or wire
specification. Builds on the [earlier account-sync proposal][account-sync].

**On every WebSocket connection, the client sends its last persisted sync position
and an ordered queue of requested data. The relay derives the account's channels,
streams the changes needed to bring the client current, and continues delivering
live updates over the same connection.** First launch, a short disconnect, and a
week offline use the same process; the relay chooses between incremental delivery
and bounded replacement windows.

## 1. Connect with a sync position and a priority queue

After authentication, the client sends something conceptually like:

```text
SYNC {
  since: T | null,
  priority: [
    channel_head(A),
    thread_tail(A, root),
    history_before(A, cursor),
    channel_head(B)
  ]
}
```

`T` is a relay-issued position persisted with the state it describes. No usable
saved state means `null`. It is not the newest message timestamp or a
history-pagination cursor.

The bounded priority queue can contain multiple requests: the current channel, an
open thread, approaching history pages, and likely-next conversations. The client
can promote, deduplicate, cancel, or replace entries as the user navigates.

**This queue schedules work; it does not define subscriptions.** The relay derives
channel scope from membership. Removing B from the queue does not stop updates
for B. A request for an evicted channel head asks for a fresh baseline, even if the
account's sync position is already current.

## 2. Relay establishes catch-up and live delivery together

The relay establishes live capture and a consistent recovery boundary so changes
arriving during catch-up are not lost between the snapshot and subscription.

It then streams:

1. **Account state:** authorized channel roster, metadata, and synchronized account
   state needed by the sidebar.
2. **Channel data:** priority channels first, then the remaining channels in account
   scope.
3. **Repairs:** mutations, removals, or explicit invalidations needed to reconcile
   retained data.
4. **A checkpoint:** the position through which that reconciliation is complete.

For each channel, the relay chooses:

| Condition | Response |
| --- | --- |
| No baseline, newly joined channel, or unusable resume position | A bounded recent window and its rendering context. |
| Small amount of new traffic | The incremental changes. |
| More traffic than the delivery budget | A bounded recent window, explicitly marked as skipping history. |
| No relevant changes | No message bodies. |

`W` limits top-level messages, with separate byte/context limits for edits,
reactions, summaries, and thread tails. Mutation repair is not discarded merely
because its target is outside the newest W messages. Determine overflow from
omitted data, not merely `returned_count == W`.

An illustrative stream—not literal proposed Nostr frame names:

```text
ACCOUNT_STATE ...
CHANNEL A: delta [...], complete through boundary
CHANNEL B: recent window [...], omitted history, older cursor P
THREAD root: newest replies [...], older cursor Q
REPAIR: delete X; invalidate old range Y
CHECKPOINT T1

...live events and state changes...
CHECKPOINT T2
```

The client can display completed channel windows immediately; it does not wait
for one all-rooms JSON payload. But the **global checkpoint cannot pass unfinished
recovery work**. Background delivery must make progress even while navigation
changes the priority queue. Speculative history requests do not block the account
checkpoint.

Initial sync supplies a bounded head per channel. Global byte limits may chunk
that delivery, not silently omit channels and declare completion. Any future
summary-only policy needs explicit “body not prepared” state and a fresh window
on open. Newly granted channels receive a baseline even when their messages
predate T; revocations invalidate access and purge cached and staged data.

## 3. Apply catch-up and live updates through the same client owner

One session owner verifies and applies incoming data idempotently, updates the
shared stores, and persists the checkpoint coherently with the corresponding
state, including gaps and invalidations. Reuse today's session ownership rather
than introducing a competing feature-level sync engine.

A replacement window becomes authoritative only when its declared payload is
complete. Live updates arriving during replacement must be ordered or
revision-fenced so an older snapshot cannot overwrite them. Replayed events are
deduplicated.

After interruption, the client sends its last **durably applied** checkpoint—not
the last marker received from the socket. The relay may resend data. If it cannot
honor that position, it explicitly resets the affected state instead of pretending
recovery succeeded. Account, community, protocol, and server reset epochs prevent
incompatible checkpoint reuse.

Original messages remain signed Nostr events. Checkpoints, replacement bounds,
and invalidations are relay control assertions; ordinary EOSE is not sufficient
to express this contract. Negotiate support and keep the existing recovery path
for unsupported relays.

## 4. Store history as bounded segments, not one merged list

Channel and thread caches retain contiguous history segments with verified
pagination bounds, ordered by `(created_at, id)`, plus their rendering context:

```text
[older cached messages]  …known gap…  [current recent window]
```

A truncated catch-up creates a new segment. It does not silently concatenate the
new head with old cached rows. Scrolling toward the gap queues a finite history
request; segments merge only when returned coverage proves continuity. A history
gap is not the same thing as a “new since last read” divider.

Persist recently visited segments under byte/LRU budgets and preserve their
reading anchors. Prefetch pages before the viewport reaches an edge; start by
measuring 50–100 messages per page and bounded look-ahead. Batch verification off
the render-critical path. Evict whole ranges rather than leaving unmarked holes.
Reopening an evicted range requires a fresh finite read, not replay of the
account's entire history. Drafts, pending sends, and durable reading intent stay
separate from disposable fetched history.

This separates **keeping the account current** from **retrieving older messages**.
History pagination never rewinds or holds back the sync position.

## 5. Prepare thread tails before the click

Channel preparation includes a bounded newest-reply tail for threaded roots,
either bundled with the window or scheduled through the priority queue. A prepared
thread opens from cache at its newest replies, rendered chronologically; older
replies page upward using the same segment machinery. Navigation to a particular
reply still loads that target and its context. Preserve canonical thread ancestry
and same-channel access checks.

Preparation is bounded, so a cold miss still fetches. Mark a thread prepared only
when its root, tail, rendering context, and pagination bounds are available; do
not delay channel rendering while optional tails load. Live replies update
retained thread segments and channel summaries. On reconnect, a retained thread
needs repair or explicit invalidation even when its root is outside the channel's
recent window.

## Why this improves the current implementation

Today, buzz-app already has a shared relay session, prioritized finite reads,
signed window bounds, and bounded caches. Preserve those mechanisms. The change
is the common recovery contract around them:

- **Less reconnect orchestration:** replace separately assembled subscription
  replay, head refreshes, and thread repairs with one declared recovery exchange.
- **Less redundant transfer when resumable:** send relevant changes rather than
  automatically refreshing every retained head. Long absences still have bounded
  recovery. Required replay overlap affects the actual savings.
- **A meaningful completion boundary:** “reconciled through T” replaces trying to
  infer overall freshness from several independent reads and EOSEs. It does not
  mean the client possesses all history before T.
- **Honest history coverage:** distinguish a current recent head from continuous
  cached history; fetch missing ranges only when needed.
- **Fewer navigation-path reads:** persistent segments and queued thread
  preparation move work ahead of scrolls and clicks. Today disk stores channel
  heads rather than paged history; threads seed their roots but fetch replies
  oldest-first, with a capped range that cannot promise the newest tail.

These are architectural expectations, not benchmark results or unconditional
latency promises. Streaming one exchange is not necessarily one RTT.

## Main implementation decision: prove the sync position

A server-issued time watermark is the preferred candidate from this discussion,
but the existing database fence alone does not prove client delivery or mutation
coverage. Advancing T requires authoritative reconciliation or a recoverable
change mechanism—not just periodic markers on best-effort fanout. That proof
determines whether time is sufficient or a dedicated change position is necessary.

Client-authored `created_at` and transaction-start `received_at` are not
independently safe cursors. The existing replica fence is a candidate conservative
`created_at` watermark for guarded channel rows, with replay overlap of at least
about 16 minutes under the inspected constants, potentially longer. Its visibility
proof does not cover every account-state clock, in-place mutation, or lost pub/sub
update. Backfills, restores, retention expiry, and unavailable proofs need explicit
reset behavior. Slow clients must not silently lose changes and then receive a
success checkpoint.

Deletes, supersessions, edits, reactions, and access changes need replayable repair
records or explicit invalidation, including for old disk segments. Relay-signed
summaries, tombstones, and bounds distinguish authored content from relay
assertions.

Server-derived unread summaries are a related projection decision, not a
prerequisite for this transport model. Preserve existing per-message read
semantics, manual unread, thread attention, and encrypted read-state privacy
unless we explicitly choose to change them. A simple `latest_activity > marker`
comparison would change both semantics and server visibility.

## Validation and review

This proposal changes no runtime behavior. Before implementation, settle the
checkpoint proof, account-wide delivery cost, and cache/prefetch/thread-tail
budgets. Review any read-state projection separately.

Validate brief/long disconnects, equal timestamps and late commits, dropped
fanout, deletes/edits outside the head, regrant, partial responses, checkpoint-write
crashes, eviction, and slow clients. Two clients with different cache budgets need
equivalent current data where coverage overlaps—not identical cached histories.
Measure reconnect bytes/queries, selected/sidebar time-to-current, scroll-buffer
misses, and thread click-to-first-reply/newest-tail, including preparation hit rate.

## Sources and current contracts

Current-client observations checked at `buzz-app` `4ac257e`:
[session and recovery](relay-queries.md), [cache and reader budgets](channels.md),
[read semantics and privacy](unread.md), and
[live replay](../src/features/relay/live.ts),
[head merging/retention](../src/features/relay/store.ts).
Relay candidate mechanism inspected at `block/buzz` `77729abfb`:
[replica fence][fence] and [opt-in storage guard][guard]. These are source findings,
not proof that the required configuration is deployed.

[account-sync]: https://github.com/block/buzz-app/blob/892c2d22735e6d6c541dadc74ffc50765775d6a1/docs/account-sync-proposal.md
[fence]: https://github.com/block/buzz/blob/77729abfb/crates/buzz-db/src/runtime/replica_fence.rs
[guard]: https://github.com/block/buzz/blob/77729abfb/migrations/0021_created_at_fence_floor.sql
