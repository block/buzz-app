import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import {
  signComputeStatus,
  createComputeStatusSigner,
} from "./compute-status.mjs";
import { relayBrokerPlugin } from "./relay-broker.mjs";
const key = generateSecretKey();
const viewer = getPublicKey(key);
function payload(targets = []) {
  const owner = generateKeyPairSync("ed25519");
  const raw = owner.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const digest = createHash("sha256");
  for (const token of [
    ...new Set(targets.map((t) => t.endpointAddr.trim())),
  ].sort()) {
    const bytes = Buffer.from(token);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  return {
    ownerId: createHash("sha256").update(raw).digest("hex"),
    ownerVerifyingKey: raw.toString("hex"),
    ownerBindingSig: sign(
      null,
      Buffer.from(`buzz-mesh-owner-binding-v1:${viewer}`),
      owner.privateKey,
    ).toString("hex"),
    ownerEndpointBindingSig: sign(
      null,
      Buffer.from(
        `buzz-mesh-owner-endpoint-binding-v1:${viewer}:${digest.digest("hex")}`,
      ),
      owner.privateKey,
    ).toString("hex"),
    serveTargets: targets,
    models: [],
    node_state: "standby",
  };
}
afterEach(() => vi.useRealTimers());
it("signs only the reserved owner coordinate with real member and owner signatures", () => {
  const body = payload([{ modelId: "model", endpointAddr: "endpoint" }]);
  const event = signComputeStatus(body, viewer, key);
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(viewer);
  expect(event.kind).toBe(30003);
  expect(event.tags).toEqual([
    ["d", `buzz-mesh-member-status:${body.ownerId}`],
    ["k", "buzz-mesh-status"],
  ]);
  expect(JSON.parse(event.content)).toEqual(body);
});
it("rejects owner substitution, wrong member, target tampering, and extra data", () => {
  const body = payload([{ modelId: "model", endpointAddr: "endpoint" }]);
  for (const changed of [
    { ...body, ownerId: "0".repeat(64) },
    { ...body, ownerBindingSig: "0".repeat(128) },
    { ...body, serveTargets: [{ modelId: "model", endpointAddr: "other" }] },
    { ...body, gpus: [{ vram_bytes: 123 }] },
    { ...body, my_vram_gb: Infinity },
  ])
    expect(() => signComputeStatus(changed, viewer, key)).toThrow();
  expect(() =>
    signComputeStatus(body, getPublicKey(generateSecretKey()), key),
  ).toThrow(/binding/);
});
it("orders same-second publications and cancels queued status without signing", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const signer = createComputeStatusSigner(viewer, key);
  const body = payload();
  const signal = new AbortController();
  const first = await signer(body, signal.signal);
  const second = signer(body, signal.signal);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await second).created_at).toBe(first.created_at + 1);
  const controller = new AbortController();
  const cancelled = signer(body, controller.signal);
  const assertion = expect(cancelled).rejects.toThrow();
  controller.abort();
  await assertion;
});
it("publishes through the real scoped broker route without exposing a general mesh signer", async () => {
  let handler;
  const events = [];
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  await relayBrokerPlugin({
    relayUrl: "wss://compute.example",
    identity: () => key.slice(),
    authority: async () => ({ relayAuthor: viewer, archiveAuthority: viewer }),
    upstreamFetch: async (url, init) => {
      expect(url).toBe("https://compute.example/events");
      const event = JSON.parse(init.body);
      expect(verifyEvent(event)).toBe(true);
      events.push(event);
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      return Response.json({ accepted: true, event_id: event.id });
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
  const post = (route, body, origin = base) =>
    fetch(`${base}/api/relay/${route}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect(
      (await post("register", { url: "wss://compute.example" })).status,
    ).toBe(200);
    const route = `${encodeURIComponent("https://compute.example")}/compute-status`;
    const body = payload();
    expect((await post(route, body)).status).toBe(200);
    expect(events).toHaveLength(1);
    expect(
      (await post(route, { ...body, ownerBindingSig: "0".repeat(128) })).status,
    ).toBe(400);
    expect((await post(route, body, "https://foreign.example")).status).toBe(
      403,
    );
    expect(
      (
        await post("sign", {
          kind: 30003,
          created_at: 100,
          content: "{}",
          tags: [],
        })
      ).status,
    ).toBe(400);
    expect(events).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
