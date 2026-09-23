import { createHash } from "node:crypto";
import {
  brokerSocket,
  openBrokerSocket,
} from "../../../tests/broker-socket.mjs";
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

it("profiles a first slow publish through real local IPC, signing, authenticated socket, and receipt reconciliation", async () => {
  const viewer = keypair(),
    relay = keypair();
  let handler: RequestListener | undefined;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events = new Map<string, unknown>();
  let published = 0;
  let uploaded = 0;
  const attachmentBytes = new Uint8Array([0, 128, 255]);
  const hash = createHash("sha256").update(attachmentBytes).digest("hex");
  const socket = brokerSocket(async (event: { id: string }) => {
    published++;
    if (published === 1) await delayed;
    events.set(event.id, event);
    return "";
  });
  const upstream: typeof fetch = async (_input, init) => {
    if (String(_input).endsWith("/upload")) {
      uploaded++;
      expect(new Uint8Array(init?.body as Buffer)).toEqual(attachmentBytes);
      expect(init?.method).toBe("PUT");
      return Response.json({
        url: `${fixtureRelayUrl}/media/${hash}.pdf`,
        type: "application/pdf",
        size: 3,
        sha256: hash,
      });
    }
    const body = JSON.parse(init?.body as string);
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
    socketFactory: socket.factory,
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
  // Explicit live-owner boundary before sending; no standalone publication fallback.
  const live = await openBrokerSocket(transport);
  const owner = createRelaySession(
    { ...transport, subscribe: undefined } as unknown as typeof transport,
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    const outbox = owner.session.outbox;
    assert.exists(outbox);
    assert.exists(owner.session.attachments);
    const attachment = await owner.session.attachments.upload(
      new File([attachmentBytes], "report.pdf", { type: "application/pdf" }),
      "c",
      new AbortController().signal,
    );
    expect(attachment.name).toBe("report.pdf");
    const first = owner.session.messages.send("c", "first", [], [attachment]);
    await vi.waitFor(() => expect(published).toBe(1), { timeout: 3000 });
    const pending = owner.session.profiling
      .snapshot()
      .find((sample) => sample.stage === "send.publish" && sample.id === first);
    expect(pending).toMatchObject({ outcome: "pending" });
    expect(uploaded).toBe(1);
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
      (sample) => sample.id === first && sample.stage === "send.publish",
    );
    assert.exists(firstUpstream);
    const secondUpstream = timings.find(
      (sample) => sample.id === second && sample.stage === "send.publish",
    );
    assert.exists(secondUpstream);
    expect(firstUpstream.duration).toBeGreaterThan(0);
    expect(secondUpstream.duration).toBeLessThan(firstUpstream.duration);
    expect(events.get(first)).toMatchObject({
      content: `first\n\n[report.pdf](<${fixtureRelayUrl}/media/${hash}.pdf>)`,
      tags: expect.arrayContaining([
        [
          "imeta",
          `url ${fixtureRelayUrl}/media/${hash}.pdf`,
          "m application/pdf",
          "size 3",
          `x ${hash}`,
          "filename report.pdf",
        ],
      ]),
    });
    expect(
      timings.some(
        (sample) => sample.id === first && sample.stage === "send.sign",
      ),
    ).toBe(true);
    expect(timings.some((sample) => sample.stage === "broker.auth")).toBe(true);
    expect(timings.some((sample) => sample.stage === "read.queue")).toBe(true);
    expect(timings.some((sample) => sample.stage === "read.verify")).toBe(true);
  } finally {
    release();
    owner.dispose();
    live.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
