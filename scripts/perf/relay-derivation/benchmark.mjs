// Bundled with the pinned rolldown against the selected source tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { DiscoveryState } from "../../../src/features/relay/discovery.ts";
import { retainEvents } from "../../../src/features/relay/projection.ts";
import { MessageProjection } from "../../../src/features/relay/message-projection.ts";
import { createChannelStore } from "../../../src/features/relay/store.ts";
import { createProfileDirectory } from "../../../src/features/relay/profile-directory.ts";
import { createRelayProfiler } from "../../../src/features/relay/profiling.ts";

const hex = (n) => n.toString(16).padStart(64, "0");
const viewer = hex(1),
  relayAuthor = hex(2);
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
function event(n, kind, tags, content = "", time = 1700000000) {
  return Object.freeze({
    id: hex(n),
    pubkey: relayAuthor,
    kind,
    content,
    created_at: time,
    tags: Object.freeze(tags.map((t) => Object.freeze(t))),
    sig: "a".repeat(128),
  });
}
function discoveryEvents(count, version = 0) {
  return Object.freeze(
    Array.from({ length: count }, (_, i) => {
      const id = `channel-${i}`;
      const type = i % 16 === 0 ? "system" : i % 8 === 0 ? "dm" : "stream";
      const members = [
        viewer,
        ...Array.from({ length: i % 3 === 0 ? 64 : 12 }, (_, j) =>
          hex(100 + j),
        ),
      ];
      return [
        event(
          10000 + i * 2 + version * 10000,
          39002,
          [["d", id], ["t", type], ...members.map((p) => ["p", p])],
          "",
          1700000000 + version,
        ),
        event(
          10001 + i * 2 + version * 10000,
          39000,
          [
            ["d", id],
            ["t", type],
            ["name", `Channel ${String(i).padStart(4, "0")}`],
            ["private"],
            ["about", "Synthetic 🐝 metadata"],
            ["ttl", "604800"],
          ],
          JSON.stringify({ name: `Channel ${String(i).padStart(4, "0")}` }),
          1700000000 + version,
        ),
      ];
    }).flat(),
  );
}
function history(count, offset = 0, channel = "channel-1") {
  return Object.freeze(
    Array.from({ length: count }, (_, i) =>
      event(
        100000 + offset + i,
        i % 10 === 9 ? 7 : 9,
        [
          ["h", channel],
          ...(i % 10 === 9 ? [["e", hex(100000 + offset + i - 1)]] : []),
        ],
        i % 10 === 9
          ? "+"
          : `Message ${i}: héllo 🐝 ${"immutable chat content ".repeat(8)}`,
        1700000000 + Math.floor(i / 3),
      ),
    ),
  );
}
function state(events) {
  const d = new DiscoveryState(viewer, relayAuthor);
  for (const e of events) d.accept(e);
  return d;
}
function derive(d) {
  const readable = d.readable();
  // Baseline ignores this optional argument and derives again. Candidate shares
  // the same synchronous result, exactly as its store call site does.
  return {
    channels: d.channels(readable),
    readable: readable.map((c) => c.id),
  };
}
function store(withStartupSave = false) {
  let reads = 0,
    notifications = 0,
    startupWrites = 0,
    saved;
  const reader = {
    read: async () => {
      reads++;
      throw new Error("Unexpected benchmark I/O");
    },
  };
  const directory = createProfileDirectory(reader);
  const owner = createChannelStore(
    {
      ...reader,
      viewer,
      relayAuthor,
      media: () => undefined,
      visible: (events) => events,
      revokeAccess: (commit) => commit(),
    },
    directory,
    {
      now: () => 1700000000000,
      ...(withStartupSave
        ? {
            persistence: {
              async writeStartup(value) {
                startupWrites++;
                saved = value;
              },
              close() {},
            },
          }
        : {}),
    },
  );
  const stop = owner.queries.subscribeList(() => notifications++);
  return {
    owner,
    receipt: () => ({
      reads,
      notifications,
      list: owner.queries.list(),
      startupWrites,
      saved,
    }),
    dispose() {
      stop();
      owner.dispose();
      directory.dispose();
    },
  };
}
const cases = [];
let counts = {};
if (process.env.COUNTS) {
  for (const name of ["get", "readable", "channels"]) {
    const original = DiscoveryState.prototype[name];
    DiscoveryState.prototype[name] = function (...args) {
      counts[name] = (counts[name] ?? 0) + 1;
      return original.apply(this, args);
    };
  }
  const original = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (...args) {
    counts.encodes = (counts.encodes ?? 0) + 1;
    const result = original.apply(this, args);
    counts.encodedBytes = (counts.encodedBytes ?? 0) + result.byteLength;
    return result;
  };
}
for (const n of [16, 128, 512, 1024]) {
  const events = discoveryEvents(n);
  for (const mode of ["cold", "hot", "fresh"]) {
    cases.push({
      name: `helper-discovery-${mode}-${n}`,
      category: "helper",
      scale: n,
      mode,
      operations: mode === "hot" ? 80 : 30,
      setup() {
        const d = state(events);
        const fresh = Array.from({ length: 30 }, (_, i) =>
          mode === "fresh" ? discoveryEvents(n, i + 1) : null,
        );
        return {
          run(i) {
            return derive(
              mode === "cold"
                ? state(events)
                : mode === "fresh"
                  ? state(fresh[i])
                  : d,
            );
          },
          close() {},
        };
      },
    });
  }
  for (const withStartupSave of n === 1024 ? [false, true] : [false])
    for (const mode of ["cold", "hot"])
      cases.push({
        name: `store-${withStartupSave ? "saved-" : ""}discovery-${mode}-${n}`,
        category: "store",
        scale: n,
        mode,
        operations: mode === "cold" ? 24 : 80,
        setup() {
          const s = store(withStartupSave);
          s.owner.acceptDiscovery(events);
          const updates = Array.from({ length: 80 }, (_, i) =>
            discoveryEvents(1, i + 1),
          );
          return {
            run(i) {
              if (mode === "cold") {
                const c = store(withStartupSave);
                c.owner.acceptDiscovery(events);
                const result = c.receipt();
                c.dispose();
                return result;
              }
              // Observed relay roster/metadata update: both are already verified at
              // this store boundary. acceptDiscovery commits/notifies synchronously.
              s.owner.acceptDiscovery(updates[i]);
              return s.receipt();
            },
            close() {
              s.dispose();
            },
          };
        },
      });
}
for (const n of [120, 640, 2000]) {
  for (const mode of ["cold", "hot", "fresh", "multi"])
    cases.push({
      name: `helper-retain-${mode}-${n}`,
      category: "helper",
      mode,
      scale: n,
      operations: 120,
      setup() {
        const events = history(n);
        const fresh =
          mode === "fresh"
            ? Array.from({ length: 120 }, (_, i) => history(n, i * 10000))
            : [];
        const many =
          mode === "multi"
            ? Array.from({ length: 16 }, (_, i) =>
                history(n, i * 10000, `channel-${i}`),
              )
            : [];
        let retained = retainEvents(events);
        return {
          run(i) {
            const input =
              mode === "fresh"
                ? fresh[i]
                : mode === "multi"
                  ? many[i % 16]
                  : mode === "cold"
                    ? events
                    : [...retained, events[i % n]];
            retained = retainEvents(input);
            return retained;
          },
          close() {},
        };
      },
    });
  cases.push({
    name: `helper-status-${n}`,
    category: "helper",
    mode: "hot",
    scale: n,
    operations: 200,
    setup() {
      const events = history(n);
      const p = new MessageProjection(
        "channel-1",
        relayAuthor,
        createRelayProfiler(),
      );
      p.reconcile(events, []);
      const operation = { event: events[0], delivery: "sending" };
      return {
        run(i) {
          return p.reconcile(events, [
            { ...operation, delivery: i % 2 ? "accepted" : "sending" },
          ]);
        },
        close() {},
      };
    },
  });
}
// Work receipts include complete output hashes for every operation, computed
// outside timed regions. Input events are deterministic, deeply frozen and
// synthetic; no signing, signature verification, network or fixture generation
// occurs in timed regions. Cold creates model/store owners, not new Node/V8.
const results = [];
const selected = cases.filter(
  (c) => !process.env.CASE || c.name === process.env.CASE,
);
const profile = process.env.PROFILE;
let session;
const post = (method, args = {}) =>
  new Promise((resolve, reject) =>
    session.post(method, args, (e, r) => (e ? reject(e) : resolve(r))),
  );
for (const c of selected) {
  const warm = c.setup();
  for (let i = 0; i < c.operations; i++) warm.run(i);
  warm.close();
  const fixture = c.setup();
  const outputs = [];
  // Pre-GC avoids counting previous case garbage. End heap delta is a transient
  // proxy; retained delta after GC is not allocation volume.
  global.gc();
  const beforeHeap = process.memoryUsage().heapUsed;
  let gcCount = 0,
    gcMs = 0;
  const observer = new PerformanceObserver((items) => {
    for (const e of items.getEntries()) {
      gcCount++;
      gcMs += e.duration;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  if (profile) {
    session = new inspector.Session();
    session.connect();
    await post("Profiler.enable");
    await post("HeapProfiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 100 });
    await post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await post("Profiler.start");
  }
  const cpuStart = process.cpuUsage();
  counts = {};
  const start = performance.now();
  for (let i = 0; i < c.operations; i++) outputs.push(fixture.run(i));
  const durationMs = performance.now() - start;
  const workCounts = { ...counts };
  const cpu = process.cpuUsage(cpuStart);
  const heapAfter = process.memoryUsage().heapUsed;
  if (profile) {
    writeFileSync(
      `${profile}.cpuprofile`,
      JSON.stringify((await post("Profiler.stop")).profile),
    );
    writeFileSync(
      `${profile}.heapprofile`,
      JSON.stringify((await post("HeapProfiler.stopSampling")).profile),
    );
    session.disconnect();
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  observer.disconnect();
  const checksums = outputs.map(digest);
  // All outputs intentionally stay alive during timing; their cost is identical.
  const final = outputs.at(-1);
  const receipt = {
    operations: c.operations,
    scale: c.scale,
    checksum: digest(checksums),
    finalChecksum: digest(final),
    ...(c.name.includes("discovery")
      ? {
          listed:
            c.category === "store"
              ? final.list.channels.length
              : final.channels.length,
          ...(c.category === "store"
            ? {
                notifications: final.notifications,
                reads: final.reads,
                startupWrites: final.startupWrites,
                savedEvents: final.saved?.discovery.events.length,
              }
            : { readable: final.readable.length }),
        }
      : { retained: final.length }),
  };
  if (c.name.includes("discovery")) {
    assert.equal(receipt.listed, c.scale - Math.ceil(c.scale / 16));
    if (c.category === "store") assert.equal(receipt.reads, 0);
    if (c.name.includes("saved-discovery")) {
      assert.equal(
        receipt.startupWrites,
        c.mode === "cold" ? 1 : c.operations + 1,
      );
      assert.equal(receipt.savedEvents, c.scale * 2);
    }
  } else assert.ok(receipt.retained <= 2000);
  outputs.length = 0;
  fixture.close();
  global.gc();
  results.push({
    case: c.name,
    category: c.category,
    mode: c.mode,
    ...receipt,
    durationMs,
    usPerOp: (durationMs * 1000) / c.operations,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    gcCount,
    gcMs,
    transientHeapDeltaBytes: heapAfter - beforeHeap,
    retainedHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
    warmupOperations: c.operations,
    workCounts,
  });
}
console.log(
  JSON.stringify({
    label: process.env.LABEL,
    run: process.env.RUN,
    pid: process.pid,
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    results,
  }),
);
