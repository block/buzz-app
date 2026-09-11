import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
const community = "01234567-89ab-cdef-0123-456789abcdef";
async function harness(discovered = true) {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, response, published;
  const calls = [];
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    // Keep real NIP-11 discovery, signing, admission and broker routes. Only relay I/O is modeled.
    upstreamFetch: async (url, init) => {
      if (!init?.body)
        return Response.json({
          self: viewer,
          ...(discovered
            ? {
                read_state_snapshot: {
                  version: 1,
                  community_id: community,
                  max_events: 4096,
                  max_bytes: 8388608,
                },
              }
            : {}),
        });
      const body = JSON.parse(init.body);
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/events")) {
        published = body;
        return Response.json({ accepted: true, event_id: body.id });
      }
      if (body[0]?.read_state_snapshot && response instanceof Response)
        return response;
      if (body[0]?.read_state_snapshot)
        return Response.json(
          response ?? {
            read_state_snapshot: 1,
            complete: true,
            community_id: community,
            pubkey: viewer,
            snapshot_id: "a".repeat(64),
            events: published ? [published] : [],
          },
        );
      return Response.json(published ? [published] : []);
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback) {
        handler = callback;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transport = await connectBrokerTransport(base);
  const requests = createRelayReader(transport);
  disposals.push(() => requests.dispose());
  return {
    key,
    viewer,
    transport,
    reader: requests.reader,
    calls,
    envelope(events = []) {
      return {
        read_state_snapshot: 1,
        complete: true,
        community_id: community,
        pubkey: viewer,
        snapshot_id: "a".repeat(64),
        events,
      };
    },
    reply(value) {
      response = value;
    },
    post(route, value, headers) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    },
  };
}
it("real broker discovery -> reader snapshot and scoped encrypted signing/publication use existing relay routes", async () => {
  const h = await harness(),
    signal = new AbortController().signal;
  expect(h.transport.readState.communityId).toBe(community);
  expect(await h.reader.readStateSnapshot()).toEqual([]);
  const blob = { v: 1, client_id: "fixture", contexts: { room: 12 } };
  const event = await h.transport.readState.sign(
    { slot: "b".repeat(32), createdAt: Math.floor(Date.now() / 1000), blob },
    signal,
  );
  expect(verifyEvent(event)).toBe(true);
  expect(event.content).not.toContain("room");
  expect(await h.transport.readState.decode([event], signal)).toEqual([
    { eventId: event.id, blob },
  ]);
  await h.transport.readState.publish(event, signal);
  expect(await h.reader.readStateSnapshot({ fresh: true })).toEqual([event]);
  expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  expect(h.calls[0].body).toEqual([
    { kinds: [30078], authors: [h.viewer], read_state_snapshot: 1 },
  ]);
});
it("absent discovery does not grant complete enumeration and the broker rejects malformed extension filters before upstream", async () => {
  const old = await harness(false);
  expect(old.transport.readStateSnapshot).toBeUndefined();
  const filter = {
    kinds: [30078],
    authors: [old.viewer],
    read_state_snapshot: 1,
  };
  expect((await old.post("query", [filter])).status).toBe(400);
  expect(old.calls).toHaveLength(0);
  const h = await harness();
  for (const bad of [
    [{ ...filter, authors: [h.viewer], limit: 1 }],
    [{ ...filter, authors: [h.viewer], read_state_snapshot: 2, limit: 1 }],
    [
      { ...filter, authors: [h.viewer] },
      { kinds: [0], limit: 1 },
    ],
  ])
    expect((await h.post("query", bad)).status).toBe(400);
  expect(h.calls).toHaveLength(0);
});
it("broker refuses arbitrary own kind-30078 and hostile origins at decode/sign/publish boundaries", async () => {
  const h = await harness();
  const bad = finalizeEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `read-state:${"b".repeat(32)}`],
        ["t", "read-state"],
      ],
      content: "not encrypted read state",
    },
    h.key,
  );
  expect((await h.post("read-state-publish", bad)).status).toBe(400);
  expect((await h.post("read-state-decode", [bad])).status).toBe(400);
  for (const route of [
    "read-state-decode",
    "read-state-sign",
    "read-state-publish",
  ])
    expect(
      (await h.post(route, bad, { Origin: "https://hostile.invalid" })).status,
    ).toBe(403);
  expect(h.calls).toHaveLength(0);
});
it("production reader rejects old, partial, wrong-scope, invalid-signature and duplicate-coordinate snapshot responses", async () => {
  const h = await harness();
  const event = finalizeEvent(
    {
      kind: 30078,
      created_at: 100,
      tags: [["d", "unrelated"]],
      content: "unrelated app",
    },
    h.key,
  );
  const second = finalizeEvent(
    {
      kind: 30078,
      created_at: 101,
      tags: [["d", "unrelated"]],
      content: "replacement",
    },
    h.key,
  );
  for (const response of [
    [],
    { ...h.envelope(), complete: false },
    { ...h.envelope(), read_state_snapshot: 2 },
    { ...h.envelope(), community_id: "11234567-89ab-cdef-0123-456789abcdef" },
    { ...h.envelope(), pubkey: "c".repeat(64) },
    h.envelope([{ ...event, content: "tampered" }]),
    h.envelope([event, second]),
  ]) {
    h.reply(response);
    await expect(h.reader.readStateSnapshot({ fresh: true })).rejects.toThrow();
  }
  h.reply(h.envelope([event]));
  expect(await h.reader.readStateSnapshot({ fresh: true })).toEqual([event]);
}, 15000);

it("broker stops an oversized streamed snapshot before forwarding or parsing it", async () => {
  const h = await harness();
  let cancelled = false,
    pulls = 0;
  h.reply(
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await expect(h.reader.readStateSnapshot({ fresh: true })).rejects.toThrow(
    "500",
  );
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(10);
});
