import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";

/** Real HTTP setup/response cancellation and production subscriber; only upstream
 * WS I/O is substituted. No Keychain access or network outside localhost. */
async function harness(
  refuseAt = 0,
  reason = "rate-limited: quota exceeded; retry in 0s",
) {
  const key = new Uint8Array(32);
  key[31] = 1;
  const requests = [];
  const sockets = [];
  const frames = [];
  let handler;
  const server = createServer((req, res) => handler?.(req, res));
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    authority: async () => ({ relayAuthor: getPublicKey(key) }),
    upstreamFetch: async () => Response.json([]),
    socketFactory: () => {
      const socket = {
        readyState: 1,
        send(text) {
          const [kind, id, filter] = JSON.parse(text);
          frames.push({ kind, id, filter, socket, at: performance.now() });
          if (kind === "AUTH")
            queueMicrotask(() => this.receive(["OK", id.id, true]));
          if (kind !== "REQ") return;
          requests.push({ at: performance.now(), filter, socket });
          const refused = requests.length === refuseAt;
          queueMicrotask(() =>
            this.receive(refused ? ["CLOSED", id, reason] : ["EOSE", id]),
          );
        },
        receive(frame) {
          if (this.readyState === 1)
            return this.onmessage?.({ data: JSON.stringify(frame) });
        },
        close() {
          this.readyState = 3;
          this.onclose?.();
        },
      };
      sockets.push(socket);
      queueMicrotask(() => socket.receive(["AUTH", "fixture"]));
      return socket;
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb) {
        handler = cb;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  return {
    sockets,
    frames,
    key,
    requests,
    base,
    async post(channels, origin = base) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/api/relay/stream`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ channels }),
        signal: controller.signal,
      });
      return { response, abort: () => controller.abort() };
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Local HTTP fixture did not reach expected state");
}

test("POST replacement and a second stream share cooldown and paced starts; response close disposes WS", async () => {
  const h = await harness(1);
  try {
    const first = await h.post(["a", "b"]);
    expect(first.response.status).toBe(200);
    // WebKit must not wait for a later heartbeat to receive the last SSE frame.
    expect(first.response.headers.get("transfer-encoding")).toBeNull();
    expect(first.response.headers.get("connection")).toBe("close");
    await until(() => h.requests.length === 1);
    const second = await h.post(["c", "d"]);
    expect(second.response.status).toBe(200);
    first.abort();
    await until(() => h.sockets[0].readyState === 3);
    const replacement = await h.post(["a", "b", "e"]);
    expect(replacement.response.status).toBe(200);
    await delay(300);
    expect(h.requests).toHaveLength(1);
    await until(() => h.requests.length >= 4);
    // A local quota refusal with a zero-second hint still has a rounding margin.
    expect(h.requests[1].at - h.requests[0].at).toBeGreaterThanOrEqual(990);
    for (let i = 2; i < h.requests.length; i++)
      expect(h.requests[i].at - h.requests[i - 1].at).toBeGreaterThanOrEqual(
        240,
      );
    second.abort();
    replacement.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
  } finally {
    await h.close();
  }
});

test("real HTTP accepts the 1022-channel body and rejects invalid/oversized/origin inputs before WS allocation", async () => {
  const h = await harness();
  try {
    const channels = Array.from(
      { length: 1022 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const large = await h.post(channels);
    expect(large.response.status).toBe(200);
    expect(large.response.headers.get("content-type")).toBe(
      "text/event-stream",
    );
    large.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
    const count = h.sockets.length;
    for (const invalid of [[""], Array(1025).fill("a"), ["x".repeat(150001)]]) {
      const { response } = await h.post(invalid);
      expect([400, 413]).toContain(response.status);
      await response.text();
    }
    const denied = await h.post(["a"], "https://other.invalid");
    expect(denied.response.status).toBe(403);
    expect(h.sockets).toHaveLength(count);
  } finally {
    await h.close();
  }
});

test.each([
  "rate-limited: quota exceeded; retry in 0s",
  "temporary: fixture read unavailable",
])(
  "actual browser transport retry preserves healthy routes (%s)",
  async (reason) => {
    const h = await harness(5, reason);
    const nativeFetch = globalThis.fetch;
    let traffic;
    try {
      vi.stubGlobal("fetch", (input, init) =>
        nativeFetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(init?.method === "POST" ? { Origin: h.base } : {}),
          },
        }),
      );
      const transport = await connectBrokerTransport(h.base);
      let snapshot;
      traffic = transport.subscribe({
        receive() {},
        established() {},
        denied() {},
        state(value) {
          snapshot = value;
        },
      });
      traffic.update(["a", "b", "c"]);
      await until(() =>
        snapshot?.routes.some((r) => r.channelId === "c" && r.error),
      );
      expect(snapshot.routes.filter((r) => r.status === "live")).toHaveLength(
        4,
      );
      const sockets = h.sockets.length;
      const healthySocket = h.sockets.at(-1);
      traffic.retry();
      traffic.retry(); // Duplicate clicks coalesce the control request.
      await until(() => snapshot.routes.every((r) => r.status === "live"));
      expect(h.sockets).toHaveLength(sockets);
      expect(healthySocket.readyState).toBe(1);
      expect(h.requests.map((r) => r.filter["#h"]?.[0] ?? "global")).toEqual([
        "global",
        "global",
        "a",
        "b",
        "c",
        "c",
      ]);
      traffic.dispose();
      await until(() => h.sockets.every((s) => s.readyState === 3));
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test("retry control is bounded, same-origin/community scoped and removed with its response owner", async () => {
  const h = await harness();
  const post = (path, body, origin = h.base) =>
    fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const stream = await h.post(["a"]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    expect(streamId).toMatch(/^[0-9a-f]{32}$/);
    await until(() => h.requests.length === 3);
    for (const [body, status] of [
      [{ streamId: "bad" }, 400],
      [{ streamId: "f".repeat(32) }, 404],
      [{ streamId: "x".repeat(300) }, 413],
    ]) {
      const response = await post("/api/relay/stream-retry", body);
      expect(response.status).toBe(status);
      await response.text();
    }
    const cross = await post(
      "/api/relay/stream-retry",
      { streamId },
      "https://evil.invalid",
    );
    expect(cross.status).toBe(403);
    const other = "https://other.invalid";
    await (await post("/api/relay/register", { url: other })).text();
    const wrongScope = await post(
      `/api/relay/${encodeURIComponent(other)}/stream-retry`,
      { streamId },
    );
    expect(wrongScope.status).toBe(404);
    expect(h.sockets).toHaveLength(1);
    const valid = await post("/api/relay/stream-retry", { streamId });
    expect(valid.status).toBe(200);
    await valid.text();
    expect(h.requests).toHaveLength(3); // No healthy route restarts.
    stream.abort();
    await until(() => h.sockets[0].readyState === 3);
    const stale = await post("/api/relay/stream-retry", { streamId });
    expect(stale.status).toBe(404);
  } finally {
    await h.close();
  }
});

test("current demand reaches the front of a large roster without replacing its POST or healthy globals", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    const fetcher = vi.fn((input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe({
      receive() {},
      established() {},
      denied() {},
      state() {},
    });
    const ids = Array.from(
      { length: 128 },
      (_, i) => `channel-${String(i).padStart(3, "0")}`,
    );
    traffic.prioritize([ids[127]]);
    traffic.update(ids);
    await until(() => h.requests.length >= 3);
    expect(
      h.requests.slice(0, 3).map((r) => r.filter["#h"]?.[0] ?? "global"),
    ).toEqual(["global", "global", ids[127]]);
    const sockets = h.sockets.length;
    const posts = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/stream"),
    ).length;
    traffic.prioritize([ids[126]]);
    traffic.prioritize([ids[125]]);
    await until(() => h.requests.some((r) => r.filter["#h"]?.[0] === ids[125]));
    expect(
      h.requests.findIndex((r) => r.filter["#h"]?.[0] === ids[125]),
    ).toBeLessThan(7);
    expect(h.sockets).toHaveLength(sockets);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(posts);
    expect(h.requests.filter((r) => !r.filter["#h"])).toHaveLength(2);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});
test("priority control cannot allocate interests or bypass owner, origin, community and body bounds", async () => {
  const h = await harness();
  try {
    const opened = await h.post(["a"]);
    const streamId = opened.response.headers.get("x-buzz-live-id");
    const control = (
      body,
      path = "/api/relay/stream-priority",
      origin = h.base,
    ) =>
      fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      { streamId, channels: [""] },
      { streamId, channels: Array(65).fill("a") },
      { streamId: "bad", channels: ["a"] },
    ])
      expect((await control(body)).status).toBe(400);
    expect(
      (
        await control(
          { streamId, channels: ["a"] },
          "/api/relay/secondary/stream-priority",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await control(
          { streamId, channels: ["a"] },
          undefined,
          "https://wrong.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (await control({ streamId, channels: ["x".repeat(9001)] })).status,
    ).toBe(413);
    expect(
      (await control({ streamId, channels: ["not-an-interest"] })).status,
    ).toBe(200);
    await until(() => h.requests.length === 3);
    expect(
      h.requests.filter((r) => r.filter["#h"]).map((r) => r.filter["#h"]),
    ).toEqual([["a"]]);
    opened.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
    expect((await control({ streamId, channels: ["a"] })).status).toBe(404);
    expect(h.sockets).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("actual browser/broker presence controls preserve socket and healthy routes; only a correlated WS receipt resolves publication", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    const fetcher = vi.fn((input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const callbacks = {
      receive: vi.fn(),
      state: vi.fn(),
      established: vi.fn(),
      denied: vi.fn(),
      presence: vi.fn(),
      presenceState: vi.fn(),
    };
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    traffic.update(["a"]);
    await until(() => callbacks.established.mock.calls.length === 3);
    const sockets = h.sockets.length;
    const streams = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/stream"),
    ).length;
    const author = getPublicKey(h.key);
    for (let i = 0; i < 1000; i++) traffic.presence.update([author]);
    await until(
      () => callbacks.presenceState.mock.lastCall?.[0].status === "ready",
    );
    const route = h.frames.find(
      (f) => f.kind === "REQ" && f.filter.kinds[0] === 20001,
    );
    expect(route.filter).toEqual({
      kinds: [20001],
      authors: [author],
      limit: 0,
    });
    const event = finalizeEvent(
      {
        kind: 20001,
        content: "online",
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
      },
      h.key,
    );
    await route.socket.receive(["EVENT", route.id, event]);
    await until(() => callbacks.presence.mock.calls.length === 1);
    expect(callbacks.receive).not.toHaveBeenCalled();
    expect(callbacks.established).toHaveBeenCalledTimes(3);
    // Coalesced A -> B -> A must return to Ready even though the server union never changed.
    traffic.presence.update(["f".repeat(64)]);
    traffic.presence.update([author]);
    expect(callbacks.presenceState.mock.lastCall?.[0].status).toBe("pending");
    await until(
      () => callbacks.presenceState.mock.lastCall?.[0].status === "ready",
    );
    const completed = vi.fn();
    const operation = traffic.presence
      .publish("away", new AbortController().signal)
      .then(completed);
    await until(() => h.frames.some((f) => f.kind === "EVENT"));
    const frame = h.frames.find((f) => f.kind === "EVENT");
    expect(frame.id).toMatchObject({
      kind: 20001,
      content: "away",
      tags: [],
      pubkey: author,
    });
    await frame.socket.receive(["OK", "wrong-id", true]);
    await delay(20);
    expect(completed).not.toHaveBeenCalled();
    await frame.socket.receive(["OK", frame.id.id, true]);
    await operation;
    expect(completed).toHaveBeenCalledOnce();
    traffic.presence.update([]);
    await until(() =>
      h.frames.some((f) => f.kind === "CLOSE" && f.id === route.id),
    );
    expect(h.sockets).toHaveLength(sockets);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(streams);
    expect(h.requests.filter((r) => r.filter.kinds[0] !== 20001)).toHaveLength(
      3,
    );
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/stream-presence"),
      ),
    ).toHaveLength(3);
    expect(
      fetcher.mock.calls.some(([url]) =>
        /\/(events|publish|sign)$/.test(String(url)),
      ),
    ).toBe(false);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("presence controls enforce origin, owner, community, shape and body bounds without extra sockets/signing", async () => {
  const h = await harness();
  const post = (path, body, origin = h.base) =>
    fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const stream = await h.post([]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    const author = getPublicKey(h.key);
    await until(() => h.requests.length === 2);
    for (const [path, body, code] of [
      ["stream-presence", { streamId, authors: ["bad"] }, 400],
      ["stream-presence", { streamId, authors: Array(257).fill(author) }, 400],
      ["stream-presence", { streamId, authors: ["x".repeat(18001)] }, 413],
      ["stream-presence-publish", { streamId, status: "offline" }, 400],
      [
        "stream-presence-publish",
        { streamId, status: { status: "online" } },
        400,
      ],
      ["stream-presence-publish", { streamId, status: "x".repeat(300) }, 413],
      [
        "stream-presence-publish",
        { streamId: "f".repeat(32), status: "online" },
        404,
      ],
    ])
      expect((await post(`/api/relay/${path}`, body)).status).toBe(code);
    for (const path of ["stream-presence", "stream-presence-publish"]) {
      const body = { streamId, authors: [author], status: "online" };
      expect(
        (await post(`/api/relay/${path}`, body, "https://wrong.invalid"))
          .status,
      ).toBe(403);
      expect((await post(`/api/relay/secondary/${path}`, body)).status).toBe(
        404,
      );
    }
    expect(h.sockets).toHaveLength(1);
    expect(h.frames.some((f) => f.kind === "EVENT")).toBe(false);
    expect(h.requests).toHaveLength(2);
    stream.abort();
    await until(() => h.sockets[0].readyState === 3);
    expect(
      (
        await post("/api/relay/stream-presence", {
          streamId,
          authors: [author],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post("/api/relay/stream-presence-publish", {
          streamId,
          status: "online",
        })
      ).status,
    ).toBe(404);
  } finally {
    await h.close();
  }
});

test("broker publication cancellation frees its owner and quota rejection remains unconfirmed with no retry", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    vi.stubGlobal("fetch", (input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    const transport = await connectBrokerTransport(h.base);
    let ready = 0;
    traffic = transport.subscribe({
      receive() {},
      state() {},
      established() {
        ready++;
      },
      denied() {},
    });
    await until(() => ready === 2);
    const controller = new AbortController();
    const operation = traffic.presence.publish("online", controller.signal);
    const failure = expect(operation).rejects.toThrow();
    await until(() => h.frames.some((f) => f.kind === "EVENT"));
    controller.abort();
    await failure;
    await delay(50); // Let HTTP close cancellation reach the server owner.
    const second = traffic.presence.publish(
      "away",
      new AbortController().signal,
    );
    const rejected = expect(second).rejects.toThrow("unconfirmed");
    await until(() => h.frames.filter((f) => f.kind === "EVENT").length === 2);
    const frame = h.frames.filter((f) => f.kind === "EVENT")[1];
    await frame.socket.receive([
      "OK",
      frame.id.id,
      false,
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    await rejected;
    await delay(1100);
    expect(h.frames.filter((f) => f.kind === "EVENT")).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});
