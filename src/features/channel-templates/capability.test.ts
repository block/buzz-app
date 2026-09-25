import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { createChannelKit } from "./capability";
import { coordinate, KIT_TAG, type KitRecord } from "./model";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import type { RelayWriter } from "../relay/transport";
import type { RelayReader } from "../relay/reader";

const viewer = keypair();
const community = "https://relay.example.test";
const channel = "11111111-1111-4111-8111-111111111111";
const record: KitRecord = {
  version: 1,
  community,
  deleted: false,
  value: { type: "team", id: "team", name: "Team", agents: [] },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  const events: RelayEvent[] = [];
  const pending: OutgoingEvent[] = [];
  const controller = new AbortController();
  let time = 1_700_000_000;
  const outbox: Outbox = {
    snapshot: () => pending,
    subscribe: () => () => {},
    observeSend: () => () => {},
    ready: async () => {},
    recover: async () => {},
    acknowledge: async () => {},
    supports: () => true,
    send: vi.fn((value) => {
      const event = signed(viewer, { ...value, created_at: time++ });
      events.push(event);
      return event.id;
    }),
    dismiss: vi.fn(async () => {}),
    retry: vi.fn(),
  };
  const reader: RelayReader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) =>
      events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
    ),
  };
  const delivered = vi.fn(async () => {});
  const canWrite = vi.fn(() => true);
  const host = {
    prepare: vi.fn(async (value: KitRecord, _signal: AbortSignal) =>
      JSON.stringify(value),
    ),
    decode: vi.fn(async (rows: readonly RelayEvent[]) =>
      rows.map((event) => ({
        eventId: event.id,
        record: JSON.parse(event.content),
      })),
    ),
  };
  const kit = createChannelKit({
    host,
    reader,
    outbox,
    local: outbox,
    ready: Promise.resolve(),
    viewer: viewer.pubkey,
    community,
    signal: controller.signal,
    canWrite,
    delivered,
  });
  return {
    ...kit,
    events,
    pending,
    outbox,
    controller,
    reader,
    host,
    delivered,
    canWrite,
  };
}
it("saves scoped private recipe intent, confirms the exact event, and rejects stale replacements", async () => {
  const f = fixture();
  const id = await f.capability.save(record.value, undefined);
  expect(f.events[0]?.tags).toEqual([
    ["d", coordinate(record)],
    ["t", KIT_TAG],
  ]);
  expect(f.host.prepare).toHaveBeenCalledWith(record, f.controller.signal);
  expect(f.capability.snapshot().entries[0]?.eventId).toBe(id);
  await expect(f.capability.save(record.value, undefined)).rejects.toThrow(
    /changed/,
  );
  expect(f.outbox.send).toHaveBeenCalledTimes(1);
});
it.each(["head read", "encryption"] as const)(
  "cancels recipe preparation during %s without enqueueing a durable write",
  async (stage) => {
    const f = fixture();
    const operation = new AbortController();
    let reached!: (signal: AbortSignal | undefined) => void;
    const entered = new Promise<AbortSignal | undefined>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (stage === "head read")
      vi.mocked(f.reader.read).mockImplementationOnce(
        async (_filters, options) => {
          reached(options?.signal);
          await gate; // Deliberately ignore abort to probe the post-await fence.
          return [];
        },
      );
    else
      f.host.prepare.mockImplementationOnce(async (value, signal) => {
        reached(signal);
        await gate;
        return JSON.stringify(value);
      });
    const saving = f.capability.save(
      record.value,
      undefined,
      false,
      operation.signal,
    );
    const rejected = expect(saving).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      const signal = await entered;
      operation.abort();
      expect(signal?.aborted).toBe(true);
      release();
      await rejected;
      expect(f.outbox.send).not.toHaveBeenCalled();
      if (stage === "head read") expect(f.host.prepare).not.toHaveBeenCalled();
      // A cancelled preparation must release the existing save guard.
      await f.capability.save(record.value, undefined);
      expect(f.outbox.send).toHaveBeenCalledOnce();
    } finally {
      release();
      f.controller.abort();
    }
  },
);
it("caller cancellation after enqueue does not retract or interrupt durable delivery", async () => {
  const f = fixture();
  const operation = new AbortController();
  const send = f.outbox.send;
  f.outbox.send = vi.fn((intent) => {
    const id = send(intent);
    operation.abort();
    return id;
  });
  try {
    const id = await f.capability.save(
      record.value,
      undefined,
      false,
      operation.signal,
    );
    expect(operation.signal.aborted).toBe(true);
    expect(f.capability.snapshot().entries[0]?.eventId).toBe(id);
    expect(f.outbox.dismiss).not.toHaveBeenCalled();
  } finally {
    f.controller.abort();
  }
});
it("keeps drafts safe from stale Canvas, unresolved writes and access loss", async () => {
  const f = fixture();
  const head = signed(viewer, {
    kind: 40100,
    tags: [["h", channel]],
    content: "Old",
  });
  f.events.push(head);
  await expect(f.canvas.save(channel, "New", undefined)).rejects.toThrow(
    /changed/,
  );
  f.pending.push({ event: head, delivery: "unknown" });
  await expect(f.canvas.save(channel, "New", head.id)).rejects.toThrow(
    /unresolved/,
  );
  f.pending.length = 0;
  f.canWrite.mockReturnValue(false);
  await expect(f.canvas.save(channel, "New", head.id)).rejects.toThrow(
    /unavailable/,
  );
  expect(f.outbox.send).not.toHaveBeenCalled();
  f.canWrite.mockReturnValue(true);
  f.events.length = 0;
  const saved = await f.canvas.save(channel, "New", undefined);
  expect(saved.content).toBe("New");
  expect(f.outbox.send).toHaveBeenCalledWith({
    kind: 40100,
    tags: [["h", channel]],
    content: "New",
  });
});
it("never re-signs an expired uncertain operation and clears candidates on retirement", async () => {
  const f = fixture();
  const old = signed(viewer, {
    kind: 40100,
    tags: [["h", channel]],
    content: "Old",
  });
  f.pending.push({ event: old, delivery: "unknown" });
  await expect(f.confirm(old.id)).rejects.toThrow(/too old/);
  expect(f.delivered).not.toHaveBeenCalled();
  expect(f.outbox.send).not.toHaveBeenCalled();
  await f.capability.save(record.value, undefined);
  f.controller.abort();
  expect(f.capability.snapshot()).toEqual({
    status: "unavailable",
    entries: [],
  });
  await expect(f.capability.save(record.value, undefined)).rejects.toThrow();
});
it("fails visibly rather than exposing a partial or mismatched catalog", async () => {
  const f = fixture();
  const event = signed(viewer, {
    kind: 30078,
    content: JSON.stringify(record),
    tags: [
      ["d", coordinate(record)],
      ["t", KIT_TAG],
    ],
  });
  f.events.push(...Array(500).fill(event));
  await f.capability.refresh();
  expect(f.capability.snapshot().error).toMatch(/read limit/);
  expect(f.host.decode).not.toHaveBeenCalled();
  f.events.splice(1);
  f.host.decode.mockResolvedValue([]);
  await f.capability.refresh();
  expect(f.capability.snapshot().error).toMatch(/Incomplete/);
  expect(f.capability.snapshot().entries).toEqual([]);
});

it.each(["recipe", "Canvas"])(
  "waits for the session outbox to hydrate before admitting a replacement %s save",
  async (kind) => {
    const relay = keypair();
    const prior = signed(
      viewer,
      kind === "recipe"
        ? {
            kind: 30078,
            content: "encrypted prior recipe",
            tags: [
              ["d", coordinate(record)],
              ["t", KIT_TAG],
            ],
          }
        : { kind: 40100, content: "Prior Canvas", tags: [["h", channel]] },
    );
    let hydrate: (rows: readonly OutgoingEvent[]) => void = () => {};
    const hydration = new Promise<readonly OutgoingEvent[]>((resolve) => {
      hydrate = resolve;
    });
    const events = [
      metadata(relay, channel, "Channel"),
      roster(relay, channel, [viewer.pubkey]),
    ];
    const sign = vi.fn<RelayWriter["sign"]>(async (template) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async () => {});
    const prepare = vi.fn(async () => "encrypted replacement");
    const storageSave = vi.fn();
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: community,
        media: () => undefined,
        query: async (filters) =>
          events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        channelKit: { prepare, decode: async () => [] },
        writer: { kinds: [30078, 40100], sign, publish },
      },
      { outboxStorage: { load: () => hydration, save: storageSave } },
    );
    try {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(
          owner.session.channels
            .list()
            .channels.find((row) => row.id === channel)?.members,
        ).toContain(viewer.pubkey),
      );
      vi.useFakeTimers();
      const saving =
        kind === "recipe"
          ? owner.session.channelKit.save(record.value, undefined)
          : owner.session.canvas.save(channel, "Replacement", undefined);
      const rejected = expect(saving).rejects.toThrow(/unresolved/);
      // Drain read/admission microtasks while storage is explicitly held. No timer
      // delay can stand in for hydration, and no replacement intent may be queued.
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.session.outbox?.snapshot()).toEqual([]);
      expect(prepare).not.toHaveBeenCalled();
      hydrate([{ event: prior, signed: prior, delivery: "unknown" }]);
      await rejected;
      expect(
        owner.session.outbox?.snapshot().map((row) => row.event.id),
      ).toEqual([prior.id]);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      // Discovery queues the outbox's existing access-evidence purge behind
      // hydration. It may persist, but must preserve only the prior intent.
      await vi.advanceTimersByTimeAsync(0);
      for (const [rows] of storageSave.mock.calls)
        expect(rows).toEqual([
          { event: prior, signed: prior, delivery: "unknown" },
        ]);
    } finally {
      hydrate([]);
      owner.dispose();
    }
  },
);
