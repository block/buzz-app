import {
  fixtureRelayUrl,
  fixtureAliases,
} from "../../../tests/relay-config.ts";
import { writeProfile } from "./profiling-test";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { assert, expect, it, vi } from "vitest";
import { relayBrokerPlugin } from "../../../dev/relay-broker.mjs";
import { connectBrokerTransport } from "./transport";
import { createRelaySession } from "./session";
import { keypair } from "./testing";

it("profiles a first slow publish through real local HTTP, signing, broker auth, and receipt reconciliation", async () => {
  const viewer = keypair(),
    relay = keypair();
  let handler: RequestListener | undefined;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events = new Map<string, unknown>();
  let published = 0;
  const upstream: typeof fetch = async (input, init) => {
    const body = JSON.parse(init?.body as string);
    if (String(input).endsWith("/events")) {
      published++;
      if (published === 1) await delayed;
      events.set(body.id, body);
      return Response.json({ accepted: true, event_id: body.id });
    }
    return Response.json(
      (body[0]?.ids ?? []).flatMap((id: string) => events.get(id) ?? []),
    );
  };
  const server = createServer((req, res) => {
    // Node's fetch does not supply browser Origin; emulate the browser at this local-only boundary.
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => viewer.secret,
    authority: async () => ({ relayAuthor: relay.pubkey }),
    upstreamFetch: upstream,
  });
  const configure = plugin.configureServer as (
    server: ViteDevServer,
  ) => Promise<void>;
  await configure({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback: RequestListener) {
        handler = callback;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = await connectBrokerTransport(base);
  // EventSource is browser-owned; this integration covers the actual HTTP write/read path.
  const owner = createRelaySession(
    { ...transport, subscribe: undefined } as unknown as typeof transport,
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    const outbox = owner.session.outbox;
    assert.exists(outbox);
    const first = owner.session.messages.send("c", "first");
    await vi.waitFor(() => expect(published).toBe(1), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pending = owner.session.profiling
      .snapshot()
      .find((sample) => sample.stage === "send.publish" && sample.id === first);
    expect(pending).toMatchObject({ outcome: "pending" });
    release();
    await vi.waitFor(() => expect(outbox.snapshot()).toHaveLength(0), {
      timeout: 3000,
    });
    const second = owner.session.messages.send("c", "second");
    await vi.waitFor(() => expect(outbox.snapshot()).toHaveLength(0), {
      timeout: 3000,
    });
    writeProfile("broker", owner.session.profiling);
    const timings = owner.session.profiling.snapshot();
    const firstUpstream = timings.find(
      (sample) => sample.id === first && sample.stage === "broker.upstream",
    );
    assert.exists(firstUpstream);
    const secondUpstream = timings.find(
      (sample) => sample.id === second && sample.stage === "broker.upstream",
    );
    assert.exists(secondUpstream);
    expect(firstUpstream.duration).toBeGreaterThanOrEqual(25);
    expect(secondUpstream.duration).toBeLessThan(firstUpstream.duration);
    const admission = timings.find(
      (sample) => sample.id === second && sample.stage === "broker.admission",
    );
    assert.exists(admission);
    expect(admission.duration).toBeGreaterThan(secondUpstream.duration);
    expect(
      timings.some(
        (sample) => sample.id === first && sample.stage === "send.sign",
      ),
    ).toBe(true);
    expect(
      timings.some(
        (sample) => sample.id === first && sample.stage === "broker.auth",
      ),
    ).toBe(true);
    expect(timings.some((sample) => sample.stage === "read.queue")).toBe(true);
    expect(timings.some((sample) => sample.stage === "read.verify")).toBe(true);
  } finally {
    release();
    owner.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
