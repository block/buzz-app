import { afterEach, assert, expect, it, vi } from "vitest";
import {
  createOutbox,
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "./outbox";
import type { RelayWriter } from "./transport";
import { keypair, signed } from "./testing";
const viewer = keypair();
const input = { kind: 9, content: "First message", tags: [["h", "dm"]] };
const recovery = { key: "new-dm", value: '{"draft":"First message"}' };
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(
  storage: OutboxStorage,
  publish = vi.fn<RelayWriter["publish"]>(async () => {}),
) {
  const sign = vi.fn(async (event) => signed(viewer, event));
  const owner = createOutbox(viewer.pubkey, { sign, publish }, storage);
  owners.push(owner);
  return { ...owner, sign, publish };
}
function memory() {
  let records: readonly OutgoingEvent[] = [];
  return {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
}

it("stores recovery with intent before publication and blocks publication on storage failure", async () => {
  const store = memory();
  let release: () => void = () => {};
  const save = vi.fn(async (records: readonly OutgoingEvent[]) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    store.save(records);
  });
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0][0]).toMatchObject({ event: { id }, recovery });
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  save.mockImplementation(async (records) => store.save(records));
  release();
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const failed = setup({
    load: () => [],
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await failed.outbox.ready();
  failed.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(failed.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(failed.publish).not.toHaveBeenCalled();
});

it("waits for hydration, prevents duplicate recovery keys, and retries the exact restored event", async () => {
  const store = memory();
  const first = setup(
    store,
    vi.fn(async () => {
      throw new Error("Receipt lost");
    }),
  );
  await first.outbox.ready();
  const id = first.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(first.outbox.snapshot()[0]?.delivery).toBe("unknown"),
  );
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("unknown"));
  first.dispose();
  let hydrate: (items: readonly OutgoingEvent[]) => void = () => {};
  const second = setup({
    ...store,
    load: () =>
      new Promise((resolve) => {
        hydrate = resolve;
      }),
  });
  expect(() => second.outbox.send(input, recovery)).toThrow(
    "Recover the earlier",
  );
  hydrate(store.load());
  await second.outbox.ready();
  expect(() => second.outbox.send(input, recovery)).toThrow(
    "Recover the earlier",
  );
  await expect(second.outbox.dismiss(id)).rejects.toThrow(
    "Confirm this message",
  );
  second.outbox.retry(id);
  await vi.waitFor(() => expect(second.publish).toHaveBeenCalledOnce());
  expect(second.publish.mock.calls[0]).toEqual([
    first.publish.mock.calls[0]?.[0],
    expect.any(AbortSignal),
  ]);
  expect(second.sign).not.toHaveBeenCalled();
});

it("allows removing a definitive failure but preserves confirmed recovery until acknowledgement", async () => {
  const store = memory();
  const h = setup(
    store,
    vi.fn(async () => {
      throw new PublishRejected("Not sent");
    }),
  );
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  await h.outbox.dismiss(id);
  expect(store.load()).toEqual([]);
  h.publish.mockResolvedValue(undefined);
  const next = h.outbox.send(input, recovery);
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  await expect(h.outbox.dismiss(next)).rejects.toThrow("Confirm this message");
  const operation = h.outbox.snapshot()[0];
  assert.exists(operation);
  h.observe([signed(viewer, operation.event)]);
  expect(h.outbox.snapshot()[0]).toMatchObject({ delivery: "seen", recovery });
  await h.outbox.acknowledge(next);
  expect(h.outbox.snapshot()).toEqual([]);
  expect(store.load()[0]?.recovery).toBeUndefined();
});

it("keeps the latest delivery evidence and recovery key if acknowledgement persistence fails", async () => {
  const store = memory();
  const save = vi.fn(async (records: readonly OutgoingEvent[]) =>
    store.save(records),
  );
  const h = setup({ ...store, save });
  await h.outbox.ready();
  const id = h.outbox.send(input, recovery);
  await vi.waitFor(() => expect(store.load()[0]?.delivery).toBe("accepted"));
  let reject: (error: Error) => void = () => {};
  save.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const completed = h.outbox.acknowledge(id);
  const failed = expect(completed).rejects.toThrow("Disk full");
  await vi.waitFor(() =>
    expect(save.mock.calls.at(-1)?.[0][0]?.recovery).toBeUndefined(),
  );
  const operation = h.outbox.snapshot()[0];
  assert.exists(operation);
  h.observe([signed(viewer, operation.event)]);
  expect(() => h.outbox.send(input, recovery)).toThrow("Recover the earlier");
  reject(new Error("Disk full"));
  await failed;
  expect(h.outbox.snapshot()[0]).toMatchObject({ delivery: "seen", recovery });
  await h.outbox.acknowledge(id);
  expect(store.load()[0]?.recovery).toBeUndefined();
  expect(() => h.outbox.send(input, recovery)).not.toThrow();
});
