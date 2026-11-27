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
            content: input.text,
            tags: [["h", channel]],
          }),
          name: () => "Scheduled fixture",
        },
      );
    const first = service(lifetime.signal);
    const message = {
      channelId: channel,
      text: "Survives a closed session",
      recipients: [],
      references: [],
      attachments: [],
      picks: {},
    };
    const initialSendAt = Date.now() + 6000;
    await first.create(message, initialSendAt);
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
    await expect(first.create(message, initialSendAt)).rejects.toThrow();
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
    await next.create(
      { ...message, text: "Cancel this" },
      Date.now() + 86400000,
    );
    let rows = await next.list(nextLifetime.signal);
    const cancel = rows.find((row) => row.content === "Cancel this");
    if (!cancel) throw new Error("Expected message to cancel");
    await next.cancel(cancel.id, cancel.revision);
    rows = await next.list(nextLifetime.signal);
    expect(rows.some((row) => row.id === cancel.id)).toBe(false);
    await next.create(
      { ...message, text: "Reschedule this" },
      Date.now() + 86400000,
    );
    rows = await next.list(nextLifetime.signal);
    const scheduled = rows.find((row) => row.content === "Reschedule this");
    if (!scheduled) throw new Error("Expected message to reschedule");
    const sendAt = Math.floor(Date.now() / 1000 + 6) * 1000;
    await next.reschedule(scheduled.id, scheduled.revision, sendAt);
    rows = await next.list(nextLifetime.signal);
    const revised = rows.find((row) => row.id === scheduled.id);
    if (!revised) throw new Error("Expected rescheduled message");
    expect(revised).toMatchObject({ content: scheduled.content, sendAt });
    expect(Number(revised.revision)).toBeGreaterThan(
      Number(scheduled.revision),
    );
    await expect(next.cancel(scheduled.id, scheduled.revision)).rejects.toThrow(
      "Refresh",
    );
    for (let i = 0; i < 40; i++) {
      rows = await next.list(nextLifetime.signal);
      if (rows.find((row) => row.id === scheduled.id)?.status === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(rows.find((row) => row.id === scheduled.id)?.status).toBe("sent");
    const query = await post("/query", [
      { kinds: [9], "#h": [channel], limit: 100 },
    ]);
    const events = await query.json();
    expect(
      events.map((event: { content: string }) => event.content).sort(),
    ).toEqual(["Reschedule this", "Survives a closed session"]);
    expect(new Set(events.map((event: { id: string }) => event.id)).size).toBe(
      2,
    );
    nextLifetime.abort();
  },
  30000,
);
