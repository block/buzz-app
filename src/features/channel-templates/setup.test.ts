// @vitest-environment jsdom
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import { createChannelSetup, type ChannelCreationInput } from "./setup";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";

const viewer = keypair();
const agent = keypair().pubkey;
const input: ChannelCreationInput = {
  name: "Daily",
  visibility: "private",
  setup: {
    agents: [agent],
    canvas: "# Plan",
    groupId: "work",
    templateId: "daily",
  },
};
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _opts: unknown,
        run: (lock: object) => unknown,
      ) => run({}),
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
});
function fixture() {
  const events: OutgoingEvent[] = [];
  let clock = 1_700_000_000;
  let canvas: string | undefined;
  const outbox: Outbox = {
    snapshot: () => events,
    subscribe: () => () => {},
    observeSend: () => () => {},
    ready: async () => {},
    acknowledge: async () => {},
    supports: () => true,
    send: vi.fn((value) => {
      const event = signed(viewer, { ...value, created_at: clock++ });
      events.push({ event, delivery: "accepted" });
      return event.id;
    }),
    retry: vi.fn(),
    dismiss: vi.fn(async () => {}),
  };
  const opts = {
    scope: "setup-test",
    outbox,
    local: outbox,
    create: vi.fn((id: string, _input: ChannelCreationInput) =>
      outbox.send({ kind: 9007, content: "", tags: [["h", id]] }),
    ),
    delivered: vi.fn(async (_id: string) => {}),
    confirm: vi.fn(async (id: string) => {
      if (events.find((e) => e.event.id === id)?.event.kind === 40100)
        canvas = id;
    }),
    refresh: vi.fn(async (_id: string, _member: string) => {}),
    canvasHead: vi.fn(async () => canvas),
    place: vi.fn(async (_id: string, _group: string) => {}),
    preflight: vi.fn(async (_input: ChannelCreationInput) => {}),
    signal: new AbortController().signal,
  };
  return {
    opts,
    events,
    outbox,
    setup: createChannelSetup(opts),
    setCanvas: (id: string) => {
      canvas = id;
    },
  };
}

it("creates once, seeds Canvas before membership, and places the finished channel without any message", async () => {
  const f = fixture();
  const id = await f.setup.run(input, viewer.pubkey);
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100, 9000]);
  expect(f.events[2]?.event.tags).toEqual([
    ["h", id],
    ["p", agent],
  ]);
  expect(f.opts.confirm.mock.calls.map(([eventId]) => eventId)).toEqual(
    f.events.slice(1).map((e) => e.event.id),
  );
  expect(f.opts.place).toHaveBeenCalledWith(id, "work");
  expect(f.setup.snapshot()).toBeUndefined();
  expect(f.setup.completedId()).toBe(id);
});

it("resumes the frozen same-channel operations without replaying accepted membership or checking mutable catalogs", async () => {
  const f = fixture();
  f.opts.refresh.mockImplementation(async (_id, member) => {
    if (member === agent) throw new Error("Roster not confirmed");
  });
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow(
    /setup incomplete/,
  );
  const id = f.setup.channelId();
  expect(f.events).toHaveLength(3);
  const confirmations = f.opts.confirm.mock.calls.length;
  f.opts.preflight.mockRejectedValue(new Error("Catalog unavailable"));
  const restored = createChannelSetup(f.opts);
  await expect(
    restored.run({ ...input, name: "Changed" }, viewer.pubkey),
  ).rejects.toThrow(/frozen/);
  f.opts.refresh.mockResolvedValue();
  expect(await restored.run(input, viewer.pubkey)).toBe(id);
  expect(f.events).toHaveLength(3);
  expect(f.opts.confirm).toHaveBeenCalledTimes(confirmations);
  expect(f.opts.preflight).toHaveBeenCalledTimes(1);
});

it("keeps unknown creation frozen but permits a fresh attempt after a known failure", async () => {
  const f = fixture();
  f.opts.delivered.mockImplementation(async () => {
    assert.exists(f.events[0]);
    f.events[0] = { ...f.events[0], delivery: "unknown" };
    throw new Error("Unknown delivery");
  });
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow(
    "Unknown delivery",
  );
  expect(f.setup.snapshot()).toEqual(input);
  expect(f.setup.channelId()).toBeUndefined();
  expect(f.outbox.dismiss).not.toHaveBeenCalled();
  f.opts.delivered.mockImplementation(async () => {
    assert.exists(f.events[0]);
    f.events[0] = { ...f.events[0], delivery: "failed" };
    throw new Error("Rejected");
  });
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow("Rejected");
  expect(f.setup.snapshot()).toBeUndefined();
  assert.exists(f.events[0]);
  expect(f.outbox.dismiss).toHaveBeenCalledWith(f.events[0].event.id);
});

it("stops agents when Canvas confirmation fails, then permits keeping the partial channel without rollback", async () => {
  const f = fixture();
  f.opts.confirm.mockRejectedValue(new Error("Canvas unconfirmed"));
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow(
    /setup incomplete/,
  );
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100]);
  const id = f.setup.channelId();
  expect(await f.setup.keepPartial()).toBe(id);
  expect(f.setup.snapshot()).toBeUndefined();
  assert.exists(f.events[0]);
  expect(f.outbox.dismiss).toHaveBeenCalledWith(f.events[0].event.id);
  expect(f.events).toHaveLength(2);
});

it("blocks continuation when seeded Canvas was changed, storage is corrupt, or another window holds the lock", async () => {
  const f = fixture();
  f.opts.refresh.mockImplementation(async (_id, member) => {
    if (member === agent) throw new Error("Roster pending");
  });
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow();
  f.setCanvas("f".repeat(64));
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow(
    /Canvas changed after seeding/,
  );
  const count = f.events.length;
  localStorage.setItem("buzz-channel-setup.v1:setup-test", "broken");
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow(
    /storage needs attention/,
  );
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _opts: unknown,
        run: (lock: null) => unknown,
      ) => run(null),
    },
  });
  await expect(f.setup.run(input, viewer.pubkey)).rejects.toThrow(
    /Another window/,
  );
  expect(f.events).toHaveLength(count);
});
