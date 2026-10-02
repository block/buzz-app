import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { afterEach, expect, test, vi } from "vitest";
import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import {
  createLocalSigningCapabilities,
  createLocalSigningDelegate,
} from "./signing-delegate.mjs";

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

test("event signing and raw proof capabilities remain separate", async () => {
  const key = new Uint8Array(32).fill(5);
  const delegate = createLocalSigningDelegate(key);
  const capabilities = createLocalSigningCapabilities(key);
  const input = template();
  const event = await delegate.signEvent(input);
  expect(event).toMatchObject({ ...input, pubkey: getPublicKey(key) });
  expect(verifyEvent(event)).toBe(true);
  expect(await delegate.getPublicKey()).toBe(getPublicKey(key));
  expect(delegate.publishEvent).toBeUndefined();
  expect(delegate.authorizeAgent).toBeUndefined();
  const agent = "a".repeat(64);
  const signature = await capabilities.authorizeAgent(agent);
  expect(
    schnorr.verify(
      Buffer.from(signature, "hex"),
      createHash("sha256").update(`nostr:agent-auth:${agent}:`).digest(),
      Buffer.from(getPublicKey(key), "hex"),
    ),
  ).toBe(true);
  const abort = new AbortController();
  abort.abort();
  await expect(
    capabilities.authorizeAgent(agent, abort.signal),
  ).rejects.toThrow();
});

test.each(["signHarnessLogProof", "authorizeAgentCommunity"])(
  "broker keeps %s outside the event-signing delegate",
  async (method) => {
    const h = await harness();
    const pubkey = "b".repeat(64);
    const relayUrl = primary.replace("https:", "wss:");
    const id = `${pubkey}-${createHash("sha256").update(relayUrl).digest("hex")}`;
    const nonce = "12345678-1234-1234-1234-123456789abc";
    try {
      const response = await (method === "signHarnessLogProof"
        ? h.post("primary/agent-log-proof", { id, pubkey, relayUrl, nonce })
        : h.post("primary/resolve-agent-community", {
            owner: h.viewer,
            pubkey,
            confirmed: true,
          }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ...(method === "signHarnessLogProof"
          ? { signature: expect.any(String) }
          : { owner: h.viewer }),
      });
      expect(h.selections).toEqual([{ relay: primary, identity: h.viewer }]);
    } finally {
      await h.close();
    }
  },
);

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

test("rejects a selected delegate whose signed author drifts from the captured identity", async () => {
  const other = new Uint8Array(32).fill(8);
  const h = await harness(() => createLocalSigningDelegate(other));
  try {
    const response = await h.post("primary/query", query);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Local relay broker failed",
    });
    expect(h.calls).toHaveLength(0);
    expect(h.selections).toEqual([{ relay: primary, identity: h.viewer }]);
  } finally {
    await h.close();
  }
});

test("awaits message signing while the existing socket owns publication", async () => {
  const signing = gate(),
    signed = gate();
  const h = await harness((local) => ({
    ...local,
    async signEvent(event, signal) {
      if (event.kind === 9) {
        signing.resolve();
        await signed.promise;
      }
      return local.signEvent(event, signal);
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
    expect(await (await sent).json()).toMatchObject({
      accepted: true,
      event_id: event.id,
    });
    expect(h.socket.publications).toEqual([event]);
    expect(h.calls).toHaveLength(0);
  } finally {
    signed.resolve();
    await h.close();
  }
});

test("leave signing is awaited before its existing HTTP publication", async () => {
  const started = gate(),
    release = gate();
  const h = await harness(
    (local) => ({
      ...local,
      async signEvent(event, signal) {
        if (event.kind === 28936) {
          started.resolve();
          await release.promise;
        }
        return local.signEvent(event, signal);
      },
    }),
    (_url, init) =>
      Response.json({
        accepted: true,
        event_id: JSON.parse(init.body).id,
        message: "",
      }),
  );
  try {
    const pending = h.post("primary/leave", {});
    await started.promise;
    expect(h.calls).toHaveLength(0);
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(`${primary}/events`);
  } finally {
    release.resolve();
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

test.each(["pause", "rejection"])(
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
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(mode === "pause" ? 429 : 500);
      if (mode === "pause")
        expect(await response.json()).toMatchObject({ quota: "api" });
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
  "%s signing is awaited before its HTTP publication",
  async (route) => {
    const started = gate(),
      release = gate();
    let publication;
    const h = await harness(
      (local) => ({
        ...local,
        async signEvent(event, signal) {
          if (
            event.kind ===
            (route === "profile" ? 0 : route === "member" ? 9031 : 41010)
          ) {
            publication = event;
            started.resolve();
            await release.promise;
          }
          return local.signEvent(event, signal);
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

test.each(["direct-message", "member", "leave"])(
  "%s signer failures are not reported as participant validation errors",
  async (route) => {
    const h = await harness((local) => ({
      ...local,
      async signEvent(event, signal) {
        if ([41010, 9031, 28936].includes(event.kind))
          throw new Error("signing declined");
        return local.signEvent(event, signal);
      },
    }));
    try {
      const response = await h.post(
        `primary/${route}`,
        route === "member"
          ? { action: "remove", pubkey: "a".repeat(64) }
          : route === "direct-message"
            ? { pubkeys: ["a".repeat(64)] }
            : {},
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Local relay broker failed",
      });
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  },
);

/*
 * Publication is intentionally not a delegate capability. The relay socket
 * owns delivery and receipts, including its unavailable-socket response.
 */
test("publication keeps its existing socket-unavailable response", async () => {
  const h = await harness();
  try {
    const event = await h.local.signEvent(template());
    expect(await (await h.post("publish", event)).json()).toEqual({
      error: "Publication socket unavailable",
      sent: false,
    });
  } finally {
    await h.close();
  }
});

test.each([
  ["sort", false],
  ["mute", false],
  ["sort", true],
  ["mute", true],
  ["star", false],
  ["star", true],
  ["assignment", false],
  ["assignment", true],
])(
  "sidebar %s waits for signing and preserves cancellation=%s",
  async (kind, cancel) => {
    const started = gate(),
      release = gate(),
      cancelled = gate();
    let heads = [];
    let signCount = 0;
    const h = await harness(
      (local) => ({
        ...local,
        async signEvent(event, signal) {
          if (event.kind === 30078) {
            signCount++;
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
            : kind === "mute"
              ? { channelId: "room", muted: true }
              : kind === "star"
                ? { channelId: "room", starred: true }
                : {
                    channelId: "room",
                    createSection: {
                      id: "12345678-1234-1234-1234-123456789abc",
                      name: "Work",
                    },
                  },
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
          {
            sort: "channel-sort",
            mute: "channel-mutes",
            star: "channel-stars",
            assignment: "channel-sections",
          }[kind],
        ]);
        expect(h.socket.publications).toHaveLength(kind === "mute" ? 1 : 0);
      }
      expect(signCount).toBe(1);
    } finally {
      release.resolve();
      await h.close();
    }
  },
);
