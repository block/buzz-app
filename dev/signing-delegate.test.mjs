import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { afterEach, expect, test, vi } from "vitest";
import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { createLocalSigningDelegate } from "./signing-delegate.mjs";

const primary = "https://primary.example";
const secondary = "https://secondary.example";
const query = [{ kinds: [0], limit: 1 }];
const template = () => ({
  kind: 9,
  content: "same message",
  created_at: Math.floor(Date.now() / 1000),
  tags: [["h", "room"]],
});
const gate = () => Promise.withResolvers();
afterEach(() => vi.restoreAllMocks());

async function harness(select, respond = () => Response.json([]), publish) {
  const key = new Uint8Array(32).fill(7);
  const viewer = getPublicKey(key);
  const local = createLocalSigningDelegate(key);
  const selections = [],
    calls = [];
  const socket = brokerSocket(publish);
  let handler,
    live,
    completed = 0;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler(req, res).finally(() => {
      completed++;
    });
  });
  await relayBrokerPlugin({
    relayUrl: primary,
    communityAliases: JSON.stringify({ primary, secondary }),
    identity: () => key,
    socketFactory: socket.factory,
    authority: async () => ({ relayAuthor: viewer }),
    selectSigningDelegate(scope) {
      selections.push(scope);
      return select?.(local, scope) ?? local;
    },
    upstreamFetch: async (url, init) => {
      const auth = JSON.parse(
        Buffer.from(
          new Headers(init.headers).get("Authorization").slice(6),
          "base64",
        ).toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      calls.push({ url: String(url), auth, body: init.body });
      return respond(String(url), init);
    },
  }).configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    viewer,
    local,
    selections,
    calls,
    socket,
    completed: () => completed,
    async start() {
      live = await openBrokerSocket(await connectBrokerTransport(base));
    },
    post(route, body, signal) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(live ? { "X-Buzz-Live-ID": live.identity() } : {}),
        },
        body: JSON.stringify(body),
      });
    },
    async close() {
      live?.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("local delegate preserves event fields, NIP-OA digest and the original send receipt", async () => {
  const key = new Uint8Array(32).fill(5);
  const delegate = createLocalSigningDelegate(key);
  const input = template();
  const event = await delegate.signEvent(input);
  expect(event).toMatchObject({ ...input, pubkey: getPublicKey(key) });
  expect(verifyEvent(event)).toBe(true);
  const agent = "a".repeat(64);
  const signature = await delegate.authorizeAgent(agent);
  expect(
    schnorr.verify(
      Buffer.from(signature, "hex"),
      createHash("sha256").update(`nostr:agent-auth:${agent}:`).digest(),
      Buffer.from(getPublicKey(key), "hex"),
    ),
  ).toBe(true);
  const receipt = { accepted: true };
  const send = vi.fn(async () => receipt);
  expect(await delegate.publishEvent(event, send)).toBe(receipt);
  expect(send).toHaveBeenCalledExactlyOnceWith();
  const abort = new AbortController();
  abort.abort();
  await expect(
    delegate.publishEvent(event, send, abort.signal),
  ).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

test("captures canonical relay and identity while another community signs", async () => {
  const started = gate(),
    release = gate();
  const h = await harness((local, scope) => ({
    ...local,
    async signEvent(event, signal) {
      if (scope.relay === primary) {
        started.resolve();
        await release.promise;
      }
      return local.signEvent(event, signal);
    },
  }));
  try {
    const first = h.post("primary/query", query);
    await started.promise;
    expect(h.calls).toHaveLength(0);
    expect((await h.post("secondary/query", query)).status).toBe(200);
    release.resolve();
    expect((await first).status).toBe(200);
    expect(h.selections).toEqual([
      { relay: primary, identity: h.viewer },
      { relay: secondary, identity: h.viewer },
    ]);
    expect(
      h.calls.map((call) => [
        call.url,
        call.auth.pubkey,
        call.auth.tags.find((tag) => tag[0] === "u")[1],
      ]),
    ).toEqual([
      [`${secondary}/query`, h.viewer, `${secondary}/query`],
      [`${primary}/query`, h.viewer, `${primary}/query`],
    ]);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("awaits message signing and delegate publication before the existing socket sends", async () => {
  const signing = gate(),
    signed = gate(),
    publishing = gate(),
    publish = gate();
  const h = await harness((local) => ({
    ...local,
    async signEvent(event, signal) {
      if (event.kind === 9) {
        signing.resolve();
        await signed.promise;
      }
      return local.signEvent(event, signal);
    },
    async publishEvent(event, send, signal) {
      publishing.resolve();
      await publish.promise;
      return local.publishEvent(event, send, signal);
    },
  }));
  try {
    await h.start();
    const input = template();
    const pending = h.post("sign", input);
    await signing.promise;
    expect(h.socket.publications).toHaveLength(0);
    signed.resolve();
    const event = await (await pending).json();
    expect(event).toMatchObject({ ...input, pubkey: h.viewer });
    const sent = h.post("publish", event);
    await publishing.promise;
    expect(h.socket.publications).toHaveLength(0);
    publish.resolve();
    expect(await (await sent).json()).toMatchObject({
      accepted: true,
      event_id: event.id,
    });
    expect(h.socket.publications).toEqual([event]);
    expect(h.calls).toHaveLength(0);
  } finally {
    signed.resolve();
    publish.resolve();
    await h.close();
  }
});

test("delegate can deliver a signed event without requesting a local socket", async () => {
  const delivered = [];
  const h = await harness((local) => ({
    ...local,
    async publishEvent(event) {
      delivered.push(event);
      return "accepted";
    },
  }));
  try {
    const event = await h.local.signEvent(template());
    expect(await (await h.post("publish", event)).json()).toEqual({
      accepted: true,
      event_id: event.id,
      message: "accepted",
    });
    expect(delivered).toEqual([event]);
    expect(h.socket.publications).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("disconnect during signing never dispatches a late result, even if the signer ignores cancellation", async () => {
  const started = gate(),
    release = gate(),
    cancelled = gate();
  const h = await harness((local) => ({
    ...local,
    async signEvent(event, signal) {
      signal.addEventListener("abort", () => cancelled.resolve(), {
        once: true,
      });
      started.resolve();
      await release.promise;
      return local.signEvent(event);
    },
  }));
  try {
    const abort = new AbortController();
    const pending = h
      .post("query", query, abort.signal)
      .catch((error) => error);
    await started.promise;
    abort.abort();
    await cancelled.promise;
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(h.completed()).toBe(1));
    expect(h.calls).toHaveLength(0);
  } finally {
    release.resolve();
    await h.close();
  }
});

test.each(["pause", "expiry", "rejection"])(
  "handles %s while signing without sending or retrying",
  async (mode) => {
    const started = gate(),
      release = gate();
    let held = true;
    const h = await harness(
      (local) => ({
        ...local,
        async signEvent(event, signal) {
          if (held) {
            held = false;
            started.resolve();
            await release.promise;
            if (mode === "rejection") throw new Error("signing declined");
          }
          return local.signEvent(event, signal);
        },
      }),
      () =>
        mode === "pause"
          ? Response.json(
              { error: "rate-limited: quota exceeded; retry in 10s" },
              { status: 429 },
            )
          : Response.json([]),
    );
    try {
      const pending = h.post("query", query);
      await started.promise;
      if (mode === "pause")
        expect((await h.post("query", query)).status).toBe(429);
      if (mode === "expiry")
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 46000);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(
        mode === "pause" ? 429 : mode === "expiry" ? 503 : 500,
      );
      if (mode !== "rejection")
        expect(await response.json()).toMatchObject({ sent: false });
      expect(h.calls).toHaveLength(mode === "pause" ? 1 : 0);
      if (mode === "rejection")
        expect((await h.post("query", query)).status).toBe(200);
    } finally {
      release.resolve();
      await h.close();
    }
  },
);

test.each(["profile", "direct-message", "member"])(
  "%s publication awaits the delegate and retains its HTTP receipt",
  async (route) => {
    const started = gate(),
      release = gate();
    let publication;
    const h = await harness(
      (local) => ({
        ...local,
        async publishEvent(event, send, signal) {
          publication = event;
          started.resolve();
          await release.promise;
          return local.publishEvent(event, send, signal);
        },
      }),
      (_url, init) => {
        const event = JSON.parse(init.body);
        return Response.json({
          accepted: true,
          event_id: event.id,
          message:
            route === "direct-message"
              ? `response:${JSON.stringify({ channel_id: "01234567-89ab-4cde-8fab-0123456789ab" })}`
              : "",
        });
      },
    );
    try {
      const pending = h.post(
        `primary/${route}`,
        route === "profile"
          ? { name: "Name", picture: "" }
          : route === "member"
            ? { action: "remove", pubkey: "a".repeat(64) }
            : { pubkeys: ["a".repeat(64)] },
      );
      await started.promise;
      expect(h.calls).toHaveLength(0);
      expect(publication.kind).toBe(
        route === "profile" ? 0 : route === "member" ? 9031 : 41010,
      );
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].url).toBe(`${primary}/events`);
      expect(h.calls[0].body).toBe(JSON.stringify(publication));
    } finally {
      release.resolve();
      await h.close();
    }
  },
);

test("a delegate-provided HTTP receipt does not report timings for an unused local transport", async () => {
  const h = await harness((local) => ({
    ...local,
    async publishEvent(event) {
      return Response.json({ accepted: true, event_id: event.id });
    },
  }));
  try {
    const response = await h.post("profile", { name: "Name", picture: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(response.headers.get("Server-Timing")).toBe("");
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test.each([
  ["sort", false],
  ["mute", false],
  ["sort", true],
  ["mute", true],
])(
  "sidebar %s waits for signing and preserves cancellation=%s",
  async (kind, cancel) => {
    const started = gate(),
      release = gate(),
      cancelled = gate();
    let heads = [];
    const h = await harness(
      (local) => ({
        ...local,
        async signEvent(event, signal) {
          if (event.kind === 30078) {
            signal.addEventListener("abort", () => cancelled.resolve(), {
              once: true,
            });
            started.resolve();
            await release.promise;
          }
          return local.signEvent(event); // Deliberately ignore cancellation to test the caller's fence.
        },
      }),
      (url, init) => {
        if (url.endsWith("/events")) {
          heads = [JSON.parse(init.body)];
          return Response.json({ accepted: true, event_id: heads[0].id });
        }
        return Response.json(heads);
      },
      (event) => {
        heads = [event];
        return "";
      },
    );
    try {
      if (kind === "mute") await h.start();
      const abort = new AbortController();
      const pending = h
        .post(
          `sidebar-${kind}`,
          kind === "sort"
            ? { group: "channels", mode: "recent", sectionIds: [] }
            : { channelId: "room", muted: true },
          abort.signal,
        )
        .catch((error) => error);
      await started.promise;
      const completed = h.completed();
      expect(h.calls.map((call) => call.url)).toEqual([`${primary}/query`]);
      expect(h.socket.publications).toHaveLength(0);
      if (cancel) {
        abort.abort();
        await cancelled.promise;
      }
      release.resolve();
      const result = await pending;
      if (cancel) {
        expect(result).toBeInstanceOf(Error);
        await vi.waitFor(() => expect(h.completed()).toBe(completed + 1));
        expect(h.calls).toHaveLength(1);
        expect(heads).toHaveLength(0);
      } else {
        expect(result.status).toBe(200);
        expect(heads).toHaveLength(1);
        expect(verifyEvent(heads[0])).toBe(true);
        expect(heads[0].tags).toContainEqual([
          "d",
          kind === "sort" ? "channel-sort" : "channel-mutes",
        ]);
        expect(h.socket.publications).toHaveLength(kind === "mute" ? 1 : 0);
      }
    } finally {
      release.resolve();
      await h.close();
    }
  },
);
