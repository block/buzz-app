import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, signed, scriptedTransport, roster } from "./testing";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";

const viewer = keypair(),
  relay = keypair(),
  other = keypair(),
  target = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const owner of owners.splice(0)) owner.dispose();
});
function snapshot(time = 1, keys = [target.pubkey]) {
  return signed(relay, {
    kind: 13535,
    created_at: time,
    content: "",
    tags: [["-"], ...keys.map((key) => ["p", key])],
  });
}
function harness(authority: string | null = relay.pubkey) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const query = vi.fn(wire.transport.query);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    query,
    ...(authority ? { archiveAuthority: authority } : {}),
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return { ...owner, wire, query, live, archives: owner.session.archives };
}
async function read(h: ReturnType<typeof harness>, events: RelayEvent[]) {
  const pending = h.archives.refresh();
  h.wire.next().respond(events);
  await pending;
}
it("is lazy, exact-author, fresh, bounded and background through the actual session", async () => {
  const h = harness();
  expect(h.query).not.toHaveBeenCalled();
  expect(h.archives.state(target.pubkey)).toBe("unknown");
  const first = h.archives.ensure();
  expect(h.archives.ensure()).toBe(first);
  const request = h.wire.next();
  expect(request.filters).toEqual([
    { kinds: [13535], authors: [relay.pubkey], limit: 1 },
  ]);
  expect(h.query.mock.calls[0]?.[3]).toBe("background");
  request.respond([snapshot()]);
  await first;
  expect(h.archives.state(target.pubkey)).toBe("archived");
  expect(h.archives.state(other.pubkey)).toBe("not-archived");
  expect(h.archives.state("invalid")).toBe("unknown");
  expect(Object.isFrozen(h.archives.snapshot().archived)).toBe(true);
  await h.archives.ensure();
  expect(h.query).toHaveBeenCalledTimes(1);
  const previous = h.session.read([
    { kinds: [13535], authors: [relay.pubkey], limit: 1 },
  ]);
  const oldRequest = h.wire.next();
  const refresh = h.archives.refresh();
  h.wire.next().respond([snapshot(2, [])]);
  await refresh;
  oldRequest.respond([snapshot()]);
  await previous;
  expect(h.archives.state(target.pubkey)).toBe("not-archived");
  expect(h.query).toHaveBeenCalledTimes(3);
});
it.each([null, "invalid"])(
  "does not infer archive authority from relayAuthor (%s)",
  async (authority) => {
    const h = harness(authority);
    await h.archives.refresh();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.archives.snapshot().status).toBe("unavailable");
    expect(h.archives.state(target.pubkey)).toBe("unknown");
  },
);
it("replaces the whole list, ignores invalid p keys and extra p elements, and keeps relay scopes separate", async () => {
  const h = harness(),
    elsewhere = harness();
  await read(h, [
    signed(relay, {
      kind: 13535,
      created_at: 1,
      content: "",
      tags: [
        ["-"],
        ["p", target.pubkey, "ignored", other.pubkey],
        ["p", target.pubkey],
        ["p", "invalid"],
        ["p"],
        ["p", target.pubkey.toUpperCase()],
      ],
    }),
  ]);
  expect(h.archives.snapshot().archived).toEqual([target.pubkey]);
  expect(elsewhere.archives.state(target.pubkey)).toBe("unknown");
  await read(elsewhere, [snapshot(2, [])]);
  expect(elsewhere.archives.state(target.pubkey)).toBe("not-archived");
  await read(h, [snapshot(3, [other.pubkey])]);
  expect(h.archives.snapshot().archived).toEqual([other.pubkey]);
});
it.each([
  ["empty", () => []],
  [
    "wrong author",
    () => [signed(other, { kind: 13535, tags: [["-"]], content: "" })],
  ],
  [
    "wrong kind",
    () => [signed(relay, { kind: 8002, tags: [["-"]], content: "" })],
  ],
  [
    "missing protected marker",
    () => [signed(relay, { kind: 13535, content: "", tags: [] })],
  ],
  [
    "duplicate marker",
    () => [signed(relay, { kind: 13535, tags: [["-"], ["-"]], content: "" })],
  ],
  [
    "malformed marker",
    () => [signed(relay, { kind: 13535, tags: [["-", "extra"]], content: "" })],
  ],
  [
    "nonempty content",
    () => [signed(relay, { kind: 13535, tags: [["-"]], content: "secret" })],
  ],
  ["multiple snapshots", () => [snapshot(1), snapshot(2)]],
  [
    "oversize",
    () => [
      signed(relay, {
        kind: 13535,
        content: "",
        tags: [["-"], ["extra", "x".repeat(2 * 1024 * 1024)]],
      }),
    ],
  ],
] as const)(
  "%s evidence cannot present known active state or retain old contents",
  async (_label, events) => {
    const h = harness();
    await read(h, [snapshot()]);
    await read(h, events());
    expect(h.archives.snapshot()).toMatchObject({
      status: "error",
      archived: [],
    });
    expect(h.archives.snapshot().error).not.toContain("secret");
    expect(h.archives.state(target.pubkey)).toBe("unknown");
    expect(h.archives.state(other.pubkey)).toBe("unknown");
  },
);
it("read failures redact payload and remain retryable", async () => {
  const h = harness();
  const pending = h.archives.refresh();
  h.wire.next().fail(new Error("secret upstream body"));
  await pending;
  expect(h.archives.snapshot().status).toBe("error");
  expect(h.archives.snapshot().error).not.toContain("secret");
  await read(h, [snapshot()]);
  expect(h.archives.state(target.pubkey)).toBe("archived");
});
it("rejects rollback across refresh, failure and cache clear; permits the same head and lower-id tie winner", async () => {
  const h = harness();
  const a = snapshot(5),
    b = snapshot(5, []);
  const [winner, loser] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
  if (!winner || !loser) throw new Error("fixture");
  await read(h, [loser]);
  await read(h, [winner]);
  expect(h.archives.snapshot().eventId).toBe(winner.id);
  await h.clearCache();
  await read(h, [snapshot(4)]);
  expect(h.archives.snapshot().status).toBe("error");
  await read(h, [loser]);
  expect(h.archives.snapshot().status).toBe("error");
  await read(h, [winner]);
  expect(h.archives.snapshot().eventId).toBe(winner.id);
  await read(h, [snapshot(6)]);
  expect(h.archives.snapshot().createdAt).toBe(6);
});
it.each(["cache", "disconnect", "access", "dispose"] as const)(
  "%s invalidation clears known state and fences late results",
  async (action) => {
    const h = harness();
    h.live.state({ status: "connected", routes: [] });
    if (action === "access")
      h.live.receive([roster(relay, "room", [viewer.pubkey], 1)]);
    await read(h, [snapshot()]);
    const pending = h.archives.refresh();
    const req = h.wire.next();
    if (action === "cache") await h.clearCache();
    else if (action === "disconnect")
      h.live.state({ status: "retrying", routes: [] });
    else if (action === "access")
      h.live.receive([roster(relay, "room", [], 2)]);
    else h.dispose();
    expect(req.signal?.aborted).toBe(true);
    expect(h.archives.state(target.pubkey)).toBe("unknown");
    req.respond([snapshot(2)]);
    await pending;
    expect(h.archives.snapshot().status).toBe(
      action === "dispose" ? "unavailable" : "idle",
    );
    if (action === "dispose") {
      const calls = h.query.mock.calls.length;
      await h.archives.refresh();
      expect(h.query).toHaveBeenCalledTimes(calls);
    }
  },
);
it("retained historical messages remain visible when their author is archived", async () => {
  const h = harness();
  const message = signed(target, {
    kind: 9,
    content: "history",
    tags: [["h", "room"]],
  });
  const view = h.session.observe([{ kinds: [9], "#h": ["room"], limit: 20 }]);
  const refresh = view.refresh();
  h.wire.next().respond([message]);
  await refresh;
  await read(h, [snapshot()]);
  expect(view.snapshot().events.map((event) => event.id)).toContain(message.id);
  view.dispose();
});

it("the session deadline releases a held archive read without claiming anyone active", async () => {
  vi.useFakeTimers();
  const h = harness();
  const pending = h.archives.refresh();
  const req = h.wire.next();
  await vi.advanceTimersByTimeAsync(10_001);
  await pending;
  expect(req.signal?.aborted).toBe(true);
  expect(h.archives.snapshot().status).toBe("error");
  req.respond([snapshot()]);
  await Promise.resolve();
  expect(h.archives.state(target.pubkey)).toBe("unknown");
  await read(h, [snapshot(2)]);
  expect(h.archives.state(target.pubkey)).toBe("archived");
});
it("reentrant cache clear before dispatch prevents a read; a successor is not clobbered by the old completion", async () => {
  const h = harness();
  const stop = h.archives.subscribe(() => {
    if (h.archives.snapshot().status === "loading") void h.clearCache();
  });
  await h.archives.refresh();
  expect(h.query).not.toHaveBeenCalled();
  stop();
  const first = h.archives.refresh();
  const old = h.wire.next();
  await h.clearCache();
  const second = h.archives.refresh();
  const current = h.wire.next();
  old.respond([snapshot(3)]);
  await first;
  expect(h.archives.refresh()).toBe(second);
  current.respond([snapshot(2)]);
  await second;
  expect(h.archives.snapshot().createdAt).toBe(2);
});
