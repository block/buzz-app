import { afterEach, assert, expect, it, vi } from "vitest";
import { createOutbox, type OutboxStorage, type OutgoingEvent } from "./outbox";
import { keypair, signed } from "./testing";

const viewer = keypair();
const channel = "22222222-2222-4222-8222-222222222222";
const recovery = { key: "solo-task:draft", value: "submission" };
const create = { kind: 9007, content: "", tags: [["h", channel]] };
const first = {
  kind: 9,
  content: "A saved request 😀",
  tags: [["h", channel]],
};
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function journal(initial: readonly OutgoingEvent[] = []) {
  let rows: readonly OutgoingEvent[] = structuredClone(initial);
  let tail = Promise.resolve();
  const storage: OutboxStorage = {
    load: () => structuredClone(rows),
    save: (next, options) => {
      const skip = new Set(options?.skip);
      rows = structuredClone([
        ...next.filter((item) => !skip.has(item.event.id)),
        ...rows.filter((item) => skip.has(item.event.id)),
      ]);
    },
    lock: async (_key, run) => {
      const previous = tail;
      const release = gate();
      tail = previous.then(() => release.promise);
      await previous;
      try {
        return await run();
      } finally {
        release.resolve();
      }
    },
  };
  return { storage, rows: () => rows };
}
function owner(
  storage: OutboxStorage,
  options: Parameters<typeof createOutbox>[3] = {},
) {
  const sign = vi.fn(async (event) => signed(viewer, event));
  const publish = vi.fn(async () => {});
  const value = createOutbox(
    viewer.pubkey,
    { sign, publish },
    storage,
    options,
  );
  owners.push(value);
  return { ...value, sign, publish };
}

it("saves the entire pair before any signer, observer or publisher runs", async () => {
  const store = journal();
  const held = gate(),
    entered = gate();
  const save = vi.fn(async (rows) => {
    entered.resolve();
    await held.promise;
    store.storage.save(rows);
  });
  const h = owner({ ...store.storage, save });
  const observe = vi.fn();
  h.outbox.observeSend(observe);
  const claim = vi.fn();
  const submission = h.outbox.withChat(recovery.key, async () => {
    await h.outbox.stageChat(create, first, recovery);
    claim();
  });
  try {
    await entered.promise;
    expect(
      save.mock.calls[0]?.[0].map((row: OutgoingEvent) => row.event.kind),
    ).toEqual([9007, 9]);
    expect(claim).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    held.resolve();
    await submission;
    expect(claim).toHaveBeenCalledOnce();
    expect(store.rows()).toHaveLength(2);
    expect(
      store.rows().every((row) => row.guarded && row.delivery === "unknown"),
    ).toBe(true);
    const first = store.rows()[1];
    assert.exists(first);
    expect(() => h.outbox.retry(first.event.id)).toThrow("cancelled");
  } finally {
    held.resolve();
    await submission;
  }
});

it("refuses a failed pair write before claim and restores no partial submission", async () => {
  const store = journal();
  const h = owner({
    ...store.storage,
    save: () => {
      throw new Error("Disk full");
    },
  });
  const claim = vi.fn();
  await expect(
    h.outbox.withChat(recovery.key, async () => {
      await h.outbox.stageChat(create, first, recovery);
      claim();
    }),
  ).rejects.toThrow("Disk full");
  expect(claim).not.toHaveBeenCalled();
  expect(store.rows()).toEqual([]);
  expect(h.sign).not.toHaveBeenCalled();
});

it.each([
  "intent",
  "create-signed",
  "create-accepted",
  "first-signed",
  "bound",
  "first-accepted",
] as const)(
  "restores the same pair without automatic replay after %s",
  async (boundary) => {
    const store = journal();
    const entered = gate(),
      stopped = gate();
    const storage: OutboxStorage = {
      ...store.storage,
      save: async (rows) => {
        await store.storage.save(rows);
        const createRow = rows.find((row) => row.event.kind === 9007);
        const firstRow = rows.find((row) => row.event.kind === 9);
        const reached =
          boundary === "create-signed"
            ? !!createRow?.signed
            : boundary === "create-accepted"
              ? createRow?.delivery === "accepted"
              : boundary === "first-signed"
                ? !!firstRow?.signed
                : boundary === "first-accepted"
                  ? firstRow?.delivery === "accepted"
                  : false;
        if (reached) {
          entered.resolve();
          await stopped.promise;
        }
      },
    };
    const binding = vi.fn(async (event) => {
      if (boundary === "bound" && event.kind === 9) {
        entered.resolve();
        await stopped.promise;
      }
      return undefined;
    });
    const a = owner(storage, { afterSigned: binding });
    const run = a.outbox.withChat(recovery.key, async (owned) => {
      await a.outbox.stageChat(create, first, recovery);
      if (boundary === "intent") {
        entered.resolve();
        await stopped.promise;
        return;
      }
      for (const row of a.outbox.snapshot())
        await a.outbox.resume(row.event.id, owned);
    });
    const interrupted = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      const original = structuredClone(store.rows());
      a.dispose();
      stopped.resolve();
      const error = await interrupted;
      if (boundary !== "intent") expect(error).toBeInstanceOf(Error);
      const restored = owner(store.storage);
      await restored.outbox.ready();
      expect(restored.sign).not.toHaveBeenCalled();
      expect(restored.publish).not.toHaveBeenCalled();
      await restored.outbox.withChat(recovery.key, async (owned) => {
        for (const row of restored.outbox.snapshot())
          await restored.outbox.resume(row.event.id, owned);
      });
      expect(store.rows().map((row) => row.event)).toEqual(
        original.map((row) => row.event),
      );
      expect(restored.publish.mock.calls).toHaveLength(
        boundary === "first-accepted"
          ? 0
          : ["create-accepted", "first-signed", "bound"].includes(boundary)
            ? 1
            : 2,
      );
    } finally {
      stopped.resolve();
      await run.catch(() => {});
    }
  },
);

it("holds the submission lock through publication and refreshes a waiting stale owner", async () => {
  const store = journal();
  const a = owner(store.storage);
  await a.outbox.withChat(recovery.key, async () => {
    await a.outbox.stageChat(create, first, recovery);
  });
  const b = owner(store.storage);
  await b.outbox.ready();
  const entered = gate(),
    published = gate();
  a.publish.mockImplementation(async () => {
    entered.resolve();
    await published.promise;
  });
  const secondEntered = vi.fn();
  const run = a.outbox.withChat(recovery.key, async (owned) => {
    for (const row of a.outbox.snapshot())
      await a.outbox.resume(row.event.id, owned);
  });
  const queued = gate();
  const second = b.outbox.withChat(recovery.key, async (owned) => {
    secondEntered();
    for (const row of b.outbox.snapshot())
      await b.outbox.resume(row.event.id, owned);
  });
  try {
    await entered.promise;
    // A lock probe queued after b supplies an ordering barrier, without a sleep.
    assert.exists(store.storage.lock);
    const probe = store.storage.lock("probe", async () => {
      queued.resolve();
    });
    expect(secondEntered).not.toHaveBeenCalled();
    published.resolve();
    await Promise.all([run, second, probe]);
    expect(secondEntered).toHaveBeenCalledOnce();
    expect(b.outbox.snapshot().map((row) => row.event.id)).toEqual(
      a.outbox.snapshot().map((row) => row.event.id),
    );
    expect(b.publish).not.toHaveBeenCalled();
    expect(b.sign).not.toHaveBeenCalled();
  } finally {
    published.resolve();
    await Promise.all([run, second]);
  }
});

it("renews admission for saved rows and cannot use a released lock gate", async () => {
  const store = journal();
  const h = owner(store.storage);
  let captured = () => false;
  await h.outbox.withChat(recovery.key, async (owned) => {
    captured = owned;
    await h.outbox.stageChat(create, first, recovery);
    const message = h.outbox.snapshot()[1];
    assert.exists(message);
    await expect(
      h.outbox.resume(message.event.id, () => false),
    ).rejects.toThrow("cancelled");
  });
  expect(captured()).toBe(false);
  expect(h.publish).not.toHaveBeenCalled();
  const message = h.outbox.snapshot()[1];
  assert.exists(message);
  await expect(h.outbox.resume(message.event.id, captured)).rejects.toThrow(
    "cancelled",
  );
});

it("reserves room for both rows before claim and permits retry after capacity is free", async () => {
  const initial: OutgoingEvent[] = Array.from({ length: 255 }, (_, index) => ({
    event: signed(viewer, { ...first, content: `Pending ${index}` }),
    delivery: "failed",
  }));
  const store = journal(initial),
    h = owner(store.storage);
  const claim = vi.fn();
  await expect(
    h.outbox.withChat(recovery.key, async () => {
      await h.outbox.stageChat(create, first, recovery);
      claim();
    }),
  ).rejects.toThrow("Too many outstanding operations");
  expect(claim).not.toHaveBeenCalled();
  expect(store.rows()).toHaveLength(255);
  const removed = initial[0];
  assert.exists(removed);
  await h.outbox.dismiss(removed.event.id);
  await h.outbox.withChat(recovery.key, async () => {
    await h.outbox.stageChat(create, first, recovery);
    claim();
  });
  expect(claim).toHaveBeenCalledOnce();
  expect(store.rows()).toHaveLength(256);
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("keeps peer cleanup after a former owner receives a late verified echo", async () => {
  const store = journal(),
    a = owner(store.storage);
  a.publish.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  let ids: string[] = [];
  await expect(
    a.outbox.withChat(recovery.key, async (active) => {
      await a.outbox.stageChat(create, first, recovery);
      ids = a.outbox.snapshot().map((row) => row.event.id);
      const creation = ids[0];
      assert.exists(creation);
      await a.outbox.resume(creation, active);
    }),
  ).rejects.toThrow("Lost acknowledgement");
  const b = owner(store.storage);
  await b.outbox.withChat(recovery.key, async (active) => {
    for (const id of ids) await b.outbox.resume(id, active);
    for (const id of ids) await b.outbox.acknowledge(id);
  });
  const accepted = structuredClone(store.rows());
  expect(accepted.every((row) => !row.recovery)).toBe(true);
  const received = accepted.find((row) => row.event.kind === 9007)?.signed;
  assert.exists(received);
  a.observe([received]);
  const ordinary = a.outbox.send({
    ...first,
    content: "Another chat",
    tags: [["h", "other"]],
  });
  await a.outbox.resume(ordinary, () => true);
  expect(store.rows().filter((row) => ids.includes(row.event.id))).toEqual(
    accepted,
  );
});
