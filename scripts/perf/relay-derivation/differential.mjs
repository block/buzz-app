import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DiscoveryState } from "../../../src/features/relay/discovery.ts";
import { createChannelStore } from "../../../src/features/relay/store.ts";
import { createProfileDirectory } from "../../../src/features/relay/profile-directory.ts";
import {
  retainEvents,
  projectEvents,
} from "../../../src/features/relay/projection.ts";
const hex = (n) => n.toString(16).padStart(64, "0");
const viewer = hex(1),
  relayAuthor = hex(2);
const freeze = (x) => {
  if (typeof x === "object" && x !== null) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const event = (n, kind, id, version, tags = [], content = "") =>
  freeze({
    id: hex(n),
    pubkey: relayAuthor,
    kind,
    created_at: version,
    tags: [["d", id], ...tags],
    content,
    sig: "a".repeat(128),
  });
const output = [];
let steps = 0;
for (const seed of [1, 7, 42, 20261020]) {
  let random = seed;
  const next = (n) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % n;
  };
  const d = new DiscoveryState(viewer, relayAuthor, 16);
  const reader = {
    read: async () => {
      throw new Error("Unexpected differential I/O");
    },
  };
  const dir = createProfileDirectory(reader);
  const s = createChannelStore(
    {
      ...reader,
      viewer,
      relayAuthor,
      media: () => undefined,
      visible: (x) => x,
      revokeAccess: (fn) => fn(),
    },
    dir,
    { now: () => 1000 },
  );
  let notifications = 0;
  const stop = s.queries.subscribeList(() => notifications++);
  const events = [];
  for (let i = 0; i < 400; i++) {
    const id = `c-${next(20)}`,
      action = next(9);
    const before = s.queries.list();
    if (action < 4) {
      const e =
        action < 2
          ? event(
              i + 1000,
              39002,
              id,
              next(30),
              next(3)
                ? [
                    ["p", viewer],
                    ["p", hex(8)],
                    ["p", viewer],
                  ]
                : [],
            )
          : event(
              i + 1000,
              39000,
              id,
              next(30),
              [
                ["t", ["stream", "dm", "system", "forum"][next(4)]],
                [next(2) ? "public" : "private"],
                ["name", `Name ${next(4)} 🐝`],
              ],
              "{}",
            );
      const cached = next(4) === 0;
      d.accept(e, cached);
      s.acceptDiscovery([e], undefined, undefined, cached);
      events.push(e);
    } else if (action === 4 && events.length) {
      const e = events[next(events.length)];
      d.accept(e);
      s.acceptDiscovery([e]);
    } else if (action === 5) {
      d.deny(id);
      s.denyChannel(id);
    } else if (action === 6) {
      d.suspend(id);
      s.suspendPreviews([id]);
    } else if (action === 7) {
      d.restrictToKnown();
    } else {
      const versions = d.rosterVersions();
      d.retain(new Set([id]), versions);
    }
    const readable = d.readable();
    const channels = d.channels(readable);
    assert.deepEqual(channels, d.channels());
    assert.ok(channels.every((c) => c.channelType !== "system"));
    const list = s.queries.list();
    assert.ok(Object.isFrozen(list) && Object.isFrozen(list.channels));
    output.push({
      seed,
      i,
      channels,
      readable,
      access: Array.from({ length: 20 }, (_, n) => {
        const id = `c-${n}`;
        return [
          d.canAccess(id),
          d.canParticipate(id),
          d.get(id),
          s.canAccess(id),
          s.canParticipate(id),
          s.queries.get(id),
        ];
      }),
      list,
      stable: before === list,
      notifications,
      overflow: d.overflowRevision,
      revision: d.accessRevision,
    });
    steps++;
  }
  d.clearCached();
  output.push(d.readable());
  stop();
  s.dispose();
  dir.dispose();
}
// Exact entry/byte boundaries, Unicode UTF-8, duplicate replacement, timestamp
// ties, local precedence and frozen projection identity (unchanged owners).
const small = Array.from({ length: 2001 }, (_, i) =>
  event(i + 100000, 9, "c", Math.floor(i / 3), [["h", "c"]], "é🐝"),
);
for (const n of [0, 1, 1999, 2000, 2001]) {
  const retained = retainEvents(small.slice(0, n));
  assert.equal(retained.length, Math.min(n, 2000));
  output.push(retained.map((e) => e.id));
}
const base = event(900000, 9, "c", 50, [["h", "c"]], "");
const overhead = Buffer.byteLength(JSON.stringify(base));
const exact = freeze({
  ...base,
  content: "é".repeat(Math.floor((8 * 1024 * 1024 - overhead) / 2)),
});
const atLimit = retainEvents([exact]);
assert.equal(atLimit.length, 1);
const over = freeze({ ...exact, content: exact.content + "🐝" });
assert.equal(retainEvents([over]).length, 0);
output.push([
  Buffer.byteLength(JSON.stringify(exact)),
  Buffer.byteLength(JSON.stringify(over)),
]);
const replaced = freeze({ ...base, content: "replacement 🐝" });
assert.equal(retainEvents([base, replaced])[0], replaced);
const filters = [{ kinds: [9], limit: 10 }];
const local = [{ event: base, delivery: "sending" }];
const projected = projectEvents([replaced], local, filters);
assert.equal(projected[0].content, replaced.content);
assert.equal(projectEvents([replaced], local, filters, projected), projected);
output.push(projected);
console.log(
  JSON.stringify({
    steps,
    seeds: 4,
    receipt: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
    assertions: "passed",
  }),
);
