# Presence

`session.presence` is a volatile current-value directory, separate from message
retention, generic event reconciliation, and the durable outbox. Its values are
`online`, `away`, `offline`, and `unknown`. Unknown is not evidence of being offline.

## Ownership and traffic

- A timeline or thread owns one demand handle for its viewport plus a 160px margin;
  the profile panel owns its selected author. Avatar indicators only subscribe to
  per-author values. Repeated authors share work. Without IntersectionObserver,
  demand falls back to the bounded rendered window, not all retained history.
- A session accepts at most 256 unique demanded authors and 64 surface handles.
  Over-cap demand is rejected, not broadened. Empty or hidden demand removes its
  observer route and snapshot work; it does not stop the availability publisher.
- Presence shares the existing authenticated socket. Author interests have a
  one-second minimum REQ interval, at most two overlapping presence routes, and
  share the total 1,024 subscription-slot ceiling with normal routes. Presence
  updates do not restart the message stream and yield to foreground work. Two
  presence slots remain reserved; channel capacity is 1,020, or 1,019 when the
  independent Agent Activity observer is enabled.
- One background snapshot owner uses the existing verified reader. Reads have a
  five-second cooldown after completion or cancellation, not enqueue time: shared
  reader/broker queue delays must not compress successive actual reads. Repeated
  changes coalesce without moving an already scheduled deadline. Stable demand
  uses one 60–65 second backstop; failures wait at least 60 seconds and honor longer
  relay retry advice. These are per-session budgets, not a fleet-wide rate limit.
- Same-status renewals do not trigger a read or UI notification per heartbeat.
  Conflicting evidence becomes unknown and requests one rate-bounded confirmation.
  No separate socket, per-avatar polling, heartbeat journal, or durable replay.

## Authority and lifecycle

Live presence subjects come from the verified event author. Only a verified
relay-authored snapshot can use its single requested `p` tag as subject. A
successful bounded snapshot's omission means no current entry for that subject;
failed or obsolete reads do not establish offline. Snapshot `created_at` is the
relay's synthesis time, not heartbeat age or remaining lease duration.

Per-author lifetime/revision and session generation guards fence conflicts,
removal/re-add, visibility changes, access/cache clearing, and disposal. They do
not create a globally ordered snapshot/stream protocol. Exact expiry and perfectly
current status cannot be inferred from the existing wire contract.

## Activity and publishing

One app-level activity detector measures **Buzz input**, not operating-system
idle. Ten minutes without input produces Away (sampled every 30 seconds).
Window blur or switching communities is not Away. Each connected community/viewer
publisher sends its current status after startup, on status transitions, and
roughly every 60–65 seconds. It keeps one in-flight write and the latest desired
status; missed renewals are not replayed. Acceptance requires the matching socket
`OK`, not merely handing bytes to the broker.

Optional same-origin Web Locks coordinate one publisher per community/viewer;
BroadcastChannel shares recent local input. Unsupported hosts can publish once per
window. A frozen browser leader can miss renewals; neither mechanism coordinates
other devices. Connected retained communities continue renewing after navigation.
Ordinary teardown never publishes identity-wide Offline on another device's behalf.

## Backend limits

This client changes no relay storage or aggregation semantics. The audited relay
still performs a community lifecycle SQL lookup for a WS heartbeat, access queries
for HTTP snapshots, and SQL/pool work for `REQ limit:0`. Snapshots also require Redis
reads and relay signatures. Author scoping reduces delivered traffic/client work;
it does not remove candidate subscription matching or all backend work.

The relay aggregates by identity with last-arrival-wins status, not device leases.
Pod-local final disconnect can clear another device's entry without offline fanout.
Removing these costs and ambiguities requires separate server work with preserved
authorization/lifecycle fencing; this implementation does not claim zero SQL,
zero polling, exact expiry, or distributed-device correctness.

## Validation shape

Owner tests live in `src/features/presence/` and relay presence tests. Browser
journeys are `tests/browser/presence.spec.mjs` (observer lifecycle and real same-origin
lock/activity handoff) and `presence-integration.spec.mjs` (production conversation,
broker, snapshots, conflict repair, and route teardown). Channel-opening measurements
retain their existing warm-switch budget.

These browser tests use isolated identities and modeled relay policy. Passing
native compilation/tests is not native GUI acceptance; none of these establishes
deployed SQL/Redis load or production latency. See [the contribution workflow](contributing.md)
for batch gates and [browser testing](browser-testing.md) for measurement limits.
