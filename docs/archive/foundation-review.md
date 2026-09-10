# Foundation query and delivery review — 2026-09-07

> Historical evidence, archived 2026-09-09. This records successive review states,
> not the current plan or release approval; paths, test counts and uncommitted/pushed
> descriptions below refer to their original checkpoints. For maintained decisions
> and open gates, see [foundation status](../status.md); for current commands and
> fixture URLs, see [contributing](../contributing.md).

The architecture is a promising bounded relay data layer. Keep its session ownership,
verified-event boundary, durable outbox, stable event IDs, and domain projections.
It is not yet demonstrated to be an ultra-high-performance general query engine.

## Changes and evidence

- **Confirmed sends held delivery slots.** A verified echo removed the operation
  from the visible outbox but left its HTTP publication occupying one of three
  delivery slots until ACK or timeout. With three hanging publishers, a fourth
  message stayed queued. `outbox.ts` now aborts the completed attempt when verified
  evidence arrives, releasing its slot without waiting for ACK. Confirmation still
  wins over late failure. A new regression test reproduced the failure and passes
  after the change, including a publisher that ignores cancellation.
- **Queued messages escaped the timeout.** Delivery deadlines now start when
  sending/retrying is enqueued and cover both waiting and active work. A regression
  test holds all three slots, queues another send and verifies it leaves “sending”
  within its original budget. Duplicate retry cannot reset the queue deadline.
- **Startup commits could temporarily erase restored intent.** A send timing out
  before asynchronous hydration queued a status save containing only the new
  operation. After hydration, that intermediate commit omitted the older journal;
  a subsequent save repaired it, leaving a crash window. Persistence now takes the
  current snapshot after hydration and prior commits finish. The new test checks
  every committed snapshot, not just the final state.
- **Cold sends paid unnecessary timer delays.** Journal verification yielded every
  12 records using nested zero-delay timers. It now uses `MessageChannel`, sharing
  the yielding helper with response verification. Small CPU batches and signature
  verification remain intact. In the in-app browser with 512 restored signed
  records and real IndexedDB, cold send-to-acceptance fell from **347.9 ms to
  181.4 ms**; hydration fell from **342.6 ms to 178.0 ms**. Warm sends were **3.5 ms
  and 3.2 ms**, respectively. These are illustrative local measurements, not
  production percentiles; signing and publishing use local fixtures.

Run `just web` and open `/tests/relay-startup.html` to repeat the cold/warm diagnostic.
The existing `/tests/relay-storage.html` and `/tests/relay-composer.html?durable`
exercise real IndexedDB and the composer with ephemeral identities.

`just iterate` and `just scan` passed, including 93 Vitest tests, 19 Node tests,
the Rust tests, TypeScript/build checks and Clippy. Biome still reports warnings.
The 2,400-row integration measured **0.94 ms** for synchronous insertion, one
message fold, stable unaffected row identities and no unrelated-view notification.
Browser checks passed storage migration/deletion/isolation and composer delivery.

No live relay messages were posted. These fixes address reproduced client defects
and startup overhead; they do not prove the cause of the reported live first-send
stall. A slow live reproduction still needs the existing **Outbox → Relay timings**
capture to distinguish load/queue, signing and publication. Broker integration
already verifies that deliberately delayed upstream publication is attributed to
`broker.upstream` rather than local rendering.

## Can this become stable and extremely fast?

Yes, within explicit workload and memory budgets. The important semantics are
already here: durable intent before publish, exact-event retries, explicit unknown
outcomes, authoritative echoes, stale-read protection and session cancellation.

The next work should address these concrete limits:

1. **Cold hydration and storage ownership.** All restored signatures still gate
   the first send. Measure full journals on slower devices before considering
   worker verification or separate pending/confirmed hydration. Define coordination
   for multiple windows writing the same partition; IndexedDB transactions alone
   do not synchronize their independent in-memory journals.
2. **Incremental work and aggregate retention.** `MessageProjection` folds only
   changed messages, but reconstructs input maps and scans history; content changes
   sort the rows. Generic views merge/sort on updates and scan local operations.
   Sixty-four independently bounded views can collectively retain a large amount
   of data. Index affected subscriptions and enforce a session-wide budget before
   claiming scalability from the single-window fold test.
3. **Explicit query semantics.** `observe()` retains a union of bounded evidence
   across refreshes. It is not a replacement-snapshot query cache. Define freshness,
   removal, membership changes, and ranked search/feed behavior for each domain;
   these semantics must be part of the contract.

Measure p50/p95/p99 cold and warm delivery stages, main-thread stalls, memory,
reconnect recovery and many-view workloads. One fast synchronous insertion does
not measure send-to-ACK latency or establish a production performance guarantee.

## Should a query library be used?

Use [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
for conventional HTTP resource lifecycles, such as GitHub detail panels: shared
requests, freshness, retries and garbage collection. Pilot it at that boundary
when adding shared caching, rather than extending ad hoc component fetch state.

Do not wrap every `session.read()` in another optimistic cache. The relay session
already owns local/remote reconciliation and durable delivery. Two owners would
make invalidation and consistency harder. A query library would not fix a slow
signer, upstream ACK or journal hydration.

[TanStack DB](https://tanstack.com/db/latest/docs/overview) is the more relevant
candidate for a future incremental collection/query layer. Evaluate it with a
bounded prototype if cross-entity joins and subscription indexing become central.
Its documentation currently labels the release v0; adopting it would still require
preserving relay authorization, history bounds and durable unknown-delivery
semantics. No dependency change is needed for the fixes in this review.

## Is the UX-facing interface minimal and elegant?

The domain path is close: `useChannelWindow(session.channels, channelId)` and
`session.messages.send(channelId, text)` let the composer own just its draft while
all views share delivery state. Keep that direction.

The generic plugin path still makes authors own filter construction, view creation,
subscription, refresh and disposal. Add a small React adapter for generic views
with lifecycle-safe creation/cleanup, including Strict Mode behavior, when a second
consumer needs it. Expose domain capabilities such as `messages.canSend()` so a
composer need not know that top-level messages use kind 9. Keep raw filters and
outbox operations available for advanced plugins, behind the domain conveniences.

Avoid broadening the public surface into a new query DSL until real feature needs
justify it. The immediate simplification here is one shared yielding helper and
one authoritative completion path for delivery slots.
