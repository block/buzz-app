import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import type { HeadPersistence, SavedHead, SavedStartup } from "./persistence";
import type { ReadTransport } from "./transport";
import { ReadError } from "./errors";
import { bounds, keypair, message, metadata, roster } from "./testing";
import { provideRelay } from "./service";

const storage = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./persistence", () => ({ createHeadPersistence: storage.create }));
const roots: Context[] = [];
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup({
  saved = true,
  gate,
}: {
  saved?: boolean;
  gate?: import("./service").RelayGate;
} = {}) {
  const viewer = keypair(),
    relay = keypair();
  const events = [
    roster(relay, "alpha", [viewer.pubkey]),
    metadata(relay, "alpha", "Alpha"),
  ];
  let startup: SavedStartup | undefined = saved
    ? { discovery: { savedAt: Date.now(), relayAuthor: relay.pubkey, events } }
    : undefined;
  let heads: SavedHead[] = !saved
    ? []
    : [
        {
          channelId: "alpha",
          savedAt: Date.now(),
          profiles: [],
          events: [
            message(viewer, "alpha", "Saved history", 20),
            bounds(relay, "alpha", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ],
        },
      ];
  const disk: HeadPersistence = {
    readStartup: vi.fn(async () => structuredClone(startup)),
    writeStartup: vi.fn(async (patch) => {
      startup = { ...startup, ...structuredClone(patch) };
    }),
    read: vi.fn(async () => structuredClone(heads)),
    write: vi.fn(async () => {}),
    remove: vi.fn(async (id) => {
      heads = heads.filter((h) => h.channelId !== id);
    }),
    retain: vi.fn(async (ids) => {
      heads = heads.filter((h) => ids.includes(h.channelId));
    }),
    clear: vi.fn(async () => {
      startup = undefined;
      heads = [];
    }),
    close: vi.fn(),
  };
  storage.create.mockImplementation(() => disk);
  const connections: ReturnType<typeof deferred<ReadTransport>>[] = [];
  const ctx = new Context();
  roots.push(ctx);
  const source: ReadTransport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: "primary",
    subscribe: vi.fn(() => ({
      update: () => {},
      retry: () => {},
      dispose: vi.fn(),
    })),
    media: () => undefined,
    query: vi.fn(async (filters: readonly import("./events").ReadFilter[]) =>
      filters.some((f) => f.kinds?.includes(39002)) ? events : [],
    ),
  };
  const data = provideRelay(
    ctx,
    () => {
      const request = deferred<ReadTransport>();
      connections.push(request);
      return request.promise;
    },
    undefined,
    undefined,
    undefined,
    { viewer: viewer.pubkey, scope: "primary" },
    undefined,
    gate,
  );
  const restored = async () => {
    await vi.waitFor(() => expect(data.snapshot().cached).toBe(true));
    data.snapshot().session.channels.ensure("alpha");
    expect(
      data.snapshot().session.channels.window("alpha").rows[0]?.content,
    ).toBe("Saved history");
    return data.snapshot();
  };
  return { ctx, data, disk, connections, source, restored };
}
it("resumes and connects one partition: heads keep `viewer:origin`, snapshots `origin:viewer`", async () => {
  const { data, connections, source, restored } = setup();
  const viewer = source.viewer;
  expect((await restored()).scope).toBe(`primary:${viewer}`);
  await vi.waitFor(() => expect(connections).toHaveLength(1));
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  expect(data.snapshot().scope).toBe(`primary:${viewer}`);
  // Resume and the live session open the same head partition argument order.
  expect(storage.create.mock.calls).toEqual([
    [viewer, "primary"],
    [viewer, "primary"],
  ]);
});
it("retains a timed-out cached startup, rejects the late handshake and promotes a retry without changing generation", async () => {
  vi.useFakeTimers();
  const { data, connections, source, restored } = setup();
  const before = await restored();
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot()).toMatchObject({
    status: "error",
    cached: true,
    error: expect.stringContaining("timed out"),
    // A timeout reconnects by itself; navigation waits instead of failing.
    retrying: true,
  });
  data.retry();
  expect(data.snapshot().retrying).toBeUndefined();
  await vi.waitFor(() => expect(connections).toHaveLength(2));
  connections[0]?.resolve(source);
  await vi.advanceTimersByTimeAsync(10);
  expect(data.snapshot().session).toBe(before.session);
  connections[1]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().cached).toBeUndefined());
  expect(data.snapshot().generation).toBe(before.generation);
  expect(data.snapshot().scope).toBe(before.scope);
  expect(data.snapshot().session).not.toBe(before.session);
  expect(
    data.snapshot().session.channels.window("alpha").rows[0]?.content,
  ).toBe("Saved history");
});
it("bootstraps from disk behind the launch surface only once, not on retries after a failure", async () => {
  vi.useFakeTimers();
  const { data } = setup({ saved: false });
  expect(data.snapshot()).toMatchObject({
    status: "connecting",
    restoring: true,
  });
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot()).toMatchObject({ status: "error", retrying: true });
  // Both the automatic reconnect and Try again keep the app on screen.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(data.snapshot().status).toBe("connecting");
  expect(data.snapshot().restoring).toBeUndefined();
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot().status).toBe("error");
  data.retry();
  expect(data.snapshot().status).toBe("connecting");
  expect(data.snapshot().restoring).toBeUndefined();
});
it("explicit handshake denial purges saved history instead of retaining offline content", async () => {
  const { data, disk, connections, restored } = setup();
  await restored();
  connections[0]?.reject(new ReadError("denied", "Removed"));
  await vi.waitFor(() => expect(data.snapshot().status).toBe("error"));
  expect(data.snapshot().cached).toBeUndefined();
  expect(data.snapshot().retrying).toBeUndefined();
  // Pages explain a refusal as access, not as the connection.
  expect(data.snapshot().denied).toBe(true);
  expect(data.snapshot().session.channels.list().channels).toEqual([]);
  expect(await disk.readStartup?.()).toBeUndefined();
  expect(await disk.read()).toEqual([]);
});
it("clearing during successor hydration fences the old result and clears next-launch records", async () => {
  const { data, disk, connections, source, restored } = setup();
  await restored();
  const stale = await disk.read();
  const hydration = deferred<SavedHead[]>();
  vi.mocked(disk.read).mockReturnValueOnce(hydration.promise);
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(disk.read).toHaveBeenCalledTimes(3));
  await data.clearCache();
  hydration.resolve(stale);
  await vi.waitFor(() => expect(connections).toHaveLength(2));
  expect(data.snapshot().session.channels.list().channels).toEqual([]);
  expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
  expect(await disk.readStartup?.()).toBeUndefined();
  expect(await disk.read()).toEqual([]);
});
it("a different viewer or relay scope does not receive retained cached windows", async () => {
  const { data, connections, source, restored } = setup();
  const before = await restored();
  storage.create.mockImplementation(() => ({
    read: async () => [],
    readStartup: async () => undefined,
    close() {},
  }));
  connections[0]?.resolve({
    ...source,
    viewer: keypair().pubkey,
    scope: "other",
    query: async () => [],
  });
  await vi.waitFor(() => expect(data.snapshot().cached).toBeUndefined());
  expect(data.snapshot().scope).not.toBe(before.scope);
  expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
});
it("disposal while local storage is still reading never publishes the restored session", async () => {
  const { ctx, data, disk, connections, source } = setup();
  const saved = await disk.readStartup?.();
  // The service has started its initial read; hold the session's subsequent reads.
  const reading = deferred<SavedStartup | undefined>();
  if (!disk.readStartup) throw new Error("Missing startup reader");
  vi.mocked(disk.readStartup).mockReturnValue(reading.promise);
  await ctx.fiber.dispose();
  const snapshot = data.snapshot();
  reading.resolve(saved);
  connections[0]?.resolve(source);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(data.snapshot()).toBe(snapshot);
});

it.each(["success", "failure"])(
  "cache clear blocks retries after aborted connection %s settles",
  async (outcome) => {
    const { data, disk, connections, source, restored } = setup();
    await restored();
    const gate = deferred<void>();
    const erase = disk.clear.bind(disk);
    vi.mocked(disk.clear).mockImplementationOnce(async () => {
      await gate.promise;
      await erase();
    });
    const cleared = data.clearCache();
    expect(data.clearCache()).toBe(cleared);
    await vi.waitFor(() => expect(disk.clear).toHaveBeenCalled());
    if (outcome === "success") connections[0]?.resolve(source);
    else connections[0]?.reject(new Error("aborted connection failed"));
    // Drain the connection's then/catch/finally before attempting retry.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    data.retry();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(connections).toHaveLength(1);
    expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
    gate.resolve();
    await cleared;
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    connections[1]?.resolve(source);
    await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
    expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
    expect(await disk.read()).toEqual([]);
  },
);
it("disconnect during a coalesced cache clear does not reconnect", async () => {
  const { data, disk, connections, restored } = setup();
  await restored();
  const gate = deferred<void>();
  vi.mocked(disk.clear).mockImplementationOnce(() => gate.promise);
  const cleared = data.clearCache();
  await vi.waitFor(() => expect(disk.clear).toHaveBeenCalled());
  data.disconnect();
  gate.resolve();
  await cleared;
  expect(data.snapshot().status).toBe("disconnected");
  expect(connections).toHaveLength(1);
});

function organization(admitted: boolean, protects = true) {
  const listeners = new Set<() => void>();
  const gate = {
    protects: () => Promise.resolve(protects),
    admits: () => admitted,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const admit = (next: boolean) => {
    admitted = next;
    for (const listener of listeners) listener();
  };
  return { gate, admit };
}
it("keeps saved history out of memory while admission takes longer than eight seconds", async () => {
  vi.useFakeTimers();
  const { gate, admit } = organization(false);
  const { data, disk, connections, source } = setup({ gate });
  await vi.waitFor(() => expect(data.snapshot().locked).toBe(true));
  expect(data.snapshot()).toMatchObject({ status: "error" });
  expect(data.snapshot().cached).toBeUndefined();
  expect(data.snapshot().session.channels.list().channels).toEqual([]);
  expect(disk.clear).not.toHaveBeenCalled();
  // A live transport can start authentication without hydrating its cache.
  await vi.waitFor(() => expect(connections).toHaveLength(1));
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(gate.subscribe).toHaveBeenCalledTimes(2));
  expect(disk.readStartup).not.toHaveBeenCalled();
  expect(disk.read).not.toHaveBeenCalled();
  expect(data.snapshot().locked).toBe(true);
  expect(connections).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot().error).not.toContain("timed out");
  expect(disk.readStartup).not.toHaveBeenCalled();
  expect(disk.read).not.toHaveBeenCalled();

  admit(true);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  if (!source.subscribe) throw new Error("Missing live fixture");
  expect(
    vi.mocked(source.subscribe).mock.results[0]?.value.dispose,
  ).toHaveBeenCalledOnce();
  expect(data.snapshot().locked).toBeUndefined();
  data.snapshot().session.channels.ensure("alpha");
  expect(
    data.snapshot().session.channels.window("alpha").rows[0]?.content,
  ).toBe("Saved history");
});
it("locks an open organization community when its session ends, keeping the disk", async () => {
  const { gate, admit } = organization(true);
  const { data, disk, connections, source, restored } = setup({ gate });
  await restored();
  await vi.waitFor(() => expect(connections).toHaveLength(1));
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));

  admit(false);
  expect(data.snapshot()).toMatchObject({ status: "error", locked: true });
  expect(data.snapshot().session.channels.list().channels).toEqual([]);
  expect(disk.clear).not.toHaveBeenCalled();
  expect(await disk.readStartup?.()).toBeDefined();
});
it("leaves a community outside the organization alone", async () => {
  const { gate } = organization(false, false);
  const { data, restored } = setup({ gate });
  await restored();
  expect(data.snapshot().locked).toBeUndefined();
});

it("disconnect closes a pending admission socket without loading saved history", async () => {
  const { gate, admit } = organization(false);
  const { data, disk, connections, source } = setup({ gate });
  await vi.waitFor(() => expect(connections).toHaveLength(1));
  connections[0]?.resolve(source);
  if (!source.subscribe) throw new Error("Missing live fixture");
  await vi.waitFor(() => expect(source.subscribe).toHaveBeenCalledOnce());
  const proof = vi.mocked(source.subscribe).mock.results[0]?.value;
  data.disconnect();
  await vi.waitFor(() => expect(proof.dispose).toHaveBeenCalledOnce());
  admit(true);
  expect(data.snapshot().status).toBe("disconnected");
  expect(disk.readStartup).not.toHaveBeenCalled();
  expect(disk.read).not.toHaveBeenCalled();
});

it("does not load saved state when admission is revoked before its continuation runs", async () => {
  const { gate, admit } = organization(false);
  const { data, disk, connections, source } = setup({ gate });
  await vi.waitFor(() => expect(connections).toHaveLength(1));
  connections[0]?.resolve(source);
  if (!source.subscribe) throw new Error("Missing live fixture");
  await vi.waitFor(() => expect(source.subscribe).toHaveBeenCalledOnce());
  const proof = vi.mocked(source.subscribe).mock.results[0]?.value;
  admit(true);
  admit(false);
  await vi.waitFor(() => expect(proof.dispose).toHaveBeenCalledOnce());
  expect(data.snapshot().locked).toBe(true);
  expect(disk.readStartup).not.toHaveBeenCalled();
  expect(disk.read).not.toHaveBeenCalled();
  expect(source.subscribe).toHaveBeenCalledOnce();
});

it("ends the connection deadline before a slow ordinary cache restore", async () => {
  vi.useFakeTimers();
  const { gate } = organization(false, false);
  const { data, disk, connections, source } = setup({ gate });
  const startup = deferred<SavedStartup | undefined>();
  if (!disk.readStartup) throw new Error("Missing startup fixture");
  vi.mocked(disk.readStartup).mockImplementationOnce(() => startup.promise);
  try {
    await vi.waitFor(() => expect(disk.readStartup).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]?.resolve(source);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(data.snapshot().error).not.toContain("timed out");
  } finally {
    startup.resolve(undefined);
  }
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
});

it.each(["retry", "focus"])(
  "rechecks unknown protection during pending admission on %s",
  async (trigger) => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    let known: boolean | undefined;
    let announced = false;
    const listeners = new Set<() => void>();
    const gate = {
      protects: vi.fn(async () => {
        if (known !== undefined && !announced) {
          announced = true;
          for (const listener of listeners) listener();
        }
        return known;
      }),
      admits: () => known === false,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const { data, disk, connections, source } = setup({ gate });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]?.resolve(source);
    await vi.waitFor(() => expect(source.subscribe).toHaveBeenCalledOnce());
    expect(disk.readStartup).not.toHaveBeenCalled();
    known = false;
    if (trigger === "retry") data.retry();
    else window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
    expect(connections).toHaveLength(1);
  },
);

it("backs off repeated policy bounces even when each AUTH succeeds", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { gate, admit } = organization(true);
  const { data, disk, connections, source, restored } = setup({
    gate: { ...gate, canConnect: () => true },
  });
  try {
    await restored();
    connections[0]?.resolve(source);
    await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
    for (const [index, delay] of [750, 1500].entries()) {
      const reads = vi.mocked(disk.read).mock.calls.length;
      admit(false);
      expect(data.snapshot().locked).toBe(true);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(connections).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toHaveLength(index + 2);
      connections[index + 1]?.resolve(source);
      await vi.waitFor(() =>
        expect(gate.subscribe).toHaveBeenCalledTimes(index + 2),
      );
      expect(vi.mocked(disk.read).mock.calls.length).toBe(reads);
      admit(true);
      await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
    }
  } finally {
    random.mockRestore();
  }
});
