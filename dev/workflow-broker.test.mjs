import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { WORKFLOW_READ_BYTES } from "../src/features/workflows/http.ts";

const id = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const cursor = { before: "2026-09-12T14:44:19.123456+00:00", beforeId: runId };
async function harness(
  respond = () => Response.json({ runs: [], next: null }),
) {
  const key = new Uint8Array(32);
  key[31] = 8;
  const viewer = getPublicKey(key),
    calls = [],
    logs = [];
  let handler;
  const server = createServer((req, res) => {
    if (!req.headers.origin) req.headers.origin = `http://${req.headers.host}`;
    handler(req, res);
  });
  await relayBrokerPlugin({
    relayUrl: "https://a.workflow.test",
    communityAliases: JSON.stringify({ secondary: "https://b.workflow.test" }),
    identity: () => key,
    authority: async () => ({ relayAuthor: viewer }),
    upstreamFetch: async (url, init) => {
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      const call = { url: String(url), init, auth };
      calls.push(call);
      return respond(call);
    },
  }).configureServer({
    httpServer: server,
    config: {
      logger: {
        info() {},
        error(text) {
          logs.push(text);
        },
      },
    },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    logs,
    post: (route, body, headers = {}) =>
      fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const signal = () => new AbortController().signal;
it("real broker scoped history signs exact GET path/cursor and captured principal without startup reads or workflow writes", async () => {
  const h = await harness(({ url }) =>
    Response.json(
      url.endsWith("approvals") ? { approvals: [] } : { runs: [], next: null },
    ),
  );
  try {
    const first = await connectBrokerTransport(h.base);
    const other = await connectBrokerTransport(h.base, undefined, "secondary");
    expect(h.calls).toHaveLength(0);
    expect(first.writer.kinds).toEqual([9]);
    expect(first.workflows.lifecycleVersion).toBeUndefined();
    await first.workflows.runs(id, cursor, signal());
    await other.workflows.approvals(id, runId, signal());
    await first.workflows.runs(id, undefined, signal());
    expect(h.calls.map((call) => call.url)).toEqual([
      `https://a.workflow.test/workflows/${id}/runs?limit=20&before=2026-09-12T14%3A44%3A19.123456%2B00%3A00&before_id=${runId}`,
      `https://b.workflow.test/workflows/${id}/runs/${runId}/approvals`,
      `https://a.workflow.test/workflows/${id}/runs?limit=20`,
    ]);
    for (const { url, init, auth } of h.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      expect(auth.tags).toContainEqual(["u", url]);
      expect(auth.tags).toContainEqual(["method", "GET"]);
      expect(auth.tags.some(([name]) => name === "payload")).toBe(false);
      expect(auth.tags.some(([name]) => name === "nonce")).toBe(true);
    }
    expect(new Set(h.calls.map(({ auth }) => auth.id)).size).toBe(3);
  } finally {
    await h.close();
  }
});
it("broker rejects arbitrary targets, cursors, limits and untrusted origin before upstream dispatch", async () => {
  const h = await harness();
  try {
    for (const body of [
      null,
      { id: "../secret" },
      { id, limit: 100 },
      { id, url: "https://evil.test" },
      { id, cursor: { before: cursor.before } },
      { id, cursor: { ...cursor, before: "not a date" } },
      { id, cursor: { ...cursor, beforeId: "../" } },
      { id, cursor: null },
    ]) {
      expect((await h.post("workflow-runs", body)).status).toBe(400);
    }
    expect(
      (await h.post("workflow-approvals", { id, runId: "../" })).status,
    ).toBe(400);
    expect(
      (await h.post("workflow-runs", { id }, { Origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});
it("workflow quota gates the existing query lane while another community remains independent", async () => {
  const h = await harness(({ url }) =>
    url.startsWith("https://a.")
      ? Response.json(
          { error: "rate-limited: quota exceeded; retry in 0s" },
          { status: 429 },
        )
      : Response.json([]),
  );
  try {
    const transport = await connectBrokerTransport(h.base);
    await expect(
      transport.workflows.runs(id, undefined, signal()),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
    await expect(
      transport.query([{ kinds: [0], limit: 1 }]),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.calls).toHaveLength(1);
    const other = await connectBrokerTransport(h.base, undefined, "secondary");
    await other.query([{ kinds: [0], limit: 1 }]);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});
it("workflow 404 remains unavailable, over-budget body is cancelled without leaking bytes", async () => {
  let large = false,
    cancelled = false;
  const h = await harness(() =>
    large
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  "PRIVATE".repeat(Math.ceil(WORKFLOW_READ_BYTES / 7) + 1),
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
        )
      : Response.json({ error: "PRIVATE missing workflow" }, { status: 404 }),
  );
  try {
    const transport = await connectBrokerTransport(h.base);
    await expect(
      transport.workflows.runs(id, undefined, signal()),
    ).rejects.toMatchObject({ status: 404 });
    large = true;
    await expect(
      transport.workflows.runs(id, undefined, signal()),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(h.logs.join(" ")).not.toContain("PRIVATE");
  } finally {
    await h.close();
  }
});
it("closing workflow interest aborts the actual broker upstream request", async () => {
  const h = await harness(
    ({ init }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      }),
  );
  try {
    const transport = await connectBrokerTransport(h.base),
      cancel = new AbortController();
    const pending = transport.workflows.runs(id, undefined, cancel.signal);
    const rejection = expect(pending).rejects.toThrow();
    for (let i = 0; i < 100 && !h.calls.length; i++) await delay(5);
    expect(h.calls).toHaveLength(1);
    cancel.abort();
    await rejection;
    for (let i = 0; i < 100 && !h.calls[0].init.signal.aborted; i++)
      await delay(5);
    expect(h.calls[0].init.signal.aborted).toBe(true);
  } finally {
    await h.close();
  }
});
