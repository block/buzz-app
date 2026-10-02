import { afterEach, expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { createAgentActivity } from "./activity";
import {
  HISTORY_BYTE_LIMIT,
  browserActivityHistory,
  retainedActivity,
  type ActivityHistory,
  type SavedActivity,
} from "./activity-history";
import { ACTIVITY_HISTORY_AGE_MS, type ObserverFrame } from "./observer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const owner = generateSecretKey();
const viewer = getPublicKey(owner);
const agentKey = generateSecretKey();
const agent = getPublicKey(agentKey);
function captured(
  index = 0,
  channelId: string | null = "alpha",
  payload: unknown = index,
) {
  const plaintext = JSON.stringify({
    kind: "turn_liveness",
    turnId: String(index),
    timestamp: new Date().toISOString(),
    channelId,
    payload,
  });
  const event = finalizeEvent(
    {
      kind: 24200,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", viewer],
        ["agent", agent],
        ["frame", "telemetry"],
      ],
      content: nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(agentKey, viewer),
      ),
    },
    agentKey,
  );
  return {
    row: { event, receivedAt: Date.now() },
    frame: {
      id: event.id,
      agent,
      createdAt: event.created_at,
      plaintext,
      envelope: event,
    },
  };
}
function harness(initial: ReturnType<typeof captured>[] = []) {
  vi.useFakeTimers();
  let saved = initial.map((item) => item.row);
  const storage: ActivityHistory = {
    load: vi.fn(async () => saved),
    append: vi.fn(async (row) => {
      saved.push(row);
    }),
    clear: vi.fn(async () => {
      saved = [];
    }),
    close: vi.fn(),
  };
  let allowed = true;
  let known = true;
  const decode = vi.fn(
    async (
      events: readonly SavedActivity["event"][],
    ): Promise<ObserverFrame[]> =>
      events
        .map(
          (event) =>
            initial.find((item) => item.row.event.id === event.id)?.frame,
        )
        .filter((frame) => frame !== undefined),
  );
  const observe = vi.fn();
  const activity = createAgentActivity(
    true,
    observe,
    () => allowed,
    undefined,
    { storage, decode, canRestore: () => allowed && known },
  );
  const release = activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  return {
    activity,
    storage,
    decode,
    release,
    saved: () => saved,
    generation: () => observe.mock.lastCall?.[0] as number,
    deny: () => {
      allowed = false;
      activity.accessChanged();
    },
    unknown: () => {
      known = false;
    },
    allow: () => {
      allowed = true;
      known = true;
      activity.accessChanged();
    },
    known: () => {
      known = true;
      activity.restoreHistory();
    },
  };
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains only owner-encrypted, verified wire envelopes; bounds count, bytes and age", () => {
  const item = captured();
  const raw = {
    ...item.row,
    plaintext: "never save me",
    event: { ...item.row.event, plaintext: "never save me" },
  };
  expect(JSON.stringify(retainedActivity([raw], viewer))).not.toContain(
    "never save me",
  );
  expect(retainedActivity([raw], "b".repeat(64))).toEqual([]);
  expect(
    retainedActivity(
      [{ ...raw, event: { ...raw.event, content: "tampered" } }],
      viewer,
    ),
  ).toEqual([]);
  expect(
    retainedActivity(
      [raw],
      viewer,
      item.row.receivedAt + ACTIVITY_HISTORY_AGE_MS,
    ),
  ).toEqual([]);
  const records = Array.from(
    { length: 210 },
    (_, index) => captured(index).row,
  );
  expect(retainedActivity(records, viewer)).toHaveLength(200);
  const large = Array.from(
    { length: 40 },
    (_, index) => captured(index, "alpha", "é".repeat(30000)).row,
  );
  const retained = retainedActivity(large, viewer);
  expect(retained.length).toBeLessThan(40);
  expect(
    new TextEncoder().encode(JSON.stringify(retained)).length,
  ).toBeLessThanOrEqual(HISTORY_BYTE_LIMIT);
});

it("restores display only, deduplicates live capture, and never learns typing ownership from disk", async () => {
  const item = captured();
  const f = harness([item]);
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  expect(f.activity.queries.snapshot().turns).toEqual([]);
  f.activity.channelEvents([
    {
      id: "b".repeat(64),
      kind: 20002,
      pubkey: agent,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "alpha"]],
      content: "",
    },
  ]);
  expect(f.activity.queries.snapshot().typing).toEqual([]);
  const live = captured(1);
  f.activity.receive(live.frame, f.generation());
  f.activity.receive(live.frame, f.generation());
  expect(f.storage.append).toHaveBeenCalledTimes(1);
  expect(f.activity.queries.snapshot().turns[0]?.state).toBe("working");
  f.release();
  expect(f.storage.clear).not.toHaveBeenCalled();
  expect(f.activity.queries.snapshot().records).toEqual([]);
  f.activity.dispose();
});

it.each(["clear", "disable", "dispose", "revoke"])(
  "fences a late historical decode after %s",
  async (action) => {
    const item = captured();
    const f = harness([item]);
    const decode = deferred<ObserverFrame[]>();
    f.decode.mockImplementationOnce(
      () => decode.promise as Promise<ObserverFrame[]>,
    );
    await settle();
    expect(f.decode).toHaveBeenCalledOnce();
    if (action === "clear") await f.activity.queries.clearHistory();
    if (action === "disable") f.release();
    if (action === "dispose") f.activity.dispose();
    if (action === "revoke") f.deny();
    decode.resolve([item.frame]);
    await settle();
    expect(f.activity.queries.snapshot().records).toEqual([]);
    if (action === "revoke") expect(f.saved()).toHaveLength(1);
    f.activity.dispose();
  },
);

it("keeps permitted history through initial access settlement, hides denied records without deleting potentially recoverable history, and retries a mid-load roster grant", async () => {
  const item = captured();
  const f = harness([item]);
  const decode = deferred<ObserverFrame[]>();
  f.decode.mockImplementationOnce(() => decode.promise);
  f.unknown();
  await settle();
  f.known();
  decode.resolve([item.frame]);
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  f.activity.accessChanged();
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  expect(f.storage.clear).not.toHaveBeenCalled();
  expect(f.activity.queries.snapshot().turns).toEqual([]);
  f.deny();
  await settle();
  expect(f.saved()).toHaveLength(1);
  expect(f.activity.queries.snapshot().records).toEqual([]);
  f.allow();
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  f.activity.dispose();
});

it("reports storage failures without losing the live feed and fences pre-clear observer generations", async () => {
  const f = harness();
  await settle();
  vi.mocked(f.storage.append).mockRejectedValueOnce(new Error("disk full"));
  const old = f.generation();
  f.activity.receive(captured().frame, old);
  await settle();
  expect(f.activity.queries.snapshot().history).toBe("error");
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  vi.mocked(f.storage.clear).mockRejectedValueOnce(new Error("denied"));
  await expect(f.activity.queries.clearHistory()).rejects.toThrow(
    "Could not clear",
  );
  f.activity.receive(captured(1).frame, old);
  expect(f.activity.queries.snapshot().records).toEqual([]);
  expect(f.activity.queries.snapshot().history).toBe("error");
  f.activity.dispose();
});

// Model only IndexedDB requests/atomic commit. Production storage owns the queue,
// cloning, partitioning, retention and revision checks under test.
function indexedStorage() {
  const partitions = new Map<string, unknown>();
  const writes = vi.fn();
  const close = vi.fn();
  const database = {
    close,
    transaction() {
      let pending: [string, unknown] | undefined;
      const tx = {
        error: null,
        oncomplete: () => {},
        onabort: () => {},
        onerror: () => {},
        abort: () => queueMicrotask(() => tx.onabort()),
        objectStore: () => ({
          get(key: string) {
            const request = {
              result: structuredClone(partitions.get(key)),
              onsuccess: () => {},
            };
            queueMicrotask(() => request.onsuccess());
            return request;
          },
          put(value: unknown, key: string) {
            pending = [key, structuredClone(value)];
            queueMicrotask(() => {
              if (!pending) return;
              partitions.set(...pending);
              writes();
              tx.oncomplete();
            });
          },
        }),
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request = { result: database, onsuccess: () => {} };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  return { writes, close };
}

it("coalesces a burst without crossing read/clear barriers and drains admitted ciphertext on close", async () => {
  const db = indexedStorage();
  const storage = browserActivityHistory("community", viewer);
  await storage.load();
  db.writes.mockClear();
  const rows = [captured(1).row, captured(2).row, captured(3).row];
  await Promise.all(rows.map((row) => storage.append(row)));
  expect(db.writes).toHaveBeenCalledOnce();
  expect(await storage.load()).toHaveLength(3);
  const before = storage.append(captured(4).row);
  const clear = storage.clear();
  const afterRow = captured(5).row;
  const after = storage.append(afterRow);
  await Promise.all([before, clear, after]);
  expect((await storage.load()).map((row) => row.event.id)).toEqual([
    afterRow.event.id,
  ]);
  const last = captured(6).row;
  const drain = storage.append(last);
  storage.close();
  await drain;
  await expect(storage.append(last)).rejects.toThrow("closed");
  const reopened = browserActivityHistory("community", viewer);
  expect((await reopened.load()).map((row) => row.event.id)).toContain(
    last.event.id,
  );
  reopened.close();
});

it("keeps partitions isolated and rejects a stale window after durable clear until it reloads", async () => {
  indexedStorage();
  const a = browserActivityHistory("community", viewer);
  const b = browserActivityHistory("community", viewer);
  const other = browserActivityHistory("elsewhere", viewer);
  const account = browserActivityHistory("community", "a".repeat(64));
  await Promise.all([a.load(), b.load()]);
  const row = captured().row;
  await a.append(row);
  expect(await b.load()).toHaveLength(1);
  expect(await other.load()).toEqual([]);
  expect(await account.load()).toEqual([]);
  await b.clear();
  await expect(a.append(row)).rejects.toThrow("changed or unavailable");
  expect(await a.load()).toEqual([]);
  await a.append(row);
  expect(await b.load()).toHaveLength(1);
  for (const storage of [a, b, other, account]) storage.close();
});

it("preserves arrival order for chunks captured in the same millisecond, on disk and in the feed", async () => {
  const f = harness();
  await settle();
  // Descending IDs expose accidental hash-based tie-breaking instead of arrival order.
  const items = [captured(10), captured(11)].sort((a, b) =>
    b.frame.id.localeCompare(a.frame.id),
  );
  const ids = items.map((item) => item.frame.id);
  expect(
    retainedActivity(
      items.map((item) => item.row),
      viewer,
    ).map((row) => row.event.id),
  ).toEqual(ids);
  for (const item of items) f.activity.receive(item.frame, f.generation());
  expect(f.activity.queries.snapshot().records.map((row) => row.id)).toEqual(
    ids,
  );
  f.activity.dispose();
});
