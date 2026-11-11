import { afterEach, expect, it, vi } from "vitest";
import { createChannelWrites } from "./channel-writes";
import { createOutbox, type OutgoingEvent } from "./outbox";
import { createRelaySession } from "./session";
import { eventDto, type RelayEvent } from "./events";
import { keypair, metadata, signed } from "./testing";

const id = "11111111-1111-4111-8111-111111111111";
const fork = {
  channelId: "22222222-2222-4222-8222-222222222222",
  messageId: "ab".repeat(32),
};
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});
function setup() {
  const viewer = keypair();
  const relay = keypair();
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const shell = createRelaySession(null);
  dispose.push(shell.dispose);
  const confirmed = eventDto(
    metadata(relay, id, "Fork", undefined, [
      ["forked_from", fork.channelId, fork.messageId],
    ]),
  );
  const read = vi.fn(async () => [confirmed]);
  const open = (publish = vi.fn(async (_event: RelayEvent) => {})) => {
    const sign = vi.fn(async (input: Parameters<typeof signed>[1]) =>
      signed(viewer, input),
    );
    const owner = createOutbox(viewer.pubkey, { sign, publish }, storage);
    const controller = new AbortController();
    const close = () => {
      controller.abort();
      owner.dispose();
    };
    dispose.push(close);
    const writes = createChannelWrites(
      owner.outbox,
      shell.session.channels,
      { read },
      controller.signal,
      undefined,
      undefined,
      undefined,
      relay.pubkey,
      { read },
      true,
    );
    return { ...owner, writes, sign, publish, close };
  };
  return { open, storage, read, confirmed, relay };
}

it.each(["accepted", "seen", "unknown"] as const)(
  "retains an exact signed %s create across restart and explicitly replays it until matching metadata",
  async (delivery) => {
    const h = setup();
    const first = h.open(
      vi.fn(async (_event: RelayEvent) => {
        // Publication cannot precede durable signing, including its recovery key.
        expect(h.storage.load()[0]).toMatchObject({
          signed: _event,
          recovery: { key: `solo-fork:${id}` },
        });
        if (delivery === "unknown") throw new Error("Receipt lost");
      }),
    );
    await first.outbox.ready();
    const operation = first.writes.create(
      id,
      "Fork",
      undefined,
      false,
      [],
      undefined,
      [],
      fork,
    );
    await vi.waitFor(() =>
      expect(h.storage.load()[0]?.delivery).toBe(
        delivery === "seen" ? "accepted" : delivery,
      ),
    );
    const original = first.publish.mock.calls[0]?.[0];
    expect(original).toBeDefined();
    if (delivery === "seen" && original) {
      first.observe([eventDto(original)]);
      await vi.waitFor(() =>
        expect(h.storage.load()[0]?.delivery).toBe("seen"),
      );
    }
    first.close();
    h.read.mockResolvedValue([]);
    const second = h.open();
    await second.outbox.ready();
    await expect(second.writes.resumeFork(id)).rejects.toThrow(
      "signed metadata",
    );
    expect(second.publish).not.toHaveBeenCalled();
    expect(h.storage.load()[0]?.recovery).toBeDefined();
    await expect(second.writes.resumeFork(id, true)).rejects.toThrow(
      "signed metadata",
    );
    expect(second.publish).toHaveBeenCalledExactlyOnceWith(
      original,
      expect.any(AbortSignal),
    );
    expect(second.sign).not.toHaveBeenCalled();
    expect(h.storage.load()[0]).toMatchObject({
      event: { id: operation },
      signed: original,
      recovery: { key: `solo-fork:${id}` },
    });
    // A restart after the repair but before readback must still recover the same event.
    second.close();
    const third = h.open();
    await third.outbox.ready();
    h.read.mockResolvedValue([h.confirmed]);
    await third.writes.resumeFork(id, true);
    expect(third.sign).not.toHaveBeenCalled();
    expect(third.publish).toHaveBeenCalledExactlyOnceWith(
      original,
      expect.any(AbortSignal),
    );
    expect(h.storage.load()[0]?.recovery).toBeUndefined();
    expect(h.storage.load()[0]?.acknowledged).toBe(true);
    await third.writes.resumeFork(id, true);
    expect(third.publish).toHaveBeenCalledOnce();
  },
);

it("does not retire recovery on mismatched signed ancestry or a cancelled retry", async () => {
  const h = setup();
  const first = h.open();
  await first.outbox.ready();
  first.writes.create(id, "Fork", undefined, false, [], undefined, [], fork);
  await vi.waitFor(() =>
    expect(h.storage.load()[0]?.delivery).toBe("accepted"),
  );
  first.close();
  const second = h.open();
  await second.outbox.ready();
  await expect(second.writes.resumeFork(id, true, () => false)).rejects.toThrow(
    "cancelled",
  );
  expect(second.publish).not.toHaveBeenCalled();
  h.read.mockResolvedValue([
    eventDto(
      metadata(h.relay, id, "Wrong", undefined, [
        ["forked_from", fork.channelId, "cd".repeat(32)],
      ]),
    ),
  ]);
  await expect(second.writes.resumeFork(id, true)).rejects.toThrow(
    "signed source",
  );
  expect(h.storage.load()[0]?.recovery).toBeDefined();
});

it("keeps two children of the same parent under distinct destination recovery keys", async () => {
  const h = setup();
  const owner = h.open();
  await owner.outbox.ready();
  const other = "33333333-3333-4333-8333-333333333333";
  const first = owner.writes.create(
    id,
    "First",
    undefined,
    false,
    [],
    undefined,
    [],
    fork,
  );
  const second = owner.writes.create(
    other,
    "Second",
    undefined,
    false,
    [],
    undefined,
    [],
    fork,
  );
  await vi.waitFor(() =>
    expect(
      h.storage.load().filter((item) => item.delivery === "accepted"),
    ).toHaveLength(2),
  );
  expect(await owner.outbox.recovery(`solo-fork:${id}`)).toMatchObject({
    event: { id: first },
  });
  expect(await owner.outbox.recovery(`solo-fork:${other}`)).toMatchObject({
    event: { id: second },
  });
  h.read.mockResolvedValue([]);
  await expect(owner.writes.resumeFork(other, true)).rejects.toThrow(
    "signed metadata",
  );
  expect(owner.publish.mock.calls.map(([event]) => event.id)).toEqual([
    first,
    second,
    second,
  ]);
});
