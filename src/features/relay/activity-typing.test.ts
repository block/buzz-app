import { expect, it } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { keypair, roster, scriptedTransport, signed } from "./testing";

it("live typing is owner-recognized and self-suppressed, bypasses history/read views, and loses access before a mixed batch", async () => {
  const viewer = keypair(),
    agent = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let generation = 0;
  const owner = createRelaySession({
    ...wire.transport,
    agentActivity: true,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        observe(next) {
          generation = next ?? 0;
        },
      };
    },
  });
  const state = () =>
    live.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
  const now = Math.floor(Date.now() / 1000);
  const make = (key = agent) =>
    signed(key, {
      kind: 20002,
      content: "",
      created_at: now,
      tags: [
        ["h", "a"],
        ["e", "a".repeat(64), "", "reply"],
      ],
    });
  const recognize = (key = agent) =>
    live.observer?.(
      {
        id: key.pubkey,
        agent: key.pubkey,
        createdAt: now,
        plaintext: JSON.stringify({
          kind: "turn_liveness",
          channelId: "a",
          turnId: key.pubkey,
          timestamp: new Date().toISOString(),
        }),
      },
      generation,
    );
  try {
    live.receive([roster(relay, "a", [viewer.pubkey, agent.pubkey])]);
    const release = owner.session.agentActivity.activate();
    state();
    recognize();
    recognize(viewer);
    const view = owner.session.observe([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    live.receive([make(), make(viewer)]);
    expect(
      owner.session.agentActivity.snapshot().typing.map((entry) => entry.agent),
    ).toEqual([agent.pubkey]);
    expect(view.snapshot().events).toEqual([]);
    expect(JSON.stringify(owner.session.channels.window("a"))).not.toContain(
      make().id,
    );
    const read = owner.session.read([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    wire.next().respond([make()]);
    expect(await read).toEqual([]);
    release();
    const activate = owner.session.agentActivity.activate();
    state();
    recognize();
    // Finite reads must not seed either history or typing after a reset.
    const finite = owner.session.read([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    wire.next().respond([make()]);
    expect(await finite).toEqual([]);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    live.receive([make(), roster(relay, "a", [agent.pubkey], now + 1)]);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    activate();
    view.dispose();
  } finally {
    owner.dispose();
  }
});
