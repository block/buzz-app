import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import {
  MEMBERSHIP_TYPES,
  MembershipUnsupported,
} from "../src/features/relay/membership-snapshot.ts";
import {
  membershipDescriptor,
  membershipReply,
} from "../src/features/relay/membership-testing.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function harness() {
  let key = generateSecretKey();
  const relayKey = generateSecretKey(),
    viewer = getPublicKey(key),
    relay = getPublicKey(relayKey);
  let handler,
    enabled = true;
  const calls = [],
    discoveries = [];
  let respond = async (call) =>
    Response.json(
      await membershipReply(
        relayKey,
        call.auth.pubkey,
        call.auth.id,
        fixtureRelayUrl,
        call.types,
      ),
    );
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  const options = {
    archiveFile: ":memory:",
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    upstreamFetch: async (url, init) => {
      if (!init?.body) {
        discoveries.push(String(url));
        return Response.json({
          self: relay,
          ...(enabled
            ? { membership_snapshot: membershipDescriptor(relayKey) }
            : {}),
        });
      }
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      const body = JSON.parse(init.body);
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(getPublicKey(key));
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      expect(body).toEqual([
        {
          kinds: [39008],
          "#p": [auth.pubkey],
          "#t": body[0]["#t"],
          membership_snapshot: 1,
        },
      ]);
      const call = { auth, types: body[0]["#t"], signal: init.signal };
      calls.push(call);
      return respond(call);
    },
  };
  const configuration = {
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback) {
        handler = callback;
      },
    },
  };
  await relayBrokerPlugin(options).configureServer(configuration);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transport = await connectBrokerTransport(base);
  return {
    transport,
    async switchAccount() {
      key = generateSecretKey();
      await relayBrokerPlugin(options).configureServer(configuration);
    },
    calls,
    discoveries,
    relayKey,
    viewer,
    base,
    set enabled(value) {
      enabled = value;
    },
    set respond(value) {
      respond = value;
    },
    read: (signal = new AbortController().signal, types = MEMBERSHIP_TYPES) =>
      transport.readMembershipSnapshot(types, signal, "foreground"),
  };
}

it("binds concurrent broker responses to their host-generated auth and refreshes capability each call", async () => {
  const h = await harness(),
    a = gate(),
    b = gate();
  h.respond = async (call) => {
    await (h.calls.length === 1 ? a.promise : b.promise);
    return Response.json(
      await membershipReply(
        h.relayKey,
        h.viewer,
        call.auth.id,
        fixtureRelayUrl,
        call.types,
      ),
    );
  };
  const first = h.read(),
    second = h.read();
  try {
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[0].auth.id).not.toBe(h.calls[1].auth.id);
    b.resolve();
    await expect(second).resolves.toHaveProperty("channels", []);
    a.resolve();
    await expect(first).resolves.toHaveProperty("channels", []);
  } finally {
    a.resolve();
    b.resolve();
  }
  h.enabled = false;
  await expect(h.read()).rejects.toBeInstanceOf(MembershipUnsupported);
  expect(h.calls).toHaveLength(2);
  h.enabled = true;
  h.respond = async (call) =>
    Response.json(
      await membershipReply(
        h.relayKey,
        h.viewer,
        call.auth.id,
        fixtureRelayUrl,
        call.types,
      ),
    );
  await expect(h.read()).resolves.toHaveProperty("channels", []);
  expect(h.discoveries.length).toBeGreaterThanOrEqual(5);
});

it("rejects swapped replies and a changed session viewer across the broker boundary", async () => {
  const h = await harness(),
    both = gate();
  h.respond = async (call) => {
    await both.promise;
    const other = h.calls.find((value) => value !== call);
    return Response.json(
      await membershipReply(
        h.relayKey,
        h.viewer,
        other.auth.id,
        fixtureRelayUrl,
        call.types,
      ),
    );
  };
  const a = expect(h.read()).rejects.toThrow(),
    b = expect(h.read()).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
  } finally {
    both.resolve();
  }
  await Promise.all([a, b]);
  h.respond = async (call) =>
    Response.json(
      await membershipReply(
        h.relayKey,
        call.auth.pubkey,
        call.auth.id,
        fixtureRelayUrl,
        call.types,
      ),
    );
  await h.switchAccount();
  await expect(h.read()).rejects.toThrow();
});

it("preserves exact unsupported 404s, rejects other failures and cancels an in-flight broker read", async () => {
  const h = await harness();
  h.respond = () =>
    Response.json(
      { error: "membership_snapshot unsupported" },
      { status: 404 },
    );
  const before = h.discoveries.length;
  await expect(h.read()).rejects.toBeInstanceOf(MembershipUnsupported);
  expect(h.discoveries.length - before).toBe(2);
  for (const [status, error] of [
    [404, "no community is configured for this host"],
    [403, "denied"],
    [503, "unavailable"],
  ]) {
    h.respond = () => Response.json({ error }, { status });
    await expect(h.read()).rejects.not.toBeInstanceOf(MembershipUnsupported);
  }
  const started = gate(),
    stopped = gate();
  h.respond = (call) =>
    new Promise((_resolve, reject) => {
      call.signal.addEventListener(
        "abort",
        () => {
          stopped.resolve();
          reject(call.signal.reason);
        },
        { once: true },
      );
      started.resolve();
    });
  const controller = new AbortController();
  const cancelled = expect(h.read(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  await started.promise;
  controller.abort();
  await Promise.all([cancelled, stopped.promise]);
});
