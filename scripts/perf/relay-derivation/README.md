# Relay derivation experiment

This opt-in Node harness uses production helpers and the actual channel store and
profile directory. It measures synchronous model work after the verified-event
boundary. It does not measure UI, browser, native, transport/signature verification,
disk/IndexedDB hydration, or production end-to-end latency.

Use the repository's pinned tools and installed locked dependencies. No benchmark
dependencies are added. Bundle the **same harness** against each source checkout:

```sh
TOOL_ROOT="$PWD" bin/node scripts/perf/relay-derivation/build.mjs \
  /absolute/baseline /absolute/results/baseline.mjs
bin/node scripts/perf/relay-derivation/build.mjs \
  "$PWD" /absolute/results/candidate.mjs
LABEL=baseline RUN=1 bin/node --expose-gc /absolute/results/baseline.mjs
LABEL=candidate RUN=1 bin/node --expose-gc /absolute/results/candidate.mjs
```

Run serially on the same workstation without concurrent builds/tests. Alternate
baseline/candidate ordering each round, retaining at least ten fresh processes
per source. Each process warms each case with one complete separate batch before
measuring an identical batch. `CASE=store-discovery-hot-1024` selects one case.
Each JSON line includes complete per-operation output checksums and work receipts;
compare these before timings. Fixture generation, output hashing and final forced
GC are outside timing. Output references are retained identically during timing.

Discovery uses 16/128/512/1024 channels, one system channel in sixteen, one DM in
sixteen, 13 or 65 members, Unicode names/descriptions and TTL metadata. Helpers
derive readable and listed summaries; the list method accepts the synchronous
readable result (the baseline ignores that argument). The integrated store cases
use `acceptDiscovery`, its real list/snapshot/subscriber path and profile directory.
They assert zero I/O and the expected system exclusion. Cold cases construct a new
owner and hydrate its model from synthetic verified-shaped evidence; hot store
cases apply a newer roster/metadata pair to an already populated model. Fresh helper
cases use new event objects per operation. No cache reuse is required for the gain.

At 1024 channels, `store-saved-discovery-*` also enables the actual store's
startup-save derivation through an in-memory write sink. This includes its extra
channel-summary pass and saved-event assembly, with complete saved-output hashes.
The sink records writes synchronously and resolves immediately; no disk I/O or
serialization is modeled. The ordinary store cases omit persistence.

Retention cases use 120/640/2000 total immutable events (90% messages, 10%
reactions). Cold is a full collection pass, hot repeats retained evidence with a
duplicate, fresh uses disjoint event objects, and multi rotates sixteen channels.
Status cases exercise `MessageProjection` with alternating delivery transitions.
These unchanged-owner controls provide context, not additional optimizations.

`COUNTS=1` separately instruments summary builds and UTF-8 serialization calls.
Never mix these diagnostic timings with ordinary samples. `PROFILE=/absolute/stem`
captures CPU (100 µs sampling interval) and sampled allocation (16 KiB interval,
including collected objects) for a selected case's measured batch only. Profiled
timings are diagnostic. Sampled allocation is a stochastic V8 estimate, not exact
allocation bytes or retained heap. Heap deltas include harness/V8 effects; the
after-GC delta is a retained-memory proxy, not allocation volume. GC callbacks are
drained across two immediate turns; durations can include pre-measurement forced GC
delivery and are diagnostic only. Retained heap is measured after releasing output
arrays and closing fixture owners, but the local final-output reference survives.

Behavioral differential checks use 1,600 seeded state transitions plus retention
entry/byte boundaries, Unicode, duplicate replacement and local/remote precedence:

```sh
TOOL_ROOT="$PWD" bin/node scripts/perf/relay-derivation/build.mjs \
  /absolute/baseline /absolute/results/diff-baseline.mjs \
  "$PWD/scripts/perf/relay-derivation/differential.mjs"
bin/node /absolute/results/diff-baseline.mjs
# Repeat against candidate and require identical receipts.
```

The differential fixture injects synthetic records at trusted internal boundaries;
it does not establish signature or native/real-relay correctness. Ordinary relay
regressions remain authoritative for lifecycle, failure, revocation and persistence.
