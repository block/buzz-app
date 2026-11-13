import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ReadError } from "./errors";
import { provideRelay } from "./service";
import type { ReadTransport } from "./transport";
import {
  flush,
  keypair,
  metadata,
  roster,
  bounds,
  scriptedTransport,
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
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
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
  // The connection deadline and the wake detector.
  expect(vi.getTimerCount()).toBe(2);
  await ctx.fiber.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("reconnects a connection the federated session refused once it is signed in", async () => {
  const ctx = root();
  const connect = vi
    .fn<() => Promise<ReadTransport>>()
    .mockRejectedValueOnce(new Error("Federated sign-in is required"))
    .mockResolvedValue(transport("viewer"));
  const data = provideRelay(ctx, connect);
  await flush();
  expect(data.snapshot().status).toBe("error");
  data.reauthorize();
  await flush();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(data.snapshot().status).toBe("ready");
});
it("makes Try again ask the issuer again for a refused connection before reconnecting", async () => {
  const ctx = root();
  const order: string[] = [];
  const listeners = new Set<(kind: "sign-in" | "access") => void>();
  const connect = vi.fn(async (): Promise<ReadTransport> => {
    order.push("connect");
    return {
      ...transport("viewer"),
      scope: "https://relay.example",
      observeRefusal(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
  });
  const askAgain = vi.fn(async (relay: string) => {
    order.push(`ask again ${relay}`);
  });
  const data = provideRelay(
    ctx,
    connect,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    askAgain,
  );
  await flush();
  for (const listener of [...listeners]) listener("access");
  await flush();
  expect(data.snapshot()).toMatchObject({ status: "error", denied: true });
  // An automatic reconnect does not ask.
  data.retry();
  await flush();
  expect(askAgain).not.toHaveBeenCalled();
  for (const listener of [...listeners]) listener("access");
  await flush();
  data.tryAgain();
  // The attempt starts at once, so a route retried next sees it under way.
  expect(data.snapshot().status).toBe("connecting");
  // A second press while it runs joins it, but still asks, so an attempt
  // already past its own ask can't repeat a cached refusal.
  data.tryAgain();
  await flush();
  const ask = `ask again ${data.snapshot().origin}`;
  expect(order).toEqual(["connect", "connect", ask, ask, "connect"]);
  expect(data.snapshot().origin).toMatch(/relay\.example/);
  expect(data.snapshot().status).toBe("ready");
});
it("makes Try again on a ready connection retry what failed, without reconnecting", async () => {
  const ctx = root();
  const connect = vi.fn(async () => transport("viewer"));
  const askAgain = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const data = provideRelay(
    ctx,
    connect,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    askAgain,
  );
  await flush();
  const recovery = data.snapshot().session.recovery;
  expect(recovery?.snapshot().reauthorized ?? 0).toBe(0);
  data.tryAgain();
  await flush();
  // A failed ask still retries: every failed read and the live socket.
  expect(askAgain).toHaveBeenCalledOnce();
  expect(recovery?.snapshot().reauthorized).toBe(1);
  expect(connect).toHaveBeenCalledTimes(1);
});
it("keeps what a failed connection means, not an exception's words, in the snapshot", async () => {
  vi.useFakeTimers();
  const connect = vi
    .fn<() => Promise<ReadTransport>>()
    .mockRejectedValueOnce(
      new ReadError("unavailable", "Relay read failed (502)", 502),
    )
    .mockRejectedValueOnce(
      new ReadError("denied", "Relay read failed (403)", 403),
    );
  const data = provideRelay(root(), connect);
  await vi.advanceTimersByTimeAsync(0);
  // A 502 can clear without anyone acting, so the service keeps trying.
  expect(data.snapshot()).toMatchObject({
    status: "error",
    retrying: true,
    error: {
      kind: "connection",
      details: "ReadError: Relay read failed (502)",
    },
  });
  expect(data.snapshot().denied).toBeUndefined();
  await vi.advanceTimersByTimeAsync(30_000);
  // A refusal waits for the person.
  expect(data.snapshot()).toMatchObject({
    status: "error",
    denied: true,
    error: { kind: "refused", details: "ReadError: Relay read failed (403)" },
  });
  expect(data.snapshot().retrying).toBeUndefined();
});
it("asks again slowly, and on focus, after an answer this Buzz can't use", async () => {
  vi.useFakeTimers();
  // Hints arrive from the window; this file runs without a DOM.
  vi.stubGlobal("window", new EventTarget());
  try {
    const notFound = () =>
      new ReadError("unavailable", "Relay read failed (404)", 404);
    const connect = vi
      .fn<() => Promise<ReadTransport>>()
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValue(transport("viewer"));
    const data = provideRelay(root(), connect);
    await vi.advanceTimersByTimeAsync(0);
    expect(data.snapshot()).toMatchObject({
      status: "error",
      error: {
        kind: "unusable",
        details: "ReadError: Relay read failed (404)",
      },
    });
    // Its copy says an update may fix it, never "We’ll keep trying".
    expect(data.snapshot().retrying).toBeUndefined();
    // An edge answering during a relay deploy clears, so it is asked again,
    // first after 30 s, then less often.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(data.snapshot()).toMatchObject({
      status: "error",
      error: { kind: "unusable" },
    });
    expect(data.snapshot().retrying).toBeUndefined();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(connect).toHaveBeenCalledTimes(2);
    // Coming back to the window asks now, with nothing cached.
    expect(data.snapshot().cached).toBeUndefined();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(data.snapshot().status).toBe("ready");
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([
  { asked: "after 30 s", ask: () => vi.advanceTimersByTimeAsync(30_000) },
  {
    asked: "on focus",
    ask: async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    },
  },
])(
  "keeps an answer Buzz can't use on screen while it is asked again $asked",
  async ({ ask }) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    try {
      let answer!: {
        resolve(transport: ReadTransport): void;
        reject(error: unknown): void;
      };
      const connect = vi
        .fn<() => Promise<ReadTransport>>()
        .mockRejectedValueOnce(
          new ReadError("unavailable", "Relay read failed (404)", 404),
        )
        .mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              answer = { resolve, reject };
            }),
        );
      const data = provideRelay(root(), connect);
      await vi.advanceTimersByTimeAsync(0);
      const failed = data.snapshot();
      expect(failed).toMatchObject({
        status: "error",
        error: { kind: "unusable" },
      });
      const published: string[] = [];
      data.subscribe(() => published.push(data.snapshot().status));
      await ask();
      expect(connect).toHaveBeenCalledTimes(2);
      // The card, and Check for updates on it, stay put: not "connecting",
      // and not retrying for the App's failed-visit card either.
      expect(data.snapshot()).toBe(failed);
      expect(published).toEqual([]);
      // Another hint while it is asked waits for that answer.
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(data.snapshot()).toBe(failed);
      // The answer replaces it: the same failure again, then success.
      answer.reject(
        new ReadError("unavailable", "Relay read failed (421)", 421),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toEqual(["error"]);
      expect(data.snapshot()).toMatchObject({
        status: "error",
        error: {
          kind: "unusable",
          details: "ReadError: Relay read failed (421)",
        },
      });
      expect(data.snapshot().retrying).toBeUndefined();
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(data.snapshot().status).toBe("error");
      answer.resolve(transport("viewer"));
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toEqual(["error", "ready"]);
      expect(data.snapshot()).toMatchObject({
        status: "ready",
        viewer: "viewer",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it("says it is connecting when the person retries an answer Buzz can't use", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  try {
    const answers: ((transport: ReadTransport) => void)[] = [];
    const connect = vi
      .fn<() => Promise<ReadTransport>>()
      .mockRejectedValueOnce(
        new ReadError("unavailable", "Relay read failed (404)", 404),
      )
      .mockImplementation(
        () => new Promise((resolve) => answers.push(resolve)),
      );
    const data = provideRelay(root(), connect);
    await vi.advanceTimersByTimeAsync(0);
    expect(data.snapshot().status).toBe("error");
    // Asked again in the background, then by the person, who sees it.
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(data.snapshot().status).toBe("error");
    data.tryAgain();
    expect(data.snapshot().status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(3);
    // The background attempt it replaced answers too late to count.
    answers[0]?.(transport("stale"));
    await vi.advanceTimersByTimeAsync(0);
    expect(data.snapshot().status).toBe("connecting");
    answers[1]?.(transport("viewer"));
    await vi.advanceTimersByTimeAsync(0);
    expect(data.snapshot()).toMatchObject({
      status: "ready",
      viewer: "viewer",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("leaves a refusal to the person, even on focus", async () => {
  vi.stubGlobal("window", new EventTarget());
  try {
    const connect = vi
      .fn<() => Promise<ReadTransport>>()
      .mockRejectedValue(
        new ReadError("denied", "Relay read failed (403)", 403),
      );
    const data = provideRelay(root(), connect);
    await flush();
    expect(data.snapshot()).toMatchObject({ status: "error", denied: true });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(connect).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("asks a live socket that may have died during sleep to answer", async () => {
  vi.useFakeTimers();
  const check = vi.fn();
  const source: ReadTransport = {
    ...transport("viewer"),
    subscribe: () => ({ update() {}, retry() {}, check, dispose() {} }),
  };
  const data = provideRelay(root(), async () => source);
  await vi.advanceTimersByTimeAsync(0);
  expect(data.snapshot().status).toBe("ready");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(check).not.toHaveBeenCalled();
  // Timers stop while the machine sleeps, so the clock jumps between ticks.
  vi.setSystemTime(Date.now() + 60_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(check).toHaveBeenCalledTimes(1);
});

it("turns a community refusal heard after connecting into one denied connection", async () => {
  const ctx = root();
  const listeners = new Set<(kind: "sign-in" | "access") => void>();
  const refusing = (): ReadTransport => ({
    ...transport("viewer"),
    scope: "https://relay.example",
    observeRefusal(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
  const connect = vi.fn(async () => refusing());
  const data = provideRelay(ctx, connect);
  await flush();
  expect(data.snapshot().status).toBe("ready");
  const ready = data.snapshot().session;
  for (const listener of [...listeners]) listener("sign-in");
  // A second refusal from the same connection changes nothing.
  for (const listener of [...listeners]) listener("access");
  await flush();
  expect(data.snapshot()).toMatchObject({
    status: "error",
    denied: true,
    refusal: "sign-in",
    viewer: "viewer",
    error: { kind: "refused", details: "Federated sign-in is required" },
  });
  expect(data.snapshot().retrying).toBeUndefined();
  expect(data.snapshot().session).not.toBe(ready);
  // Nothing reconnects by itself; signing in does, and the old connection's
  // listener is gone.
  expect(connect).toHaveBeenCalledTimes(1);
  data.reauthorize();
  await flush();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(data.snapshot().status).toBe("ready");
  expect(listeners.size).toBe(1);
});
