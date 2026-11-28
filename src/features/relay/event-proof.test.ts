import { afterEach, assert, expect, it, vi } from "vitest";
import { getEventHash, verifyEvent, verifiedSymbol } from "nostr-tools";
import {
  createEventVerifier,
  eventDto,
  hasEventProof,
  type EventVerifier,
  type RelayEvent,
} from "./events";
import { connectBrokerTransport, connectSignedTransport } from "./transport";
import { hostSigner, keypair, nativeSignatureChecks, signed } from "./testing";
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

function makeVerifier() {
  const check = vi.fn(
    async (claims: readonly { id: string; pubkey: string; sig: string }[]) =>
      nativeSignatureChecks({ claims }),
  );
  const verifier = createEventVerifier(check);
  const verifyOne = async (value: unknown): Promise<RelayEvent> => {
    const [verified] = await verifier.settle([verifier.prepare(value)]);
    if (!verified)
      throw new Error("Relay supplied a malformed or invalidly signed event");
    return verified;
  };
  return { verifier, check, verifyOne };
}

it("reuses only its own proof while returning newly owned, frozen wire fields", async () => {
  const { check, verifyOne } = makeVerifier();
  const first = await verifyOne(event); // even a genuine incoming verifiedSymbol is ignored
  const raw = wire();
  raw[verifiedSymbol] = false;
  raw.extra = "not retained";
  const second = await verifyOne(raw);
  expect(check).toHaveBeenCalledTimes(1);
  expect(verifyEvent).not.toHaveBeenCalled();
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.tags).not.toBe(first.tags);
  expect(second[verifiedSymbol]).toBe(true);
  expect(second).not.toHaveProperty("extra");
  raw.tags[0].push("changed");
  const [channel] = second.tags;
  assert(channel);
  expect(Reflect.set(second, "content", "tampered")).toBe(false);
  expect(Reflect.set(second.tags, 0, ["h", "other"])).toBe(false);
  expect(Reflect.set(channel, 1, "other")).toBe(false);
  expect(Reflect.set(second.tags, 1, ["p", other.pubkey])).toBe(false);
  expect(second.tags).toEqual([["h", "a"]]);
  expect(getEventHash(second)).toBe(second.id);
  expect(hasEventProof(second)).toBe(true);
  const isolated = makeVerifier();
  await isolated.verifyOne(wire()); // another connection has no proof
  expect(isolated.check).toHaveBeenCalledTimes(1);
  eventDto(wire()); // uncached single-event boundary remains uncached
  eventDto(wire());
  expect(verifyEvent).toHaveBeenCalledTimes(2);
});

it("rehashes every signed field on a proof hit and rejects forged markers and IDs", async () => {
  const { verifyOne } = makeVerifier();
  await verifyOne(wire());
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
    await expect(
      verifyOne({ ...wire(), ...patch, [verifiedSymbol]: true }),
    ).rejects.toThrow(/malformed/);
  }
  const changed = { ...wire(), content: "new hash with old signature" };
  changed.id = getEventHash(changed);
  await expect(verifyOne(changed)).rejects.toThrow(/malformed/);
  expect((await verifyOne(wire())).id).toBe(event.id); // failed input cannot poison valid proof
});

it("still validates envelope values on hits and never memoizes a failure", async () => {
  const { check, verifyOne } = makeVerifier();
  await verifyOne(wire());
  for (const patch of [
    { created_at: Infinity },
    { created_at: 1.5 },
    { kind: 65536 },
    { pubkey: event.pubkey.toUpperCase() },
    { sig: event.sig.toUpperCase() },
    { content: null },
    { tags: [["h", 1]] },
  ])
    await expect(verifyOne({ ...wire(), ...patch })).rejects.toThrow(
      /malformed/,
    );
  const bad = { ...wire(), sig: "0".repeat(128), [verifiedSymbol]: true };
  check.mockClear();
  await expect(verifyOne(bad)).rejects.toThrow();
  await expect(verifyOne(bad)).rejects.toThrow();
  expect(check).toHaveBeenCalledTimes(2);
  expect((await verifyOne(wire())).id).toBe(event.id);
  expect(check).toHaveBeenCalledTimes(2);
});

it("a different valid signature for the same event ID earns a new proof", async () => {
  const { check, verifyOne } = makeVerifier();
  const alternate = signed(key, {
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  });
  expect(alternate.id).toBe(event.id);
  expect(alternate.sig).not.toBe(event.sig);
  await verifyOne(wire());
  await verifyOne(alternate);
  expect(check).toHaveBeenCalledTimes(2);
  await verifyOne(JSON.parse(JSON.stringify(alternate)));
  expect(check).toHaveBeenCalledTimes(2);
  await verifyOne(wire()); // only one signature is retained per ID
  expect(check).toHaveBeenCalledTimes(3);
});

it("keeps no proof for an ephemeral event, which a relay never sends again", async () => {
  const { check, verifyOne } = makeVerifier();
  const typing = signed(key, { kind: 20002, content: "", tags: [["h", "a"]] });
  await verifyOne(typing);
  await verifyOne(JSON.parse(JSON.stringify(typing)));
  expect(check).toHaveBeenCalledTimes(2);
  const addressable = signed(key, { kind: 30000, content: "", tags: [] });
  await verifyOne(addressable);
  await verifyOne(JSON.parse(JSON.stringify(addressable)));
  expect(check).toHaveBeenCalledTimes(3);
});

it("evicts the oldest proof at the fixed 8192-entry bound and re-verifies it", async () => {
  // Observe the real memo populated by cryptographic verification, then fill its
  // remaining slots directly. Cache pressure needs opaque entries, not thousands
  // of signatures generated and verified inside one runner deadline.
  const writes = vi.spyOn(ByteLru.prototype, "set");
  const { check, verifyOne } = makeVerifier();
  await verifyOne(wire());
  const memo = writes.mock.contexts[0] as ByteLru<string>;
  writes.mockRestore();
  expect(memo.maxEntries).toBe(8192);
  expect(memo.maxBytes).toBe(8192 * 192);
  for (let i = 0; i < 8191; i++) memo.set(`filler:${i}`, "opaque", 192);
  expect(memo.stats()).toEqual({ entries: 8192, bytes: 8192 * 192 });
  expect(memo.peek(event.id)).toBe(event.sig);

  const newest = signed(key, { kind: 9, content: "newest", tags: [] });
  await verifyOne(newest);
  expect(memo.stats()).toEqual({ entries: 8192, bytes: 8192 * 192 });
  expect(memo.peek(event.id)).toBeUndefined();
  expect(check).toHaveBeenCalledTimes(2);
  await verifyOne(newest);
  expect(check).toHaveBeenCalledTimes(2);
  await verifyOne(wire());
  expect(check).toHaveBeenCalledTimes(3);
  expect(memo.peek(event.id)).toBe(event.sig);
});

it.each(["broker", "signed"])(
  "%s HTTP queries keep fresh reads, reject changed warm bytes and isolate proofs",
  async (mode) => {
    let payload: unknown = wire();
    const check = vi.fn(
      async (claims: readonly { id: string; pubkey: string; sig: string }[]) =>
        nativeSignatureChecks({ claims }),
    );
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session"))
        return Response.json({ viewer: key.pubkey, relayAuthor: key.pubkey });
      if (url.endsWith("/verify-signatures")) {
        const body = JSON.parse(String(init?.body)) as {
          claims: { id: string; pubkey: string; sig: string }[];
        };
        return Response.json(await check(body.claims));
      }
      return Response.json([payload, payload]);
    });
    vi.stubGlobal("fetch", fetcher);
    const connect = () =>
      mode === "broker"
        ? connectBrokerTransport()
        : connectSignedTransport(
            hostSigner(key, undefined, check),
            "https://proof.test",
            key.pubkey,
          );
    const first = await connect();
    const filters = [{ kinds: [9], "#h": ["a"], limit: 2 }];
    expect(await first.query(filters)).toHaveLength(2);
    expect(await first.query(filters)).toHaveLength(2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(verifyEvent).not.toHaveBeenCalled();
    payload = { ...wire(), content: "corrupted after cold read" };
    await expect(first.query(filters)).rejects.toThrow(/malformed/);
    payload = { ...wire(), sig: "0".repeat(128) };
    await expect(first.query(filters)).rejects.toThrow(/malformed/);
    payload = wire();
    check.mockClear();
    expect(await first.query(filters)).toHaveLength(2);
    expect(check).not.toHaveBeenCalled();
    const second = await connect();
    expect(await second.query(filters)).toHaveLength(2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(verifyEvent).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("/query")),
    ).toHaveLength(6);
    const aborted = new AbortController();
    aborted.abort();
    await expect(first.query(filters, aborted.signal)).rejects.toThrow();
  },
);

it("batches memo misses and admits only independently verified host results", async () => {
  const { verifier, check } = makeVerifier();
  const batch = async (v: EventVerifier, values: unknown[]) =>
    v.settle(values.map((value) => v.prepare(value)));
  const second = signed(key, { kind: 9, content: "second", tags: [] });
  const events = await batch(verifier, [wire(), second]);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0]?.[0]).toEqual([
    { id: event.id, pubkey: event.pubkey, sig: event.sig },
    { id: second.id, pubkey: second.pubkey, sig: second.sig },
  ]);
  expect(verifyEvent).not.toHaveBeenCalled();
  expect(events.map((item) => item?.[verifiedSymbol])).toEqual([true, true]);
  expect(events.every((item) => item && hasEventProof(item))).toBe(true);
  expect(Object.isFrozen(events[0])).toBe(true);
  await batch(verifier, [wire()]); // remembered: no host call
  expect(check).toHaveBeenCalledTimes(1);
  await expect(
    batch(verifier, [{ ...wire(), content: "changed" }]),
  ).rejects.toThrow("invalidly signed");
  const forged = { ...signed(other, { kind: 9, content: "x", tags: [] }) };
  expect(
    await batch(verifier, [
      wire(),
      { ...forged, sig: "0".repeat(128) },
      forged,
    ]),
  ).toEqual([event, undefined, forged]);
  const calls = check.mock.calls.length;
  expect(
    await batch(verifier, [forged, { ...forged, sig: "0".repeat(128) }]),
  ).toEqual([forged, undefined]);
  expect(check).toHaveBeenCalledTimes(calls + 1); // A failed signature never earns a proof.
  check.mockResolvedValueOnce([]);
  await expect(
    batch(verifier, [second, { ...forged, sig: "0".repeat(128) }]),
  ).rejects.toThrow("invalidly signed");
  check.mockRejectedValueOnce(new Error("host failed"));
  await expect(
    batch(verifier, [{ ...forged, sig: "0".repeat(128) }]),
  ).rejects.toThrow("host failed");
});
