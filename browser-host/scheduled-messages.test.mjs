import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { brokerSocket } from "../tests/broker-socket.mjs";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createScheduledMessages } from "../src/features/relay/scheduled-messages.ts";

it("uses advertised scheduling through the authenticated fixed broker route", async () => {
  const key = new Uint8Array(32);
  key[31] = 19;
  const viewer = getPublicKey(key),
    calls = [];
  const socket = brokerSocket(() => "scheduled-result");
  let handler, queued;
  const server = createServer((req, res) => {
    if (!req.headers.origin) req.headers.origin = `http://${req.headers.host}`;
    void handler(req, res);
  });
  await relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: "https://relay.example",
    identity: () => key,
    socketFactory: socket.factory,
    upstreamFetch: async (url, init) => {
      if (init.headers.Accept === "application/nostr+json")
        return Response.json({
          self: viewer,
          supported_extensions: ["buzz-scheduled-messages-v1"],
        });
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.tags).toContainEqual([
        "u",
        "https://relay.example/scheduled-messages",
      ]);
      expect(auth.tags).toContainEqual(["method", "POST"]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      expect(String(url)).toBe("https://relay.example/scheduled-messages");
      expect(init.redirect).toBe("error");
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === "create") {
        queued = body;
        return Response.json({ accepted: true });
      }
      if (body.action === "list")
        return Response.json({
          messages: [
            {
              ...queued,
              revision: 1,
              send_at: queued.event.created_at,
              status: "scheduled",
            },
          ],
        });
      return Response.json({ error: "Changed" }, { status: 409 });
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
  try {
    const transport = await connectBrokerTransport(
      `http://127.0.0.1:${server.address().port}`,
    );
    expect(transport.scheduledMessages).toBeDefined();
    const service = createScheduledMessages(transport.scheduledMessages, {
      viewer,
      signal: new AbortController().signal,
      prepare: (input) => ({
        kind: 9,
        content: input.content,
        tags: [["h", input.destination.channelId]],
      }),
      name: () => "Launch",
    });
    await service.create({
      destination: {
        channelId: "11111111-1111-4111-8111-111111111111",
        name: "Launch",
      },
      content: "Tomorrow",
      sendAt: Date.now() + 86400000,
    });
    expect(verifyEvent(queued.event)).toBe(true);
    expect(queued.event.pubkey).toBe(viewer);
    const [row] = await service.list(new AbortController().signal);
    expect(row.content).toBe("Tomorrow");
    await expect(service.cancel(row.id, row.revision)).rejects.toThrow(
      "changed",
    );
    expect(calls.map((call) => call.action)).toEqual([
      "create",
      "list",
      "cancel",
    ]);
    expect(socket.publications).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
