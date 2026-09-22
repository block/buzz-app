import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { test, expect, vi } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createRelaySession } from "../src/features/relay/session.ts";
import { attachmentMarkdown } from "../src/features/relay/attachments.ts";

async function harness() {
  const key = generateSecretKey();
  const relay = "https://relay.test";
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  let handler;
  let status = 200;
  let held;
  const calls = [];
  const blobs = new Map();
  const publications = [];
  const plugin = relayBrokerPlugin({
    relayUrl: relay,
    authorizedViewer: getPublicKey(key),
    identity: () => key,
    authority: async () => ({ relayAuthor: getPublicKey(key) }),
    socketFactory: () => {
      const socket = {
        readyState: 1,
        send(text) {
          const [kind, id] = JSON.parse(text);
          if (kind === "AUTH")
            queueMicrotask(() => socket.receive(["OK", id.id, true]));
          if (kind === "REQ")
            queueMicrotask(() => socket.receive(["EOSE", id]));
          if (kind === "EVENT") {
            publications.push(id);
            queueMicrotask(() => socket.receive(["OK", id.id, true]));
          }
        },
        receive(frame) {
          if (socket.readyState === 1)
            socket.onmessage?.({ data: JSON.stringify(frame) });
        },
        close() {
          socket.readyState = 3;
          socket.onclose?.();
        },
      };
      queueMicrotask(() => socket.receive(["AUTH", "fixture"]));
      return socket;
    },
    upstreamFetch: async (url, init) => {
      if (String(url).endsWith("/upload")) {
        calls.push({ url, init });
        const hash = createHash("sha256").update(init.body).digest("hex");
        const result = {
          url: `${relay}/media/${hash}.txt`,
          sha256: hash,
          type: "text/plain",
          size: init.body.length,
        };
        blobs.set(result.url, init.body);
        if (held) await held;
        return status === 200
          ? Response.json(result)
          : new Response("media contains metadata", { status });
      }
      if (blobs.has(String(url)))
        return new Response(blobs.get(String(url)), {
          headers: { "Content-Type": "text/plain" },
        });
      return Response.json([]);
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
  const base = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch;
  const fetcher = (url, init = {}) =>
    nativeFetch(url, { ...init, headers: { ...init.headers, Origin: base } });
  return {
    base,
    key,
    relay,
    calls,
    publications,
    fetcher,
    nativeFetch,
    status(value) {
      status = value;
    },
    hold(value) {
      held = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
test("real broker signs binary uploads and exposes safe authenticated downloads", async () => {
  const h = await harness();
  const original = globalThis.fetch;
  globalThis.fetch = h.fetcher;
  try {
    const transport = await connectBrokerTransport(h.base);
    const owner = createRelaySession(transport, {
      outboxStorage: { load: () => [], save() {} },
    });
    try {
      const file = new File(["hello file"], "notes.txt", {
        type: "text/plain",
      });
      const result = await owner.session.attachments.upload(
        file,
        "c",
        new AbortController().signal,
      );
      const call = h.calls[0];
      const auth = JSON.parse(
        Buffer.from(
          call.init.headers.Authorization.slice(6),
          "base64url",
        ).toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(getPublicKey(h.key));
      expect(auth.tags).toContainEqual(["server", "relay.test"]);
      expect(auth.tags).toContainEqual(["x", result.sha256]);
      expect(call.init.body.toString()).toBe("hello file");
      expect(call.init.redirect).toBe("error");
      const content = attachmentMarkdown(file.name, result);
      expect(content).toContain(result.url);
      owner.session.messages.send("c", content);
      await vi.waitFor(() => expect(h.publications).toHaveLength(1));
      expect(h.publications[0].content).toBe(content);
      expect(h.publications[0].tags).toContainEqual(["h", "c"]);
      expect(verifyEvent(h.publications[0])).toBe(true);
      owner.session.messages.reply("c", "b".repeat(64), content);
      await vi.waitFor(() => expect(h.publications).toHaveLength(2));
      expect(h.publications[1].tags).toContainEqual([
        "e",
        "b".repeat(64),
        "",
        "reply",
      ]);
      const response = await h.fetcher(owner.session.download(result.url));
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox",
      );
      expect(await response.text()).toBe("hello file");
      expect(
        owner.session.download("https://evil.test/media/a.txt"),
      ).toBeUndefined();
      h.status(400);
      await expect(
        transport.uploadAttachment(file, new AbortController().signal),
      ).rejects.toMatchObject({ code: "metadata" });
      const denied = await h.nativeFetch(`${h.base}/api/relay/upload`, {
        method: "POST",
        body: file,
        headers: { Origin: "https://evil.test" },
      });
      expect(denied.status).toBe(403);
    } finally {
      owner.dispose();
    }
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

test("session disposal cancels upload results", async () => {
  const h = await harness();
  const original = globalThis.fetch;
  globalThis.fetch = h.fetcher;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.hold(gate);
  try {
    const transport = await connectBrokerTransport(h.base);
    const owner = createRelaySession(transport, {
      outboxStorage: { load: () => [], save() {} },
    });
    const attempt = owner.session.attachments.upload(
      new File(["hold"], "held.txt"),
      "c",
      new AbortController().signal,
    );
    const rejected = expect(attempt).rejects.toThrow();
    owner.dispose();
    await rejected;
  } finally {
    release();
    globalThis.fetch = original;
    await h.close();
  }
});
