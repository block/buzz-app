import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventHash, verifyEvent, verifiedSymbol } from "nostr-tools";
import { createEventVerifier, eventDto, savedEvent } from "./events";
import { connectBrokerTransport, connectSignedTransport } from "./transport";
import { keypair, signed } from "./testing";
import { ByteLru } from "./budget";

// Count the actual dependency verifier; never replace its cryptographic result.
vi.mock("nostr-tools", async (original) => {
  const actual = await original<typeof import("nostr-tools")>();
  return { ...actual, verifyEvent: vi.fn(actual.verifyEvent) };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const key = keypair();
const other = keypair();
const event = signed(key, { kind: 9, content: "original", tags: [["h", "a"]] });
const wire = () => JSON.parse(JSON.stringify(event));

it("reuses only its own proof while returning newly owned, frozen wire fields", () => {
  const verify = createEventVerifier();
  const first = verify(event); // even a genuine incoming verifiedSymbol is ignored
  const raw = wire();
  raw[verifiedSymbol] = false;
  raw.extra = "not retained";
  const second = verify(raw);
  expect(verifyEvent).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.tags).not.toBe(first.tags);
  expect(second[verifiedSymbol]).toBe(true);
  expect(second).not.toHaveProperty("extra");
  raw.tags[0].push("changed");
  expect(second.tags).toEqual([["h", "a"]]);
  expect(Object.isFrozen(second)).toBe(true);
  expect(Object.isFrozen(second.tags)).toBe(true);
  expect(Object.isFrozen(second.tags[0])).toBe(true);
  createEventVerifier()(wire()); // another connection has no proof
  eventDto(wire()); // uncached boundary remains uncached
  eventDto(wire());
  expect(verifyEvent).toHaveBeenCalledTimes(4);
});

it("rehashes every signed field on a proof hit and rejects forged markers and IDs", () => {
  const verify = createEventVerifier();
  verify(wire());
  for (const patch of [
    { content: "tampered" },
    { pubkey: other.pubkey },
    { created_at: event.created_at + 1 },
    { kind: 1 },
    { tags: [["h", "b"]] },
    { tags: [["h", "a", "extra"]] },
    { sig: "0".repeat(128) },
    { id: "0".repeat(64) },
  ]) {
    expect(() =>
      verify({ ...wire(), ...patch, [verifiedSymbol]: true }),
    ).toThrow(/malformed/);
  }
  const changed = { ...wire(), content: "new hash with old signature" };
  changed.id = getEventHash(changed);
  expect(() => verify(changed)).toThrow(/malformed/);
  expect(verify(wire()).id).toBe(event.id); // failed input cannot poison valid proof
});

it("still validates envelope values on hits and never memoizes a failure", () => {
  const verify = createEventVerifier();
  verify(wire());
  for (const patch of [
    { created_at: Infinity },
    { created_at: 1.5 },
    { kind: 65536 },
    { pubkey: event.pubkey.toUpperCase() },
    { sig: event.sig.toUpperCase() },
    { content: null },
    { tags: [["h", 1]] },
  ])
    expect(() => verify({ ...wire(), ...patch })).toThrow(/malformed/);
  const bad = { ...wire(), sig: "0".repeat(128), [verifiedSymbol]: true };
  vi.mocked(verifyEvent).mockClear();
  expect(() => verify(bad)).toThrow();
  expect(() => verify(bad)).toThrow();
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  expect(verify(wire()).id).toBe(event.id);
  expect(verifyEvent).toHaveBeenCalledTimes(2);
});

it("a different valid signature for the same event ID earns a new proof", () => {
  const verify = createEventVerifier();
  const alternate = signed(key, {
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  });
  expect(alternate.id).toBe(event.id);
  expect(alternate.sig).not.toBe(event.sig);
  verify(wire());
  verify(alternate);
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(JSON.parse(JSON.stringify(alternate)));
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(wire()); // only one signature is retained per ID
  expect(verifyEvent).toHaveBeenCalledTimes(3);
});

it("evicts the oldest proof at the fixed 2048-entry bound and re-verifies it", () => {
  // Observe the real memo populated by cryptographic verification, then fill its
  // remaining slots directly. Cache pressure needs opaque entries, not thousands
  // of signatures generated and verified inside one runner deadline.
  const writes = vi.spyOn(ByteLru.prototype, "set");
  const verify = createEventVerifier();
  verify(wire());
  const memo = writes.mock.contexts[0] as ByteLru<string>;
  writes.mockRestore();
  expect(memo.maxEntries).toBe(2048);
  expect(memo.maxBytes).toBe(2048 * 192);
  for (let i = 0; i < 2047; i++) memo.set(`filler:${i}`, "opaque", 192);
  expect(memo.stats()).toEqual({ entries: 2048, bytes: 2048 * 192 });
  expect(memo.peek(event.id)).toBe(event.sig);

  const newest = signed(key, { kind: 9, content: "newest", tags: [] });
  verify(newest);
  expect(memo.stats()).toEqual({ entries: 2048, bytes: 2048 * 192 });
  expect(memo.peek(event.id)).toBeUndefined();
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(newest);
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(wire());
  expect(verifyEvent).toHaveBeenCalledTimes(3);
  expect(memo.peek(event.id)).toBe(event.sig);
});

it.each(["broker", "signed"])(
  "%s HTTP queries keep fresh reads, reject changed warm bytes and isolate proofs",
  async (mode) => {
    let payload: unknown = wire();
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/session")
        ? Response.json({ viewer: key.pubkey, relayAuthor: key.pubkey })
        : Response.json([payload, payload]),
    );
    vi.stubGlobal("fetch", fetcher);
    const connect = () =>
      mode === "broker"
        ? connectBrokerTransport()
        : connectSignedTransport(
            {
              getPublicKey: async () => key.pubkey,
              signEvent: async (t) => signed(key, t),
            },
            "https://proof.test",
            key.pubkey,
          );
    const first = await connect();
    const filters = [{ kinds: [9], "#h": ["a"], limit: 2 }];
    expect(await first.query(filters)).toHaveLength(2);
    expect(await first.query(filters)).toHaveLength(2);
    // Batches check their unproven events together, so a repeat within one
    // response is checked twice; the next response reuses the proof.
    expect(verifyEvent).toHaveBeenCalledTimes(2);
    payload = { ...wire(), content: "corrupted after cold read" };
    await expect(first.query(filters)).rejects.toThrow(/malformed/);
    payload = { ...wire(), sig: "0".repeat(128) };
    await expect(first.query(filters)).rejects.toThrow(/malformed/);
    payload = wire();
    vi.mocked(verifyEvent).mockClear();
    expect(await first.query(filters)).toHaveLength(2);
    expect(verifyEvent).not.toHaveBeenCalled();
    const second = await connect();
    expect(await second.query(filters)).toHaveLength(2);
    expect(verifyEvent).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("/query")),
    ).toHaveLength(6);
    const aborted = new AbortController();
    aborted.abort();
    await expect(first.query(filters, aborted.signal)).rejects.toThrow();
  },
);

it("restores saved events without a signature check but rejects edited signed fields", () => {
  const restored = savedEvent(wire());
  expect(restored).toEqual(event);
  expect(restored[verifiedSymbol]).toBe(true);
  expect(Object.isFrozen(restored)).toBe(true);
  expect(verifyEvent).not.toHaveBeenCalled();
  for (const patch of [
    { content: "tampered" },
    { pubkey: other.pubkey },
    { created_at: event.created_at + 1 },
    { tags: [["h", "b"]] },
    { id: "0".repeat(64) },
    { sig: "not hex" },
  ])
    expect(() => savedEvent({ ...wire(), ...patch })).toThrow(/malformed/);
});

describe("background signature checks", () => {
  /** Runs the worker's check in-process, with the real (unmocked) verifier.
   * `held` keeps each reply until the test releases it. */
  async function stubWorker({ fail = false, held = false } = {}) {
    const actual =
      await vi.importActual<typeof import("nostr-tools")>("nostr-tools");
    const posted: unknown[][] = [];
    const pending: (() => void)[] = [];
    class FakeWorker {
      onmessage?: (message: { data: unknown }) => void;
      onerror?: () => void;
      postMessage(events: unknown[]) {
        posted.push(events);
        const copy = structuredClone(events);
        const reply = () =>
          fail
            ? this.onerror?.()
            : this.onmessage?.({
                data: {
                  ok: copy.every((item) => actual.verifyEvent(item as never)),
                  ms: 1,
                },
              });
        if (held) pending.push(reply);
        else setTimeout(reply);
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    vi.resetModules();
    const { createEventVerifier } = await import("./events");
    return { verify: createEventVerifier(), posted, pending };
  }
  const messages = (count: number, prefix = "m") =>
    Array.from({ length: count }, (_, index) =>
      signed(key, { kind: 9, content: `${prefix}${index}`, tags: [] }),
    );

  it("checks new signatures off the main thread and rejects the whole batch on one bad signature", async () => {
    const { verify, posted } = await stubWorker();
    const batch = messages(70);
    const events = await verify.many(batch);
    expect(events.map((item) => item.id)).toEqual(batch.map((item) => item.id));
    expect(events.every((item) => Object.isFrozen(item))).toBe(true);
    expect(posted).toHaveLength(2); // 64-event chunks spread across workers
    expect(verifyEvent).not.toHaveBeenCalled(); // main thread did no crypto
    expect(await verify.many(batch)).toHaveLength(70);
    expect(posted).toHaveLength(2); // proofs reused, nothing re-sent
    await expect(
      verify.many([
        ...messages(12, "bad"),
        { ...wire(), sig: "0".repeat(128) },
      ]),
    ).rejects.toThrow(/malformed/);
  });

  it("checks a read within one inline batch without a worker round-trip", async () => {
    const { verify, posted } = await stubWorker();
    expect(await verify.many(messages(12))).toHaveLength(12);
    expect(posted).toHaveLength(0);
    expect(verifyEvent).toHaveBeenCalledTimes(12);
    await expect(
      verify.many([wire(), { ...wire(), sig: "0".repeat(128) }]),
    ).rejects.toThrow(/malformed/);
  });

  it("falls back to inline checks when the worker fails", async () => {
    const { verify, posted } = await stubWorker({ fail: true });
    expect(await verify.many(messages(13))).toHaveLength(13);
    expect(posted).toHaveLength(1);
    expect(verifyEvent).toHaveBeenCalledTimes(13);
    await expect(
      verify.many([
        ...messages(12, "next"),
        { ...wire(), content: "x", id: event.id },
      ]),
    ).rejects.toThrow(/malformed/);
  });

  it("copies and rehashes a warm batch in bounded turns that let the host run", async () => {
    const { verify } = await stubWorker();
    const batch = messages(100);
    await verify.many(batch); // every proof now hits
    const touched = new Set<number>();
    const values = batch.map((item, index) => ({
      ...item,
      get content() {
        touched.add(index);
        return item.content;
      },
    }));
    const read = verify.many(values);
    expect(touched.size).toBeLessThanOrEqual(12); // the rest waits for a later turn
    expect(await read).toHaveLength(100);
    expect(touched.size).toBe(100);
  });

  it("keeps a cancelled read's unsent chunks away from the workers", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 }); // one worker
    const { verify, posted, pending } = await stubWorker({ held: true });
    const abort = new AbortController();
    const cancelled = verify.many(messages(256, "old"), abort.signal);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    abort.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    const next = verify.many(messages(13, "new"));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.(); // the obsolete chunk already on the worker finishes
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    expect(await next).toHaveLength(13);
    expect(posted.map((events) => events.length)).toEqual([64, 13]);
  });

  it("does not dispatch a read that was cancelled before its checks", async () => {
    const { verify, posted } = await stubWorker({ held: true });
    const abort = new AbortController();
    abort.abort();
    await expect(verify.many(messages(13), abort.signal)).rejects.toThrow(
      /cancelled/,
    );
    expect(posted).toHaveLength(0);
  });
});
