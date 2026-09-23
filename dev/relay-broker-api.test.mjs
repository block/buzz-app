import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createOutbox, PublishRejected } from "../src/features/relay/outbox.ts";

// Only wall time is controlled. Real timers/performance.now still exercise HTTP admission.
let wallClock;
beforeEach(() => {
  wallClock = 1700000000999;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock);
});
afterEach(() => vi.restoreAllMocks());

// Real browser HTTP -> production broker. Ephemeral key; upstream I/O is entirely local.
async function harness(respond, capabilities = {}) {
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const event = finalizeEvent(
    { kind: 9, content: "fixture", created_at: 1700000000, tags: [["h", "c"]] },
    key,
  );
  const calls = [];
  const socket = brokerSocket();
  let live;
  let handler;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    socketFactory: socket.factory,
    authority: async () => ({ relayAuthor: viewer, ...capabilities }),
    upstreamFetch: async (url, init) => {
      const upstreamUrl = String(url);
      const authorization = new Headers(init?.headers).get("Authorization");
      const auth = authorization
        ? JSON.parse(Buffer.from(authorization.slice(6), "base64").toString())
        : undefined;
      if (
        upstreamUrl === fixtureRelayUrl ||
        upstreamUrl === `${fixtureRelayUrl}/api/join-policy`
      )
        expect(auth).toBeUndefined();
      else expect(auth).toBeDefined();
      if (auth) {
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.created_at).toBe(Math.floor(Date.now() / 1000));
      }
      const call = {
        url: upstreamUrl,
        body: init?.body ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
        headers: init?.headers,
        auth,
        at: performance.now(),
      };
      calls.push(call);
      return respond(call, calls.length, event);
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
  return {
    base,
    event,
    calls,
    publications: socket.publications,
    async start() {
      live = await openBrokerSocket(await connectBrokerTransport(base));
    },
    get(route, signal) {
      return fetch(`${base}/api/relay/${route}`, { signal });
    },
    post(route, body, signal, priority) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(live ? { "X-Buzz-Live-ID": live.identity() } : {}),
          ...(priority ? { "X-Buzz-Read-Priority": priority } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    },
    async close() {
      live?.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const filters = [{ kinds: [0], limit: 1 }];
const success = (call) =>
  Response.json(
    call.url.endsWith("/events")
      ? { accepted: true, event_id: call.body.id }
      : [],
  );

test("saved icon discovery survives join-policy failure without changing join discovery", async () => {
  const icon = "https://images.example/icon@2x.png";
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl) return Response.json({ icon });
    if (call.url === `${fixtureRelayUrl}/api/join-policy`)
      return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 404 });
  });
  try {
    const iconResponse = await h.get("icon-info");
    expect(iconResponse.status).toBe(200);
    expect(await iconResponse.json()).toEqual({ icon });
    expect(h.calls.map(({ url }) => url)).toEqual([fixtureRelayUrl]);

    const joinResponse = await h.get("info");
    const joinBody = await joinResponse.json();
    expect([joinResponse.status, joinBody]).toEqual([
      503,
      { error: "Could not load join policy" },
    ]);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
      `${fixtureRelayUrl}/api/join-policy`,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF capability discovery does not depend on join-policy availability", async () => {
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/api/join-policy`)
      return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 404 });
  });
  try {
    const response = await h.get("gif-info");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported_extensions: ["buzz-gif"],
      gif: { provider: "klipy", search: "/gifs/search" },
    });
    expect(h.calls.map(({ url }) => url)).toEqual([fixtureRelayUrl]);
  } finally {
    await h.close();
  }
});

test("GIF discovery retries unsupported relays and caches confirmed support", async () => {
  let supported = false;
  const descriptor = {
    supported_extensions: ["buzz-gif"],
    gif: { provider: "klipy", search: "/gifs/search" },
  };
  const h = await harness(() => Response.json(supported ? descriptor : {}));
  try {
    expect(await (await h.get("gif-info")).json()).toEqual({});
    supported = true;
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF search follows the relay-advertised KLIPY path with signed, bounded input", async () => {
  const responseBody = {
    result: true,
    data: { data: [{ id: 1, type: "gif", slug: "hello" }] },
  };
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/gifs/search`)
      return Response.json(responseBody);
    return new Response(null, { status: 404 });
  });
  try {
    const body = {
      customer_id: "fixture-customer",
      locale: "en-US",
      query: "hello",
    };
    const response = await h.post("gifs", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]).toMatchObject({
      url: fixtureRelayUrl,
      body: undefined,
      auth: undefined,
    });
    expect(h.calls[1]).toMatchObject({
      url: `${fixtureRelayUrl}/gifs/search`,
      body,
    });
    expect(h.calls[1].auth.tags).toEqual(
      expect.arrayContaining([
        ["u", `${fixtureRelayUrl}/gifs/search`],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ],
      ]),
    );

    const rejected = await h.post("gifs", { ...body, query: "x".repeat(101) });
    expect(rejected.status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("media proxy returns generic files as neutralized authenticated downloads", async () => {
  const bytes = Buffer.from("%PDF-1.7\nfixture pdf\n");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/file.pdf`);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file.pdf`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes active content as downloads", async () => {
  const activeTypes = [
    "text/html",
    "image/svg+xml",
    "image/svg+xml; charset=utf-8",
    "IMAGE/SVG+XML",
  ];
  for (const contentType of activeTypes) {
    const bytes = Buffer.from(`<script>${contentType}</script>`);
    const h = await harness(
      () =>
        new Response(bytes, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(bytes.length),
          },
        }),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  }
});

test("media proxy neutralizes comma-joined content types as downloads", async () => {
  const bytes = Buffer.from("fake png then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png, image/svg+xml",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy strips smuggled inline content type parameters", async () => {
  const bytes = Buffer.from("fake png then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png;x, image/svg+xml",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes missing or empty content types as downloads", async () => {
  for (const headers of [{}, { "Content-Type": "" }]) {
    const bytes = Buffer.from("unknown bytes");
    const h = await harness(
      () =>
        new Response(bytes, {
          headers: { ...headers, "Content-Length": String(bytes.length) },
        }),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  }
});

test("media proxy keeps raster images inline with exact bytes", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/pixel.png`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy rejects oversized generic files", async () => {
  const h = await harness(
    () =>
      new Response(null, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(20 * 1024 * 1024 + 1),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/archive.zip`)}`,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Media budget exceeded" });
  } finally {
    await h.close();
  }
});

test("media proxy streams authenticated video ranges and preserves seek headers", async () => {
  const bytes = Buffer.from("video-range");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/clip.mp4`);
    expect(call.headers.Range).toBe("bytes=100-");
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": 'video/mp4; codecs="avc1.42E01E"',
        "Content-Length": String(bytes.length),
        "Content-Range": "bytes 100-110/1000",
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/clip.mp4`)}`,
      { headers: { Range: "bytes=100-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 100-110/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy streams authenticated audio ranges and preserves seek headers", async () => {
  const bytes = Buffer.from("audio-range");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/audio.mp3`);
    expect(call.headers.Range).toBe("bytes=100-");
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": "Audio/MPEG; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Content-Range": "bytes 100-110/1000",
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/audio.mp3`)}`,
      { headers: { Range: "bytes=100-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 100-110/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy rejects oversized non-range audio", async () => {
  const h = await harness(
    () =>
      new Response("too large", {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(20 * 1024 * 1024 + 1),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/audio.mp3`)}`,
    );
    expect(response.status).toBe(413);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes non-media content types as downloads", async () => {
  const bytes = Buffer.from("plain");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file.txt`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy strips smuggled audio content type parameters", async () => {
  const bytes = Buffer.from("fake audio then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "audio/mpeg;x, image/svg+xml",
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/audio.mp3`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("an upstream video stream error closes only that response, not the broker", async () => {
  const h = await harness(() => {
    let controller;
    const body = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    queueMicrotask(() =>
      controller.error(new DOMException("timed out", "TimeoutError")),
    );
    return new Response(body, {
      status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/10" },
    });
  });
  try {
    await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/clip.mp4`)}`,
      { headers: { Range: "bytes=0-" } },
    )
      .then((response) => response.arrayBuffer())
      .catch(() => {});
    const session = await fetch(`${h.base}/api/relay/session`);
    expect(session.status).toBe(200);
  } finally {
    await h.close();
  }
});

test("media proxy rejects malformed ranges before upstream I/O", async () => {
  const h = await harness(() => {
    throw new Error("unexpected upstream call");
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/clip.mp4`)}`,
      { headers: { Range: "items=0-1" } },
    );
    expect(response.status).toBe(416);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("upstream quota survives browser recreation, gates reads/profile and leaves other communities independent", async () => {
  const h = await harness((call, count, event) =>
    count === 1
      ? Response.json(
          {
            error: "rate-limited: quota exceeded; retry in 0s",
            secret: "not forwarded",
          },
          { status: 429 },
        )
      : success(call, count, event),
  );
  try {
    const first = await connectBrokerTransport(h.base);
    await expect(first.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: 1000,
    });
    const replacement = await connectBrokerTransport(h.base);
    await expect(replacement.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: expect.any(Number),
    });
    await expect(
      replacement.writer.publish(h.event, new AbortController().signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    const profile = await h.post("profile", { name: "Fixture", picture: "" });
    expect(profile.status).toBe(429);
    expect(await profile.json()).toMatchObject({ paused: true, sent: false });
    expect(h.calls).toHaveLength(1);
    const independent = await connectBrokerTransport(
      h.base,
      undefined,
      "secondary",
    );
    await independent.query(filters);
    expect(h.calls).toHaveLength(2);
    await delay(1050);
    expect(
      (await h.post("profile", { name: "Fixture", picture: "" })).status,
    ).toBe(200);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].body.kind).toBe(0);
    expect(h.calls[2].at - h.calls[0].at).toBeGreaterThanOrEqual(1000);
  } finally {
    await h.close();
  }
});

test("foreground profile publication starts while background I/O is outstanding; cancellation does not replay", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    if (call.url.endsWith("/query")) await held;
    return success(call, count, event);
  });
  const cancel = new AbortController();
  try {
    const background = h.post("query", filters, cancel.signal, "background");
    const rejection = expect(background).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const write = await h.post("profile", { name: "Fixture", picture: "" });
    expect(write.status).toBe(200);
    await write.text();
    cancel.abort();
    await rejection;
    release();
    expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual([
      "query",
      "events",
    ]);
  } finally {
    release();
    cancel.abort();
    await h.close();
  }
});

test("local capacity is explicitly unsent, not relay quota; unknown upstream publication is never resent", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    await held;
    return success(call, count, event);
  });
  const controllers = [];
  try {
    const requests = Array.from({ length: 6 }, () => {
      const controller = new AbortController();
      controllers.push(controller);
      return h.post("query", filters, controller.signal);
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(6));
    const refused = await h.post("profile", { name: "Fixture", picture: "" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Query concurrency limit",
      sent: false,
    });
    release();
    await Promise.all(
      requests.map(async (response) => (await response).text()),
    );
    expect(h.calls).toHaveLength(6);
    const transport = await connectBrokerTransport(h.base);
    // Generic upstream 503 is not proof of non-delivery (separate fixture below).
    await transport.query(filters);
    expect(h.calls).toHaveLength(7); // Local capacity did not introduce a relay cooldown.
  } finally {
    release();
    for (const c of controllers) c.abort();
    await h.close();
  }
  const uncertain = await harness(
    () => new Response("private upstream detail", { status: 503 }),
  );
  try {
    const response = await uncertain.post("profile", {
      name: "Fixture",
      picture: "",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("sent");
    expect(uncertain.calls).toHaveLength(1);
    await delay(550);
    expect(uncertain.calls).toHaveLength(1);
  } finally {
    await uncertain.close();
  }
}, 10000);

// Reader-to-host priority propagation control contributed by Brain.
test("reader and transport start foreground work without waiting for background completion", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    if (call.body?.[0]?.limit === 2) await held;
    return success(call, count, event);
  });
  let reader;
  try {
    const t = await connectBrokerTransport(h.base);
    reader = createRelayReader(t);
    await reader.reader.read([{ kinds: [0], limit: 1 }]);
    const background = reader.reader.read([{ kinds: [0], limit: 2 }], {
      priority: "background",
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    await reader.reader.read([{ kinds: [0], limit: 3 }], {
      priority: "foreground",
    });
    expect(h.calls.map((c) => c.body[0].limit)).toEqual([1, 2, 3]);
    release();
    await background;
  } finally {
    release();
    reader?.dispose();
    await h.close();
  }
});

test("each request mints fresh auth at dispatch after wall time advances", async () => {
  const h = await harness(success);
  try {
    await (await h.post("query", filters)).text();
    wallClock += 61000;
    const response = await h.post("query", [{ kinds: [0], limit: 2 }]);
    expect(response.status).toBe(200);
    await response.text();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].auth.created_at - h.calls[0].auth.created_at).toBe(61);
  } finally {
    await h.close();
  }
});

test("reaction sign and publish preserve kind 7 and reject malformed targets before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      ...h.event,
      kind: 7,
      content: ":party:",
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64)],
        ["emoji", "party", "https://a.test/party.png"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(7);
    expect(event.tags).toEqual(template.tags);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toEqual(JSON.parse(JSON.stringify(event)));
    for (const length of [62, 63, 64]) {
      const content = `:${"a".repeat(length)}:`;
      const signed = await h.post("sign", { ...template, content });
      expect(signed.status).toBe(200);
      const boundaryEvent = await signed.json();
      expect(boundaryEvent.content).toBe(content);
      expect((await h.post("publish", boundaryEvent)).status).toBe(200);
    }
    expect(h.publications).toHaveLength(4);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [],
        [["e", "bad"]],
        [["e", "a".repeat(64), "", "reply"]],
        [
          ["e", "a".repeat(64)],
          ["e", "b".repeat(64)],
        ],
      ]) {
        expect(
          (await h.post(route, { ...event, tags: [["h", "c"], ...tags] }))
            .status,
        ).toBe(400);
      }
      expect(
        (await h.post(route, { ...event, content: "x".repeat(65) })).status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: `:${"a".repeat(65)}:` }))
          .status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: ` ${"x".repeat(64)}` }))
          .status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(4);
  } finally {
    await h.close();
  }
});

test("both real sign and publish routes admit direct replies but reject arbitrary references before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      ...h.event,
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64), "", "reply"],
        ["p", "b".repeat(64)],
      ],
    };
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    const event = await signed.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toEqual(template.tags);
    expect(h.publications).toHaveLength(0);
    const published = await h.post("publish", event);
    expect(published.status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toEqual(JSON.parse(JSON.stringify(event)));
    for (const route of ["sign", "publish"]) {
      for (const references of [
        [["e", "a".repeat(64)]],
        [["e", "a".repeat(64), "", "root"]],
        [["e", "invalid", "", "reply"]],
        [
          ["e", "a".repeat(64), "", "reply"],
          ["e", "b".repeat(64), "", "reply"],
        ],
      ]) {
        const rejected = await h.post(route, {
          ...event,
          tags: [["h", "c"], ...references],
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({ error: "Message rejected" });
      }
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("held optional snapshot body leaves ordinary broker capacity free and start credit untouched", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001))
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode("[]"));
              controller.close();
            };
          },
        }),
      );
    return Response.json([]);
  });
  const presence = [{ kinds: [20001], authors: [h.event.pubkey], limit: 1 }];
  try {
    const snapshot = h.post("presence-snapshot", presence);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const duplicate = await h.post("presence-snapshot", presence);
    expect(duplicate.status).toBe(204);
    expect((await h.post("query", filters)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].at - h.calls[0].at).toBeLessThan(400);
    release();
    release = undefined;
    expect(await (await snapshot).json()).toEqual([]);
    expect(
      (await h.post("presence-snapshot", [{ ...presence[0], authors: [] }]))
        .status,
    ).toBe(400);
    expect(
      (
        await h.post("presence-snapshot", [
          { ...presence[0], authors: Array(257).fill(h.event.pubkey) },
        ])
      ).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    release?.();
    await h.close();
  }
});

test("presence snapshot progresses while an ordinary response body is held", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001)) return Response.json([]);
    return new Response(
      new ReadableStream({
        start(controller) {
          release = () => {
            controller.enqueue(new TextEncoder().encode("[]"));
            controller.close();
          };
        },
      }),
    );
  });
  let ordinary;
  try {
    ordinary = h.post("query", filters, undefined, "background");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const snapshot = await h.post("presence-snapshot", [
      { kinds: [20001], authors: [h.event.pubkey], limit: 1 },
    ]);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual([]);
    expect(h.calls).toHaveLength(2);
    const missing = await h.post("stream-presence", {
      streamId: "0".repeat(32),
      status: "online",
    });
    expect(await missing.json()).toEqual({ accepted: null });
  } finally {
    release?.();
    await ordinary;
    await h.close();
  }
});
test.each([undefined, "22222222-2222-4222-8222-222222222222"])(
  "real outbox creates, invites and sends without Sessions support (parent: %s)",
  async (parent) => {
    const h = await harness(
      (call) =>
        Response.json(
          call.url.endsWith("/events")
            ? { accepted: true, event_id: call.body.id }
            : [],
        ),
      { channelCreation: true },
    );
    let owner;
    let traffic;
    try {
      const transport = await connectBrokerTransport(h.base);
      traffic = await openBrokerSocket(transport);
      expect(transport.writer.kinds).toContain(9007);
      expect(transport.writer.kinds).not.toContain(9050);
      owner = createOutbox(transport.viewer, transport.writer, {
        load: () => [],
        save: () => {},
      });
      const id = "11111111-1111-4111-8111-111111111111";
      const creationId = owner.outbox.send({
        kind: 9007,
        content: "",
        tags: [
          ["h", id],
          ["name", "Work"],
          ["visibility", "private"],
          ["channel_type", "stream"],
          [
            "about",
            `Buzz session (buzz.sessions/v1)${parent ? `\nparent:${parent}` : ""}`,
          ],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === creationId)
            ?.delivery,
        ).toBe("accepted"),
      );
      const temporaryCreationId = owner.outbox.send({
        kind: 9007,
        content: "",
        tags: [
          ["h", "33333333-3333-4333-8333-333333333333"],
          ["name", "Standup"],
          ["visibility", "open"],
          ["channel_type", "stream"],
          ["ttl", "604800"],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local
            .snapshot()
            .find((row) => row.event.id === temporaryCreationId)?.delivery,
        ).toBe("accepted"),
      );
      const invitationId = owner.outbox.send({
        kind: 9000,
        content: "",
        tags: [
          ["h", id],
          ["p", "a".repeat(64)],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === invitationId)
            ?.delivery,
        ).toBe("accepted"),
      );
      const messageId = owner.outbox.send({
        kind: 9,
        content: "Hello",
        tags: [
          ["h", id],
          ["p", "a".repeat(64)],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === messageId)
            ?.delivery,
        ).toBe("accepted"),
      );
      expect(h.publications.map((event) => event.kind)).toEqual([
        9007, 9007, 9000, 9,
      ]);
      const denied = await h.post("sign", {
        kind: 9050,
        created_at: 1700000000,
        content: JSON.stringify({ action: "create", title: "Work" }),
        tags: [["h", id]],
      });
      expect(denied.status).toBe(400);
    } finally {
      owner?.dispose();
      traffic?.dispose();
      await h.close();
    }
  },
);

test.each(["sign", "publish"])(
  "%s rejects truncated channel creation tags as a client error",
  async (route) => {
    const h = await harness(success, { channelCreation: true });
    try {
      const required = [
        ["h", "11111111-1111-4111-8111-111111111111"],
        ["name", "Work"],
        ["visibility", "open"],
        ["channel_type", "stream"],
      ];
      for (let length = 0; length < required.length; length++) {
        const response = await h.post(route, {
          kind: 9007,
          created_at: 1700000000,
          content: "",
          tags: required.slice(0, length),
        });
        expect(response.status).toBe(400);
      }
    } finally {
      await h.close();
    }
  },
);
