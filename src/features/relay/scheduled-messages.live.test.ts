import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { createScheduledMessages } from "./scheduled-messages";

const relay = process.env.BUZZ_SCHEDULED_TEST_RELAY;
it.skipIf(!relay)(
  "delivers through a local relay after the scheduling session closes",
  async () => {
    if (!relay) throw new Error("Local relay URL is required");
    const base = new URL(relay);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["127.0.0.1", "localhost"].includes(base.hostname)
    )
      throw new Error(
        "Live scheduling tests require an isolated loopback relay",
      );
    const key = generateSecretKey(),
      viewer = getPublicKey(key),
      channel = crypto.randomUUID();
    async function post(path: string, body: unknown, secret = key) {
      const text = JSON.stringify(body);
      const auth = finalizeEvent(
        {
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [
            ["u", `${base.origin}${path}`],
            ["method", "POST"],
            ["payload", createHash("sha256").update(text).digest("hex")],
            ["nonce", crypto.randomUUID()],
          ],
        },
        secret,
      );
      return fetch(`${base.origin}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
        },
        body: text,
        signal: AbortSignal.timeout(10000),
      });
    }
    const created = await post(
      "/events",
      finalizeEvent(
        {
          kind: 9007,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [
            ["h", channel],
            ["name", `scheduled-${channel.slice(0, 8)}`],
          ],
        },
        key,
      ),
    );
    expect(await created.text()).toContain("true");
    const operations: unknown[] = [];
    const lifetime = new AbortController();
    const service = (signal: AbortSignal) =>
      createScheduledMessages(
        {
          sign: async (template) => finalizeEvent(template, key),
          request: (body) => {
            operations.push(structuredClone(body));
            return post("/scheduled-messages", body);
          },
        },
        {
          viewer,
          signal,
          prepare: (input) => ({
            kind: 9,
            content: input.content,
            tags: [["h", channel]],
          }),
          name: () => "Scheduled fixture",
        },
      );
    const first = service(lifetime.signal);
    const input = {
      destination: { channelId: channel, name: "Scheduled fixture" },
      content: "Survives a closed session",
      sendAt: Date.now() + 6000,
    };
    await first.create(input);
    const [queued] = await first.list(lifetime.signal);
    expect(queued?.status).toBe("scheduled");
    if (!queued) throw new Error("Expected queued message");
    const foreign = await post(
      "/scheduled-messages",
      { action: "list" },
      generateSecretKey(),
    );
    expect((await foreign.json()).messages).toEqual([]);
    lifetime.abort();
    await expect(first.create(input)).rejects.toThrow();
    const nextLifetime = new AbortController(),
      next = service(nextLifetime.signal);
    let delivered = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rows = await next.list(nextLifetime.signal);
      if (rows.find((row) => row.id === queued.id)?.status === "sent") {
        delivered = true;
        break;
      }
    }
    expect(delivered).toBe(true);
    const createReplay = await post(
      "/scheduled-messages",
      operations.find(
        (body) => (body as { action?: string }).action === "create",
      ),
    );
    expect(createReplay.status).toBe(200);
    await next.create({
      ...input,
      content: "Cancel this",
      sendAt: Date.now() + 86400000,
    });
    let rows = await next.list(nextLifetime.signal);
    const cancel = rows.find((row) => row.content === "Cancel this");
    if (!cancel) throw new Error("Expected message to cancel");
    await next.cancel(cancel.id, cancel.revision);
    rows = await next.list(nextLifetime.signal);
    expect(rows.some((row) => row.id === cancel.id)).toBe(false);
    await next.create({
      ...input,
      content: "Edit this",
      sendAt: Date.now() + 86400000,
    });
    rows = await next.list(nextLifetime.signal);
    const edit = rows.find((row) => row.content === "Edit this");
    if (!edit) throw new Error("Expected message to edit");
    await next.update(edit.id, edit.revision, {
      ...input,
      content: "Edited and sent now",
      sendAt: Date.now() + 86400000,
    });
    rows = await next.list(nextLifetime.signal);
    const revised = rows.find((row) => row.id === edit.id);
    if (!revised) throw new Error("Expected updated message");
    expect(Number(revised.revision)).toBeGreaterThan(Number(edit.revision));
    await expect(next.cancel(edit.id, edit.revision)).rejects.toThrow(
      "Refresh",
    );
    await next.sendNow(revised.id, revised.revision);
    for (let i = 0; i < 30; i++) {
      rows = await next.list(nextLifetime.signal);
      if (rows.find((row) => row.id === edit.id)?.status === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(rows.find((row) => row.id === edit.id)?.status).toBe("sent");
    const sendReplay = await post(
      "/scheduled-messages",
      operations.find(
        (body) => (body as { action?: string }).action === "send_now",
      ),
    );
    expect(sendReplay.status).toBe(200);
    rows = await next.list(nextLifetime.signal);
    expect(rows.find((row) => row.id === edit.id)?.revision).toBe(
      String(Number(revised.revision) + 1),
    );
    const query = await post("/query", [
      { kinds: [9], "#h": [channel], limit: 100 },
    ]);
    const events = await query.json();
    expect(
      events.map((event: { content: string }) => event.content).sort(),
    ).toEqual(["Edited and sent now", "Survives a closed session"]);
    expect(new Set(events.map((event: { id: string }) => event.id)).size).toBe(
      2,
    );
    nextLifetime.abort();
  },
  30000,
);
