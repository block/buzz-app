import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, roster, scriptedTransport } from "./testing";
import type { LiveCallbacks } from "./live";
import type { MemoryListing, MemoryReader } from "../agents/memory";
const viewer = keypair(),
  relay = keypair(),
  agent = keypair();
const listing: MemoryListing = {
  entries: [
    { slug: "core", body: "private", eventId: "a".repeat(64), createdAt: 1 },
  ],
  partial: false,
};
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function harness(
  readAgentMemories?: MemoryReader,
  who = viewer.pubkey,
  scope = "https://one.example",
) {
  const wire = scriptedTransport(who, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    scope,
    ...(readAgentMemories ? { readAgentMemories } : {}),
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  live.state({ status: "connected", routes: [] });
  return { ...owner, live };
}
it("is lazy, exact-key, unsupported for self/malformed/unsupported hosts and independent of inventories", async () => {
  const read = vi.fn<MemoryReader>(async () => listing),
    h = harness(read);
  expect(read).not.toHaveBeenCalled();
  for (const key of [viewer.pubkey, "bad"]) {
    const view = h.session.agentMemories.open(key);
    await view.refresh();
    expect(view.snapshot().status).toBe("unavailable");
    view.dispose();
  }
  expect(read).not.toHaveBeenCalled();
  const view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  expect(read.mock.calls[0]?.[0]).toBe(agent.pubkey);
  expect(view.snapshot()).toEqual({ status: "ready", listing });
  expect(Object.isFrozen(view.snapshot().listing?.entries)).toBe(true);
  view.dispose();
  expect(view.snapshot().listing).toBeUndefined();
  const unsupported = harness().session.agentMemories.open(agent.pubkey);
  await unsupported.refresh();
  expect(unsupported.snapshot().status).toBe("unavailable");
});
it.each(["revoke", "disconnect", "cache", "dispose", "release"])(
  "%s clears plaintext and fences an in-flight completion through the actual session",
  async (mode) => {
    let resolve!: (listing: MemoryListing) => void;
    const read = vi
      .fn<MemoryReader>()
      .mockResolvedValueOnce(listing)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const h = harness(read),
      view = h.session.agentMemories.open(agent.pubkey);
    h.live.receive([roster(relay, "a", [viewer.pubkey], 1)]);
    await view.refresh();
    expect(view.snapshot().listing).toEqual(listing);
    const pending = view.refresh();
    expect(view.snapshot()).toEqual({ status: "loading" });
    if (mode === "revoke") h.live.receive([roster(relay, "a", [], 2)]);
    if (mode === "disconnect") h.live.state({ status: "error", routes: [] });
    if (mode === "cache") await h.clearCache();
    if (mode === "dispose") h.dispose();
    if (mode === "release") view.dispose();
    expect(read.mock.calls[1]?.[1].aborted).toBe(true);
    expect(view.snapshot().listing).toBeUndefined();
    resolve(listing);
    await pending;
    expect(view.snapshot().listing).toBeUndefined();
  },
);
it("does not leak across relay/viewer sessions and does not refresh while disconnected", async () => {
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing);
  const first = harness(read),
    second = harness(read, agent.pubkey, "https://two.example");
  const a = first.session.agentMemories.open(agent.pubkey),
    b = second.session.agentMemories.open(viewer.pubkey);
  await a.refresh();
  expect(b.snapshot().listing).toBeUndefined();
  second.live.state({ status: "error", routes: [] });
  await b.refresh();
  expect(b.snapshot().status).toBe("error");
  expect(read).toHaveBeenCalledTimes(1);
});
it("reports denied/error separately, retries, rejects malformed host output and bounds simultaneous views", async () => {
  const denied = new Error("secret");
  denied.name = "MemoryDenied";
  const read = vi
    .fn<MemoryReader>()
    .mockRejectedValueOnce(denied)
    .mockRejectedValueOnce(new Error("secret"))
    .mockResolvedValueOnce({ entries: [], partial: false })
    .mockResolvedValueOnce({
      entries: [null],
      partial: false,
    } as unknown as MemoryListing);
  const h = harness(read),
    view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  expect(view.snapshot()).toEqual({ status: "denied" });
  await view.refresh();
  expect(view.snapshot()).toEqual({ status: "error" });
  await view.refresh();
  expect(view.snapshot()).toEqual({
    status: "ready",
    listing: { entries: [], partial: false },
  });
  await view.refresh();
  expect(view.snapshot()).toEqual({ status: "error" });
  for (let i = 0; i < 3; i++) h.session.agentMemories.open(agent.pubkey);
  expect(() => h.session.agentMemories.open(agent.pubkey)).toThrow();
  view.dispose();
  expect(() => h.session.agentMemories.open(agent.pubkey)).not.toThrow();
});

it("disconnect subscribers cannot reenter with stale connected authority", async () => {
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing);
  const h = harness(read),
    view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  const stop = view.subscribe(() => {
    if (view.snapshot().status === "idle") void view.refresh();
  });
  h.live.state({ status: "error", routes: [] });
  stop();
  expect(view.snapshot()).toEqual({ status: "error" });
  expect(read).toHaveBeenCalledTimes(1);
});
