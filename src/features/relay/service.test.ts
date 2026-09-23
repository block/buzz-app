import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createHeadPersistence } from "./persistence";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay } from "./service";
import type { ReadTransport } from "./transport";
import {
  flush,
  keypair,
  metadata,
  roster,
  bounds,
  scriptedTransport,
  signed,
} from "./testing";

const roots: Context[] = [];
function root() {
  const ctx = new Context();
  roots.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const transport = (viewer: string): ReadTransport => ({
  viewer,
  relayAuthor: "relay",
  media: () => undefined,
  query: vi.fn(async () => []),
});
it("shares a session above plugin lifetimes, rather than one store per consumer", async () => {
  const ctx = root();
  const source = transport("viewer");
  const connect = vi.fn(async () => source);
  const data = provideRelay(ctx, connect);
  await flush();
  const received: unknown[] = [];
  const consumer = ctx.plugin({
    inject: ["relay"],
    apply(scope) {
      received.push(scope.relay.snapshot().session);
    },
  });
  await consumer.await();
  const other = ctx.plugin({
    inject: ["relay"],
    apply(scope) {
      received.push(scope.relay.snapshot().session);
    },
  });
  await other.await();
  expect(received[0]).toBe(received[1]);
  await consumer.dispose();
  expect(data.snapshot().status).toBe("ready");
  expect(connect).toHaveBeenCalledTimes(1);
  expect(source.query).toHaveBeenCalledTimes(1);
});
it("keeps app startup demand-driven while retaining hover preparation and cached opening", async () => {
  const viewer = keypair();
  const relay = keypair();
  const h = scriptedTransport(viewer.pubkey, relay.pubkey);
  const data = provideRelay(root(), async () => h.transport);
  await flush();
  const ids = Array.from({ length: 70 }, (_, index) => `channel-${index}`);
  const discovery = ids.flatMap((id) => [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, id),
  ]);
  h.next().respond(discovery);
  await flush();
  const channels = data.snapshot().session.channels;
  expect(channels.list().channels).toHaveLength(70);
  expect(h.pending).toHaveLength(0);
  channels.refreshList?.();
  h.next().respond(discovery);
  await flush();
  expect(h.pending).toHaveLength(0);

  channels.prepare?.("channel-69");
  const preparation = h.next();
  expect(preparation.filters[0]).toMatchObject({
    "#h": ["channel-69"],
    top_level: true,
  });
  preparation.respond([
    bounds(relay, "channel-69", "head", {
      has_more: false,
      next_cursor: null,
    }),
  ]);
  await flush();
  channels.ensure("channel-69");
  expect(channels.window("channel-69").status).toBe("ready");
  expect(h.pending).toHaveLength(0);
});

it("rejects an old connection result after disconnect and replacement", async () => {
  const ctx = root();
  const pending: ((transport: ReadTransport) => void)[] = [];
  const data = provideRelay(
    ctx,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await flush();
  const old = pending.shift();
  data.disconnect();
  data.retry();
  await flush();
  pending.shift()?.(transport("new"));
  await flush();
  const current = data.snapshot();
  old?.(transport("old"));
  await flush();
  expect(data.snapshot()).toBe(current);
  expect(current.viewer).toBe("new");
});
it("times out a stalled connection and releases timers on app disposal", async () => {
  vi.useFakeTimers();
  const ctx = root();
  const data = provideRelay(ctx, () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot().status).toBe("error");
  data.retry();
  expect(vi.getTimerCount()).toBe(1);
  await ctx.fiber.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["subscriber", "pending"])(
  "clears the original persisted owner despite a %s disconnect",
  async (mode) => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const viewer = keypair(),
      relay = keypair();
    const scope = "https://community.example";
    const disk = createHeadPersistence(viewer.pubkey, scope);
    await disk.write({
      channelId: "alpha",
      savedAt: Date.now(),
      events: [],
      profiles: [],
    });
    const events = [
      roster(relay, "alpha", [viewer.pubkey]),
      metadata(relay, "alpha", "Alpha"),
    ];
    const data = provideRelay(
      root(),
      async () => ({
        ...transport(viewer.pubkey),
        relayAuthor: relay.pubkey,
        scope,
        query: async (filters) =>
          filters.some((filter) => filter.kinds?.includes(39002)) ? events : [],
      }),
      undefined,
      undefined,
      {
        viewer: viewer.pubkey,
        community: scope,
        decode: async () => ({ sections: [], assignments: {}, starred: [] }),
        storage: {
          read: async () => ({
            version: 1,
            viewer: viewer.pubkey,
            community: scope,
            authority: relay.pubkey,
            events,
            profiles: [],
            preferenceEvents: [],
          }),
          write: async () => {},
          clear: async () => {},
          close: () => {},
        },
      },
    );
    await vi.waitFor(() =>
      expect(data.snapshot().presentation?.channels).toHaveLength(1),
    );
    await vi.waitFor(() => expect(data.snapshot().rosterReady).toBe(true));
    let disconnected = false;
    data.subscribe(() => {
      if (
        mode === "subscriber" &&
        !data.snapshot().presentation &&
        !disconnected
      ) {
        disconnected = true;
        data.disconnect();
      }
    });
    const clearing = data.clearCache();
    if (mode === "pending") data.disconnect();
    await clearing;
    expect(data.snapshot().status).toBe("disconnected");
    expect(await disk.read()).toEqual([]);
    disk.close();
  },
);

it("cannot publish a mismatched connection after a clear subscriber disconnects it", async () => {
  const viewer = keypair(),
    relay = keypair();
  const data = provideRelay(
    root(),
    async () => ({
      ...transport(viewer.pubkey),
      scope: "wrong",
      relayAuthor: relay.pubkey,
    }),
    undefined,
    undefined,
    {
      viewer: viewer.pubkey,
      community: "https://expected.example",
      decode: async () => ({ sections: [], assignments: {}, starred: [] }),
      storage: {
        read: async () => null,
        write: async () => {},
        clear: async () => {},
        close: () => {},
      },
    },
  );
  let disconnected = false;
  data.subscribe(() => {
    if (!disconnected && data.snapshot().presentationPending === false) {
      disconnected = true;
      data.disconnect();
    }
  });
  await flush();
  expect(disconnected).toBe(true);
  expect(data.snapshot().status).toBe("disconnected");
});

it("keeps the connection snapshot stable when exact public metadata changes only the session query model", async () => {
  const viewer = keypair(),
    relay = keypair();
  const h = scriptedTransport(viewer.pubkey, relay.pubkey);
  const data = provideRelay(root(), async () => h.transport);
  await flush();
  h.next().respond([
    roster(relay, "alpha", [viewer.pubkey]),
    metadata(relay, "alpha", "Alpha"),
  ]);
  await flush();
  const before = data.snapshot();
  const resolution = before.session.channels.resolve?.(["open"]);
  h.next().respond([
    signed(relay, {
      kind: 39000,
      tags: [["d", "open"], ["name", "Open"], ["public"], ["t", "stream"]],
      content: "",
    }),
  ]);
  await resolution;
  expect(before.session.channels.get?.("open")).toMatchObject({
    id: "open",
    readOnly: true,
  });
  expect(data.snapshot()).toBe(before);
});

it("disconnect never republishes a ready snapshot for the disposed session", async () => {
  const viewer = keypair(),
    relay = keypair();
  const scope = "https://community.example";
  const data = provideRelay(
    root(),
    async () => ({
      ...transport(viewer.pubkey),
      scope,
      relayAuthor: relay.pubkey,
    }),
    undefined,
    undefined,
    {
      viewer: viewer.pubkey,
      community: scope,
      decode: async () => ({ sections: [], assignments: {}, starred: [] }),
      storage: {
        read: async () => ({
          version: 1,
          viewer: viewer.pubkey,
          community: scope,
          authority: relay.pubkey,
          events: [],
          profiles: [],
          preferenceEvents: [],
        }),
        write: async () => {},
        clear: async () => {},
        close: () => {},
      },
    },
  );
  await vi.waitFor(() => expect(data.snapshot().presentation).toBeDefined());
  const old = data.snapshot().session;
  const observed: ReturnType<typeof data.snapshot>[] = [];
  data.subscribe(() => observed.push(data.snapshot()));
  data.disconnect();
  expect(observed.map(({ status }) => status)).toEqual(["disconnected"]);
  expect(observed[0]?.session).not.toBe(old);
  expect(observed[0]?.presentation).toBeUndefined();
});
