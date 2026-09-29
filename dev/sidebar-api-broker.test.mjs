import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const id = "a".repeat(64);
async function harness(enabled = true) {
  const key = generateSecretKey();
  const calls = [];
  let handler, next;
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    upstreamFetch: async (url, init) => {
      if (!new URL(url).pathname.startsWith("/buzz/v1/"))
        return Response.json({
          self: getPublicKey(key),
          ...(enabled
            ? {
                buzz_v1: {
                  version: 1,
                  base_path: "/buzz/v1",
                  max_channels: 20,
                  max_intents: 100,
                  max_contexts: 20,
                  max_context_messages: 100,
                  max_thread_summaries: 5,
                },
              }
            : {}),
        });
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(getPublicKey(key));
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual(["method", init.method]);
      if (init.body)
        expect(auth.tags).toContainEqual([
          "payload",
          createHash("sha256").update(init.body).digest("hex"),
        ]);
      else expect(auth.tags.some(([name]) => name === "payload")).toBe(false);
      calls.push({ url, auth, body: init.body });
      return (
        next ??
        Response.json(
          init.method === "POST"
            ? {
                outcomes: [{ status: "applied" }],
                projection_status: "not_requested",
              }
            : {
                account: {
                  retention_seconds: 2592000,
                  cutoff_ms: 0,
                  imported_at_ms: null,
                },
                channels: [],
                next_cursor: null,
              },
        )
      );
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    transport: await connectBrokerTransport(base),
    calls,
    base,
    respond(response) {
      next = response;
    },
  };
}
it("discovers and signs bounded GET and POST operations through the actual broker", async () => {
  const h = await harness();
  expect(h.transport.sidebarApi).toBeDefined();
  const api = h.transport.sidebarApi;
  const signal = new AbortController().signal;
  await api.sidebar({ channel_ids: [channel] }, signal);
  expect(new URL(h.calls[0].url).searchParams.get("channel_ids")).toBe(channel);
  const intents = [
    { type: "mark_channel_read", channel_id: channel, message_id: id },
  ];
  await api.write(intents, signal);
  await api.write(intents, signal);
  expect(h.calls[1].body).toBe(h.calls[2].body);
  expect(h.calls[1].auth.id).not.toBe(h.calls[2].auth.id);
  const bad = await fetch(`${h.base}/api/relay/sidebar-api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sidebar", query: {}, path: "/events" }),
  });
  expect(bad.status).toBe(400);
  expect(h.calls).toHaveLength(3);
});
it("does not supply an API when capability is absent", async () => {
  const h = await harness(false);
  expect(h.transport.sidebarApi).toBeUndefined();
});
it.each([429, 503])(
  "honors BFF %s Retry-After on the shared lane without transparent retry",
  async (status) => {
    const h = await harness();
    h.respond(
      Response.json(
        { error: { code: "temporarily_unavailable", request_id: "bounded" } },
        { status, headers: { "Retry-After": "17" } },
      ),
    );
    const signal = new AbortController().signal;
    await expect(
      h.transport.sidebarApi.sidebar({}, signal),
    ).rejects.toMatchObject({ status, retryAfterMs: 17000 });
    await expect(
      h.transport.sidebarApi.sidebar({}, signal),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.calls).toHaveLength(1);
  },
);
