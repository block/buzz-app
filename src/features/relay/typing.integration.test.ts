import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { keypair, roster, signed, scriptedTransport } from "./testing";

afterEach(() => vi.useRealTimers());
it("owns one ephemeral projection across views; purges on access, disconnect, cache and disposal", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const dispose = vi.fn(),
    subscribe = vi.fn((callbacks: LiveCallbacks) => {
      live = callbacks;
      return { update() {}, retry() {}, dispose };
    });
  const owner = createRelaySession({ ...wire.transport, subscribe });
  const pulse = signed(agent, {
    kind: 20002,
    content: "",
    tags: [["h", "a"]],
    created_at: 1_800_000_000,
  });
  const view = owner.session.observe([
    { kinds: [20002], "#h": ["a"], limit: 10 },
  ]);
  const stops = [1, 2].map(() => owner.session.typing.subscribe(() => {}));
  live.state({ status: "connected", routes: [] });
  const snapshot = owner.session.typing.snapshot;
  // No roster means no access, even for a signed event.
  live.receive([pulse]);
  expect(snapshot()).toEqual([]);
  live.receive([roster(relay, "a", [viewer.pubkey])]);
  live.receive([pulse]);
  expect(snapshot()).toHaveLength(1);
  expect(view.snapshot().events).toEqual([]);
  expect(subscribe).toHaveBeenCalledTimes(1);
  const callback = vi.fn(() => expect(snapshot()).toEqual([]));
  const stop = owner.session.typing.subscribe(callback);
  live.receive([roster(relay, "a", [], 1_800_000_001), pulse]);
  expect(snapshot()).toEqual([]);
  expect(callback).toHaveBeenCalled();
  stop();
  live.receive([roster(relay, "a", [viewer.pubkey], 1_800_000_002), pulse]);
  expect(snapshot()).toHaveLength(1);
  live.state({ status: "retrying", routes: [] });
  expect(snapshot()).toEqual([]);
  live.receive([pulse]);
  expect(snapshot()).toEqual([]);
  live.state({ status: "connected", routes: [] });
  live.receive([pulse]);
  expect(snapshot()).toHaveLength(1);
  await owner.clearCache();
  expect(snapshot()).toEqual([]);
  live.receive([roster(relay, "a", [viewer.pubkey], 1_800_000_003), pulse]);
  owner.dispose();
  live.receive([pulse]);
  expect(snapshot()).toEqual([]);
  expect(dispose).toHaveBeenCalledTimes(1);
  for (const stop of stops) stop();
  view.dispose();
  expect(vi.getTimerCount()).toBe(0);
  const other = createRelaySession(null);
  expect(other.session.typing.snapshot()).toEqual([]);
  other.dispose();
});

it("a synchronous typing listener cannot reseed retained views after disposal", () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  live.state({ status: "connected", routes: [] });
  live.receive([roster(relay, "a", [viewer.pubkey])]);
  const at = Math.floor(Date.now() / 1000);
  const pulse = signed(agent, {
    kind: 20002,
    content: "",
    created_at: at,
    tags: [["h", "a"]],
  });
  live.receive([pulse]);
  const view = owner.session.observe([{ kinds: [9], "#h": ["a"], limit: 10 }]);
  owner.session.typing.subscribe(() => owner.dispose());
  live.receive([
    signed(agent, {
      kind: 9,
      content: "fixture",
      created_at: at,
      tags: [["h", "a"]],
    }),
  ]);
  expect(view.snapshot().events).toEqual([]);
  expect(owner.session.typing.snapshot()).toEqual([]);
});
