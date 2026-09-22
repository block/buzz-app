# One recovery model for channels, history, and threads

**Proposal for team review · 2026-09-22.** Direction, not a VISION, NIP, or wire
specification. Builds on the [earlier account-sync proposal][account-sync].

## Recommendation

**Let the relay get the account current; let the client prioritize what the user
will read and retain a bounded, honest cache.** On every connection, the client
sends its last server-issued checkpoint and an ordered queue of priority requests.
The relay derives channel scope from membership, returns changes or bounded fresh
windows, then continues live delivery. Channels and threads share cached history
segments and demand-driven pagination.

This solves three related problems: reconnect recovery assembled from separate
reads, history that can look continuous when it is not, and thread replies that
require a fetch after clicking. It is not a full-history download or merely a move
from HTTP to WebSockets. The benefit is one defined recovery contract across clients.

**Decision requested:** agree on account-wide coverage, a multi-entry priority
queue, bounded persistent segments, and ready-to-open thread tails. Validate the
checkpoint mechanism and read-state semantics before specifying the protocol.

## Why change

Today, buzz-app already has a shared relay session, prioritized finite reads,
signed window bounds, and bounded caches. Preserve those owners and guarantees.
The missing piece is a common account-level recovery boundary:

- **Reconnect repeats several kinds of work.** Per-channel live subscriptions
  replay from roughly five minutes before route creation, while retained heads,
  thread views, and unread evidence repair separately. A refreshed head is not
  proof that every retained entity was reconciled.
- **Cached history does not describe gaps.** Catch-up merges a fresh head into
  retained rows. After enough offline traffic, old history and a new head can
  appear adjacent without evidence that nothing was skipped.
- **History and threads are not prepared for the next interaction.** Disk stores
  channel heads, not paged history; there are three unpinned in-memory history
  windows. Threads seed their root immediately but fetch replies oldest-first,
  in pages of 50, with a capped range that cannot promise the newest tail.
- **Sidebar evidence is incomplete.** Unread derives from bounded local evidence;
  different samples can disagree. Manual-unread intent is currently local-only.

These are source-level observations, not production measurements. See [sources
and current contracts](#sources-and-current-contracts).

## What users should experience

| Moment | Intended behavior |
| --- | --- |
| Open or resume | Authorized cache paints immediately; sidebar and selected conversation become current in the first prioritized response, without per-channel subscription setup. |
| Brief disconnect | Reuse retained state; transfer changes plus necessary replay overlap, rather than reload every head. |
| Long absence or first launch | Bound work with fresh recent windows; identify missing ranges instead of downloading the backlog. |
| Scroll or revisit | Keep the reading anchor; reuse recently viewed history from disk and prefetch before reaching its edge. |
| Open a visible thread | Paint the root and newest reply tail from prepared data; fetch older replies on scroll. |
| Change on another device | Reconcile read intent, edits, deletions, reactions, and access changes without manual refresh. |

These are targets to measure, not unconditional latency promises. One streamed
exchange is not necessarily one RTT; a bounded cache is not unlimited offline history.

## How client and relay cooperate

### 1. Account-wide scope, with a real priority queue

The relay derives **all joined/authorized channels** from membership. Deltas and
live coverage include that entire scope; the client does not enumerate channels
to subscribe. Newly granted channels receive a fresh baseline even if their
messages predate the checkpoint. Revocations purge memory and disk immediately.

The client sends a **bounded, ordered queue**, not just one viewing ID: active
channel, open thread, visible thread tails, imminent history pages, and likely-next
conversations. Promote, deduplicate, and cancel work as navigation changes.
Foreground reading outranks speculation without starving background work; reuse
the existing session/reader ownership.

Priority controls order and preparation depth, **not access or subscription**.
Removing a channel from the queue does not stop its account-wide updates. Initial
sync supplies a bounded head per channel; global byte limits may chunk delivery,
not silently omit channels and declare completion. Any later summary-only policy
needs explicit “body not prepared” state and a fresh window on open.

### 2. One bootstrap/resume exchange, then live delivery

Illustrative interaction, not proposed frame syntax:

```text
Client → Sync(last checkpoint if retained, ordered priority requests)
Relay  → Current roster/account/sidebar state
       → Per-channel changes or fresh bounded windows, priority work first
       → Required thread tails, mutation repairs, and explicit gaps/invalidations
       → Checkpoint covering the completed reconciliation
       → Ongoing live updates; further checkpoints only after proven reconciliation
Client → Reprioritize work; request older pages; submit reading intent
```

For each channel, return at most W recent top-level messages with the supporting
edits, reactions, and summaries needed to render them. W counts display messages,
not arbitrary auxiliary events; the whole response also needs byte bounds. A quiet
channel may return no new messages. An overflowing delta returns a recent window
and explicit missing-range information. Determine overflow from omitted data, not
merely `returned_count == W`.

Persist applied state, gap/invalidation metadata, and checkpoint together. A
checkpoint means **the bounded read model has been reconciled**, not “I possess all
messages before this time.” Missing or evicted scopes need a baseline on demand;
a global checkpoint cannot turn an empty cache into a current one. Account,
community, protocol, and server reset epochs must prevent incompatible reuse.

### 3. Persist bounded segments; page ahead of scrolling

A segment is a contiguous history range with verified boundaries, ordered by
`(created_at, id)`, plus its supporting state. When catch-up skips history, start a
new segment; keep the old one separately rather than joining them by ID. Scrolling
into the gap requests missing pages. Merge only when coverage proves continuity.
An unseen-history gap is not the same thing as a “new since last read” divider.

Keep current and recently visited channel/thread segments on disk under explicit
byte and LRU budgets, with smaller rendered/in-memory windows. Evict whole ranges,
not unmarked holes; preserve scroll anchors where their data survives. No client
needs to store the channel since creation. Existing drafts, pending sends, and
durable read intent remain separate from disposable fetched history.

Older-history reads stay finite: try 50–100 messages per scroll page, bounded
look-ahead, and priority promotion near the edge. Batch verification off the
render-critical path; measure network, CPU, and layout before choosing budgets.

### 4. Prepare thread tails with visible channel rows

Bundle a bounded newest-N reply tail with each prepared threaded root, or fetch it
through the priority queue before that row needs it. Channel snapshots already
carry thread summaries; summaries alone do not contain reply bodies. Mark a thread
as **prepared** only when its root, tail, required overlays, and pagination bounds
are available. Do not delay showing channel messages while an optional tail loads;
measure cold preparation misses rather than claiming those clicks were instant.

Thread opening renders that tail chronologically, anchored at the newest replies;
older replies page upward. Explicit navigation to a particular reply still loads
that target and its context. Share segment storage, eviction, and scheduling with
channels, but preserve canonical thread ancestry and same-channel access checks.
Account-wide replies update retained thread state and summaries. A bounded channel
head alone cannot prove a retained thread is current: repair its range or mark it
stale explicitly, including when its root is outside the new head.

## Correctness decisions to settle before implementation

**Prefer server-issued time as the resume position, but prove the contract.**
Client-authored `created_at` and transaction-start `received_at` are not independently
safe cursors. The existing relay replica fence is a candidate for a conservative
`created_at` watermark: its floor, transaction observation, and reader handshake
prove database visibility for guarded channel rows. This implies replay overlap of
at least about 16 minutes under the inspected constants, potentially longer—not
zero traffic after every short disconnect.

That fence does **not** prove delivery to a client, cover all non-channel state, or
repair in-place mutations. Registering live delivery before a snapshot avoids one
handoff race, but at-most-once pub/sub can still lose updates. Advancing checkpoints
requires authoritative reconciliation or another proven loss-recovery mechanism,
not a timer. Backfills, server restores, and unavailable proofs need explicit reset
behavior. Return current account/summary state initially; do not compare unrelated
`updated_at` and `created_at` clocks as if one fence covered both.

**Repair old mutations, not only new messages.** Deletes, supersessions, and access
changes need replayable records or explicit range invalidation, including for old
disk segments. An edit/reaction targeting outside the newest W also needs repair
coverage; it must not disappear behind a top-level-message cap. Relay-signed
summaries, tombstones, and bounds preserve the distinction between authored content
and relay assertions. Journal retention expiry must force reset, never false resume.

**Server-derived unread is a product/privacy decision as well as a projection.**
The proposed destination is consistent sidebar summaries and synchronized read
intent. But today's automatic reading marks individual visible messages, not an
entire prefix; markers are self-encrypted. A simple `latest_activity > read_marker`
would silently change both semantics and server visibility. Review the representation
and privacy tradeoff explicitly, preserving individual reads, manual unread, and
thread attention unless a separate product decision changes them. Do not remove
the evidence engine before its replacement meets that contract.

## Delivery and review

Stage behind capability negotiation: prove checkpoint/mutation/access/read-state
semantics, add account sync and segments, then tune history and thread preparation.
Keep the existing path for unsupported relays. This PR changes no runtime behavior.

Validate with brief/long disconnects, equal timestamps and late commits, dropped
fanout, deletes/edits outside the head, regrant, partial responses, checkpoint-write
crashes, eviction, and slow clients. Two clients with different cache budgets need
equivalent current data where coverage overlaps—not identical cached histories.
Measure reconnect bytes/queries, selected/sidebar time-to-current, scroll-buffer
misses, and thread click-to-first-reply/newest-tail (including preparation hit rate).

Team review should settle:

1. Is account-wide bounded-head coverage worth its cold-start cost, with a
   multi-entry queue prioritizing the user's next action?
2. Can the time-fence approach satisfy the complete recovery contract at acceptable
   overlap cost, or do we need a dedicated change position?
3. What read-state representation preserves the desired behavior and privacy?
4. What W/N, memory/disk, and prefetch budgets meet the measured interaction targets?

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
