import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, scriptedTransport } from "./testing";
import type { ArtifactSyncSink } from "./artifact-sync";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const filter = { artifact: "current", "#h": ["c1"] };

function harness(artifactSync: boolean) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const sinks: ArtifactSyncSink[] = [];
  const closes = vi.fn();
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    ...(artifactSync ? { artifactSync: true as const } : {}),
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncArtifacts(_filter, sink) {
          sinks.push(sink);
          return closes;
        },
      };
    },
  });
  owners.push(owner);
  return { owner, sinks, closes };
}

it("reports unsupported when the relay does not advertise sync", () => {
  const { owner, sinks } = harness(false);
  const view = owner.session.artifacts.sync(filter);
  expect(view.snapshot().status).toBe("unsupported");
  expect(sinks).toHaveLength(0);
});

it("opens on live traffic and ends every view at session teardown", () => {
  const { owner, sinks, closes } = harness(true);
  const view = owner.session.artifacts.sync(filter);
  expect(sinks).toHaveLength(1);
  expect(view.snapshot().status).toBe("loading");
  nth(sinks, 0).eose();
  expect(view.snapshot().status).toBe("live");
  owner.dispose();
  expect(closes).toHaveBeenCalledOnce();
});

it("refuses a filter the relay would refuse, at the call site", () => {
  const { owner } = harness(true);
  expect(() =>
    owner.session.artifacts.sync({ artifact: "current", limit: 10 }),
  ).toThrow();
});

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
