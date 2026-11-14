import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { expect, it } from "vitest";
import {
  decodeThreadFollows,
  signThreadFollows,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import type { RelayEvent } from "./events";
import { createThreadFollowSync } from "./follow-manager";
import { followCoordinate, type ReadStateHost } from "./read-state-host";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import type { RelayReader } from "./reader";
import { memoryThreadFollows } from "./thread-follows";

const secret = generateSecretKey();
const viewer = getPublicKey(secret);
const K = `room:${"1".repeat(64)}`;

/** A relay holding one replaceable head per coordinate, full order. */
function relay() {
  const heads = new Map<string, RelayEvent>();
  const published: RelayEvent[] = [];
  return {
    heads,
    published,
    put(event: RelayEvent) {
      const coordinate = followCoordinate(event) ?? "";
      const head = heads.get(coordinate);
      if (
        !head ||
        event.created_at > head.created_at ||
        (event.created_at === head.created_at && event.id < head.id)
      )
        heads.set(coordinate, event);
    },
  };
}
type Relay = ReturnType<typeof relay>;
/** Persists through JSON and `readJournal`, as IndexedDB does. */
function memoryStorage(initial?: ReadJournal) {
  let saved = initial && JSON.stringify(initial);
  let failing = false;
  const storage: ReadStateStorage = {
    async update(change) {
      if (failing) throw new Error("Storage unavailable");
      const current = saved
        ? readJournal(JSON.parse(saved), viewer)
        : undefined;
      const next = change(current ?? newReadJournal());
      saved = JSON.stringify(next);
      return readJournal(JSON.parse(saved), viewer);
    },
    async read() {
      return saved ? readJournal(JSON.parse(saved), viewer) : undefined;
    },
    async capture() {
      return this.read?.();
    },
    close() {},
  };
  return {
    storage,
    backup: () => readJournal(JSON.parse(saved ?? "null"), viewer),
    fail: (value: boolean) => {
      failing = value;
    },
  };
}
function setup(
  r: Relay,
  clock: { now: number },
  options: {
    storage?: ReadStateStorage;
    publish?: (event: RelayEvent) => Promise<void>;
    sign?: (event: RelayEvent) => Promise<void>;
    legacy?: ReturnType<typeof memoryThreadFollows>;
    beforeRead?: () => Promise<void>;
    capacity?: Parameters<typeof createThreadFollowSync>[0]["capacity"];
  } = {},
) {
  const storage = options.storage ?? memoryStorage().storage;
  const host: ReadStateHost = {
    decode: async () => [],
    async decodeFollows(events) {
      return decodeThreadFollows(events, secret);
    },
    async signFollows(intent) {
      const event = signThreadFollows(intent, secret, clock.now) as RelayEvent;
      await options.sign?.(event);
      return event;
    },
    async publishFollows(event) {
      if (options.publish) return options.publish(event);
      r.put(event);
      r.published.push(event);
    },
  };
  const reader = {
    read: async () => {
      await options.beforeRead?.();
      return [...r.heads.values()];
    },
  } as unknown as RelayReader;
  return createThreadFollowSync({
    viewer,
    reader,
    host,
    storage,
    lock: async (_signal, work) => work(),
    legacy: options.legacy ?? memoryThreadFollows(),
    now: () => clock.now,
    debounceMs: 60_000,
    ...(options.capacity ? { capacity: options.capacity } : {}),
  });
}
/** A fresh device reads the relay. */
async function fresh(r: Relay) {
  const reader = setup(r, { now: 1 });
  await reader.refresh();
  return reader.read().get(K);
}

it("a tap resolves only once saved, then a fresh reader sees it", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  expect(disk.backup().follows?.slots).toHaveLength(1);
  expect(sync.read().get(K)).toBe(true);
  await sync.flush();
  expect(sync.snapshot().status).toBe("synchronized");
  expect(await fresh(r)).toBe(true);
});

it("C1: a second tap while the first is being signed is never lost", async () => {
  const r = relay();
  const clock = { now: 1000 };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const sync = setup(r, clock, {
    sign: async () => {
      if (first) {
        first = false;
        await held;
      }
    },
  });
  await sync.refresh();
  await sync.set(K, true);
  const flushing = sync.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // set queues behind the flush, so accept it concurrently.
  const tapping = sync.set(K, false);
  release();
  await flushing;
  await tapping;
  await sync.flush();
  expect(sync.read().get(K)).toBe(false);
  expect(await fresh(r)).toBe(false);
});

it("C2: restoring a backup taken before the first send recognizes its own slot", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  const backup = disk.backup(); // before debounce/send
  await sync.flush();
  clock.now = 990; // backward clock
  await sync.set(K, false);
  await sync.flush();
  expect(await fresh(r)).toBe(false);
  sync.dispose();
  const restored = setup(r, clock, {
    storage: memoryStorage(backup).storage,
  });
  await restored.refresh();
  expect(restored.read().get(K)).toBe(false);
  await restored.flush();
  expect(r.heads.size).toBe(1);
  expect(await fresh(r)).toBe(false);
});

it("I1: an OK without echo acknowledges from the retained packet", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  // Publish stores the event but no echo is ever delivered.
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  const follows = disk.backup().follows;
  expect(follows?.state.packets).toEqual({});
  expect(follows?.state.edits).toEqual({});
});

it("an unknown send outcome retries the exact signed bytes", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const attempts: string[] = [];
  let fail = true;
  const sync = setup(r, clock, {
    storage: disk.storage,
    publish: async (event) => {
      attempts.push(JSON.stringify(event));
      if (fail) throw new Error("Relay delivery could not be confirmed");
      r.put(event);
    },
  });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  expect(sync.snapshot().status).toBe("failed");
  fail = false;
  clock.now = 1010;
  await sync.flush();
  expect(attempts[1]).toBe(attempts[0]);
  expect(await fresh(r)).toBe(true);
});

it("a failed save rejects the tap and leaves the choice unchanged", async () => {
  const r = relay();
  const disk = memoryStorage();
  const sync = setup(r, { now: 1000 }, { storage: disk.storage });
  await sync.refresh();
  disk.fail(true);
  await expect(sync.set(K, true)).rejects.toThrow("Storage unavailable");
  expect(sync.read().get(K)).toBeUndefined();
});

it("an unreadable own head refuses taps and holds retained packets", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  let fail = true;
  const sync = setup(r, clock, {
    storage: disk.storage,
    publish: async (event) => {
      if (fail) throw new Error("Relay delivery could not be confirmed");
      r.put(event);
    },
  });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  const [slot] = disk.backup().follows?.slots ?? [];
  // A newer own event this build can't read lands in our slot.
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  r.put(
    finalizeEvent(
      {
        kind: 30078,
        created_at: 1100,
        tags: [
          ["d", `thread-follows:${slot}`],
          ["t", "thread-follows"],
        ],
        content: nip44.v2.encrypt(JSON.stringify({ v: 2 }), key),
      },
      secret,
    ) as RelayEvent,
  );
  await sync.refresh();
  fail = false;
  await sync.flush();
  expect(sync.snapshot()).toMatchObject({ status: "failed", complete: false });
  expect(Object.keys(disk.backup().follows?.state.packets ?? {})).toHaveLength(
    1,
  );
  await expect(sync.set(K, false)).rejects.toThrow("unreadable");
});

it("legacy choices import once at at=0, only where nothing is synced", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const other = `room:${"2".repeat(64)}`;
  const peer = setup(r, clock);
  await peer.refresh();
  await peer.set(K, false);
  await peer.flush();
  const legacy = memoryThreadFollows();
  legacy.write(
    new Map([
      [K, true],
      [other, true],
    ]),
  );
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage, legacy });
  await sync.refresh();
  expect(sync.read().get(K)).toBe(false);
  expect(sync.read().get(other)).toBe(true);
  const follows = disk.backup().follows;
  expect(follows?.imported).toBe(true);
  expect(follows?.state.edits[other]).toMatchObject({
    origin: "legacy-import",
    entry: { follow: true, at: 0 },
  });
  expect(follows?.state.edits[K]).toBeUndefined();
  await sync.refresh();
  expect(Object.keys(disk.backup().follows?.state.edits ?? {})).toEqual([
    other,
  ]);
});

it("a reservation pushed past the host window fails the send visibly, never clamped", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const sync = setup(r, clock, { storage: disk.storage });
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  // Another device with a fast clock publishes into a peer slot; our own
  // head is then pushed ahead by a restore from that device.
  clock.now = 1300;
  await sync.set(K, false);
  clock.now = 1000;
  const published = r.heads.size;
  await sync.flush();
  expect(sync.snapshot().status).toBe("failed");
  expect(sync.snapshot().error).toMatch("ahead of this device's clock");
  expect(r.heads.size).toBe(published);
  expect(Object.keys(disk.backup().follows?.state.edits ?? {})).toEqual([K]);
});

it("spills new keys to another slot when one is full, without omission", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const disk = memoryStorage();
  const keys = Array.from(
    { length: 500 },
    (_, i) => `room:${i.toString(16).padStart(64, "0")}`,
  );
  // A large legacy import shares one reservation, so it stays signable.
  const legacy = memoryThreadFollows();
  legacy.write(new Map(keys.map((key) => [key, true])));
  const sync = setup(r, clock, { storage: disk.storage, legacy });
  await sync.refresh();
  // A tap while the import is unsent joins its slot's successor.
  await sync.set(keys[0] as string, false);
  await sync.flush();
  await sync.flush();
  expect(disk.backup().follows?.slots.length).toBeGreaterThan(1);
  const reader = setup(r, { now: 1 });
  await reader.refresh();
  expect(reader.read().get(keys[0] as string)).toBe(false);
  for (const key of keys.slice(1)) expect(reader.read().get(key)).toBe(true);
});

it("counts follow events toward the shared snapshot limit before sending", async () => {
  const r = relay();
  const disk = memoryStorage();
  const admitted: string[] = [];
  let refreshed = 0;
  const sync = setup(
    r,
    { now: 1000 },
    {
      storage: disk.storage,
      capacity: {
        admit(events) {
          admitted.push(...events.map((event) => event.id));
          throw new Error(
            "Read-state snapshot capacity reached; saved intent retained",
          );
        },
        observeSize() {},
        async refresh() {
          refreshed++;
        },
      },
    },
  );
  await sync.refresh();
  await sync.set(K, true);
  await sync.flush();
  expect(sync.snapshot()).toMatchObject({
    status: "failed",
    error: "Read-state snapshot capacity reached; saved intent retained",
  });
  expect(admitted).toHaveLength(2);
  expect(refreshed).toBe(1);
  expect(r.heads.size).toBe(0);
  // The choice and its exact packet are kept for retry.
  expect(Object.keys(disk.backup().follows?.state.packets ?? {})).toHaveLength(
    1,
  );
  expect(sync.read().get(K)).toBe(true);
});

it("a second window's import never overwrites a choice saved since it read the relay", async () => {
  const r = relay();
  const clock = { now: 1000 };
  const legacy = memoryThreadFollows();
  legacy.write(new Map([[K, true]]));
  const disk = memoryStorage();
  // Window B reads the relay first, then A imports and the user unfollows.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = setup(r, clock, {
    storage: disk.storage,
    legacy,
    beforeRead: () => held,
  });
  const reading = b.refresh();
  const a = setup(r, clock, { storage: disk.storage, legacy });
  await a.refresh();
  await a.set(K, false);
  release();
  await reading;
  const edit = disk.backup().follows?.state.edits[K];
  expect(edit).toMatchObject({ origin: "explicit", entry: { follow: false } });
});

it("a refused import reservation saves nothing, and the retry imports once", async () => {
  const r = relay();
  const legacy = memoryThreadFollows();
  legacy.write(new Map([[K, true]]));
  const disk = memoryStorage();
  const clock = { now: 4_294_967_295 + 1 }; // past uint32: reservation refused
  const sync = setup(r, clock, { storage: disk.storage, legacy });
  await sync.refresh();
  expect(sync.snapshot().status).toBe("failed");
  expect(disk.backup().follows?.imported).toBeUndefined();
  expect(disk.backup().follows?.state.edits ?? {}).toEqual({});
  expect(legacy.read().get(K)).toBe(true);
  clock.now = 1000;
  await sync.refresh();
  expect(disk.backup().follows?.imported).toBe(true);
  expect(disk.backup().follows?.state.edits[K]).toMatchObject({
    origin: "legacy-import",
  });
});
