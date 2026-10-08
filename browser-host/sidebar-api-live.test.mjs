// Opt-in, destructive only to freshly generated identities/channels on a local relay.
// BFF_APP_LIVE_URL, BFF_E2E_OWNER_KEY and BFF_APP_LIVE_EVIDENCE are required.
// This proves network/state integration, not browser IndexedDB or UI behavior.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createSidebarState } from "../src/features/relay/sidebar-state.ts";

const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const liveUrl = process.env.BFF_APP_LIVE_URL;
it.skipIf(!liveUrl)(
  "converges real relay projections across brokers and retries the durable fixed cut",
  async () => {
    const relay = new URL(liveUrl);
    if (
      relay.protocol !== "https:" ||
      relay.hostname !== "localhost" ||
      relay.pathname !== "/"
    )
      throw new Error(
        "Live acceptance requires an isolated https://localhost:<port> relay",
      );
    const ownerHex = process.env.BFF_E2E_OWNER_KEY;
    const output = process.env.BFF_APP_LIVE_EVIDENCE;
    if (!ownerHex || !/^[0-9a-f]{64}$/.test(ownerHex) || !output)
      throw new Error(
        "Throwaway owner and durable evidence directory required",
      );
    const dir = resolve(output, randomUUID());
    mkdirSync(dir, { recursive: true });
    const records = [];
    const save = (record) => {
      records.push(record);
      writeFileSync(
        resolve(dir, "TRANSCRIPT.json"),
        JSON.stringify(records, null, 2),
      );
    };
    const owner = Uint8Array.from(Buffer.from(ownerHex, "hex"));
    const alice = generateSecretKey(),
      bob = generateSecretKey(),
      carol = generateSecretKey();
    const channel = randomUUID();
    const signal = () => AbortSignal.timeout(10000);
    const timestamp = () => Math.floor(Date.now() / 1000);
    async function publish(
      key,
      kind,
      tags,
      content = "",
      created_at = timestamp(),
    ) {
      const event = finalizeEvent({ kind, tags, content, created_at }, key);
      const url = new URL("events", relay).href;
      const body = JSON.stringify(event);
      const auth = finalizeEvent(
        {
          kind: 27235,
          created_at: timestamp(),
          content: "",
          tags: [
            ["u", url],
            ["method", "POST"],
            ["payload", createHash("sha256").update(body).digest("hex")],
            ["nonce", randomUUID()],
          ],
        },
        key,
      );
      const response = await fetch(url, {
        method: "POST",
        signal: signal(),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
        },
        body,
      });
      const result = await response.json();
      save({ stage: "seed", event, status: response.status, result });
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.accepted, JSON.stringify(result)).toBe(true);
      return event;
    }
    for (const key of [alice, bob, carol])
      await publish(owner, 9030, [["p", getPublicKey(key)]]);
    await publish(alice, 9007, [
      ["h", channel],
      ["name", `app-live-${channel}`],
      ["channel_type", "stream"],
      ["visibility", "open"],
    ]);
    for (const key of [bob, carol])
      await publish(alice, 9000, [
        ["h", channel],
        ["p", getPublicKey(key)],
      ]);
    const baseTime = timestamp() - 60;
    const message = (name, offset, root) =>
      publish(
        bob,
        9,
        [
          ["h", channel],
          ...(root
            ? [
                ["e", root.id, "", "root"],
                ["e", root.id, "", "reply"],
              ]
            : []),
        ],
        name,
        baseTime + offset,
      );
    const root = await message("root", 0);
    const reply = await message("reply", 1, root);
    const top = await message("top", 2);

    async function broker(key, label) {
      let handler,
        loseNextWrite = false;
      const calls = [];
      const server = createServer((req, res) => {
        req.headers.origin ??= `http://${req.headers.host}`;
        handler(req, res, () => {
          res.statusCode = 404;
          res.end();
        });
      });
      const plugin = relayBrokerPlugin({
        archiveFile: ":memory:",
        relayUrl: relay.href,
        communityAliases: JSON.stringify({ local: relay.href }),
        identity: () => key.slice(),
        // Observe actual wire bytes; the relay computes every response. Only the
        // deliberate lost-ack fault replaces a response after the real commit.
        upstreamFetch: async (url, init) => {
          const response = await fetch(url, init);
          if (new URL(url).pathname.startsWith("/buzz/v1/")) {
            const auth = JSON.parse(
              Buffer.from(
                init.headers.Authorization.slice(6),
                "base64",
              ).toString(),
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
            const record = {
              stage: "wire",
              label,
              url: String(url),
              method: init.method,
              body: init.body,
              auth,
              status: response.status,
              response: await response.clone().json(),
            };
            calls.push(record);
            save(record);
            if (loseNextWrite && init.method === "POST") {
              loseNextWrite = false;
              expect(response.status).toBe(200);
              expect(record.response.outcomes).toEqual([{ status: "applied" }]);
              await response.body?.cancel();
              throw new Error(
                "Injected lost acknowledgement after real relay commit",
              );
            }
          }
          return response;
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
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      disposals.push(async () => {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      });
      const transport = await connectBrokerTransport(
        `http://127.0.0.1:${server.address().port}`,
      );
      expect(transport.sidebarApi).toBeDefined();
      return {
        api: transport.sidebarApi,
        calls,
        loseWriteAck() {
          loseNextWrite = true;
        },
      };
    }
    // File-backed acceptance adapter: bytes survive state-owner disposal/reopen.
    // Browser transaction and cross-window guarantees have separate tests.
    function storage(name) {
      const path = resolve(dir, `${name}.json`);
      let closed = false;
      return {
        async update(change) {
          if (closed) throw new Error("Storage closed");
          let current;
          try {
            current = JSON.parse(readFileSync(path, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            current = { pending: [], manual: [] };
          }
          const next = change(current);
          writeFileSync(`${path}.next`, JSON.stringify(next));
          renameSync(`${path}.next`, path);
          return next;
        },
        close() {
          closed = true;
        },
      };
    }
    function state(broker, partition) {
      const s = createSidebarState({
        api: broker.api,
        storage: storage(partition),
        allowed: (id) => id === channel,
      });
      disposals.push(() => s.dispose());
      return s;
    }
    const a = await broker(alice, "alice-one"),
      a2 = await broker(alice, "alice-two"),
      c = await broker(carol, "carol");
    let first = state(a, "alice-one");
    const second = state(a2, "alice-two"),
      other = state(c, "carol");
    const exact = (value) => ({ status: "exact", value });
    const target = { channel_id: channel };
    const thread = { channel_id: channel, root_id: root.id };
    const queries = [
      { target, message_ids: [root.id, top.id] },
      { target: thread, message_ids: [reply.id] },
    ];
    async function counts(s, n) {
      await s.refresh();
      expect(s.sync().status, s.sync().error).toBe("ready");
      expect(s.row(channel).unread).toEqual(exact(n));
      save({
        stage: "projection",
        expected: n,
        row: s.row(channel),
        sync: s.sync(),
      });
    }
    async function write(intent) {
      expect(await a.api.write([intent], signal())).toEqual([
        { status: "applied" },
      ]);
    }
    await counts(first, 3);
    await counts(second, 3);
    await counts(other, 3);
    expect(first.row(channel)).toMatchObject({
      latest_message_id: top.id,
      latest_message_at: top.created_at,
      latest_message_complete: true,
      threads: {
        complete: true,
        items: [
          { root_id: root.id, latest_reply_id: reply.id, unread: exact(1) },
        ],
      },
    });
    const leases = queries.map((q) => first.retain(q));
    await Promise.all(leases.map((l) => l.ready));
    expect(first.context(thread).messages[0].status).toBe("unread");
    // A timeline mark must not consume the earlier reply in the independent thread.
    await write({ type: "mark_through", target, message_id: top.id });
    await counts(first, 1);
    await counts(second, 1);
    await counts(other, 3);
    expect(first.context(target).messages.map((m) => m.status)).toEqual([
      "read",
      "read",
    ]);
    expect(first.context(thread).messages[0].status).toBe("unread");
    await write({ type: "mark_through", target: thread, message_id: reply.id });
    await counts(first, 0);
    const t2 = await message("timeline-after-mark", 3);
    const r2 = await message("reply-after-thread-mark", 4, root);
    await counts(first, 2);
    await write({ type: "mark_through", target: thread, message_id: r2.id });
    await counts(first, 1);
    const r3 = await message("whole-cut-anchor-reply", 5, root);
    first.invalidate(channel);
    await expect.poll(() => first.row(channel)?.latest_message_id).toBe(r3.id);
    expect(first.row(channel).unread).toEqual(exact(2));

    const localMark = { kind: "channel", channelId: channel };
    await first.journal.markUnread(localMark, () => true);
    const anchored = {
      intent: {
        type: "mark_channel_read",
        channel_id: channel,
        message_id: r3.id,
      },
      createdAt: r3.created_at,
    };
    a.loseWriteAck();
    await first.enqueue(
      [anchored],
      () => false,
      () => true,
    );
    await expect.poll(() => first.sync().status).toBe("error");
    expect(first.journal.snapshot().pending).toHaveLength(1);
    const saved = JSON.parse(
      readFileSync(resolve(dir, "alice-one.json"), "utf8"),
    );
    expect(saved.pending[0].intent).toEqual(anchored.intent);
    save({ stage: "lost-ack-persisted", journal: saved });
    for (const l of leases) l.dispose();
    first.dispose();
    // New traffic arrives AFTER the committed cut and BEFORE reopening/retry.
    const r4 = await message("must-survive-fixed-retry", 6, root);
    const t3 = await message("also-must-survive", 7);
    first = state(a, "alice-one");
    await first.retry();
    expect(first.journal.snapshot().pending).toHaveLength(0);
    expect(first.journal.manual(localMark)).toBe(true);
    expect(second.journal.manual(localMark)).toBe(false);
    await counts(first, 2);
    await counts(second, 2);
    await counts(other, 8);
    const cuts = a.calls.filter(
      (call) =>
        call.method === "POST" &&
        JSON.parse(call.body).intents[0].type === "mark_channel_read",
    );
    expect(cuts).toHaveLength(2);
    expect(cuts[0].body).toBe(cuts[1].body);
    expect(cuts[0].auth.id).not.toBe(cuts[1].auth.id);
    const contexts = await a.api.contexts(
      [
        { target, message_ids: [t2.id, t3.id] },
        { target: thread, message_ids: [r3.id, r4.id] },
      ],
      signal(),
    );
    expect(
      contexts.contexts.map((ctx) => ctx.messages.map((m) => m.status)),
    ).toEqual([
      ["read", "unread"],
      ["read", "unread"],
    ]);
    await first.enqueue(
      [],
      (t) => t.channelId === channel,
      () => true,
    );
    expect(first.journal.manual(localMark)).toBe(false);
    save({
      stage: "PASS",
      channel,
      contexts,
      limits:
        "real network/state integration; no browser UI, native durability, performance or restart verdict",
    });
  },
  60000,
);
