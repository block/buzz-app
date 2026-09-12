import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { connectSignedTransport } from "./transport";
import { createRelayReader } from "./reader";
import { keypair, signed } from "./testing";
import { isPresenceSnapshot } from "./presence-contract";

const snapshot = [{ kinds: [20001], authors: ["a".repeat(64)], limit: 1 }];
const ordinary = [{ kinds: [9], limit: 1 }];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.useFakeTimers();
  // Keep hashing real but immediate: no native-worker scheduling in a fake-time admission model.
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (_algorithm, data) =>
      Uint8Array.from(
        createHash("sha256")
          .update(new Uint8Array(data as ArrayBuffer))
          .digest(),
      ).buffer,
  );
  const key = keypair();
  const signer = {
    getPublicKey: async () => key.pubkey,
    signEvent: vi.fn(async (event: EventTemplate) => signed(key, event)),
  };
  const transport = await connectSignedTransport(
    signer,
    "https://presence-admission.test",
    key.pubkey,
  );
  return { key, signer, transport };
}
it("actual reader-to-signed-fetch presence bypass leaves ordinary pacing unchanged and retains held response ownership", async () => {
  const h = await setup();
  const calls: { presence: boolean; at: number }[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const presence = isPresenceSnapshot(JSON.parse(init.body as string));
    calls.push({ presence, at: performance.now() });
    if (presence) await held;
    return Response.json([]);
  });
  const r = createRelayReader(h.transport);
  try {
    await r.reader.read(ordinary);
    await vi.advanceTimersByTimeAsync(100);
    const p = r.reader.read(snapshot, { priority: "background" });
    await vi.advanceTimersByTimeAsync(0);
    const f = r.reader.read(ordinary);
    await vi.advanceTimersByTimeAsync(400);
    await f;
    expect(calls).toEqual([
      { presence: false, at: 0 },
      { presence: true, at: 100 },
      { presence: false, at: 500 },
    ]);
    await expect(h.transport.query(snapshot)).rejects.toThrow("capacity");
    release();
    await p;
    const next = h.transport.query(snapshot);
    await vi.advanceTimersByTimeAsync(4600);
    await next;
    expect(calls.at(-1)).toEqual({ presence: true, at: 5100 });
  } finally {
    release();
    r.dispose();
  }
});
it("aborted snapshot signing retains preparation across constructor recreation, while ordinary signing proceeds", async () => {
  const h = await setup();
  const fetcher = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  let release!: (event: VerifiedEvent) => void;
  let template!: EventTemplate;
  h.signer.signEvent.mockImplementationOnce(async (event) => {
    template = event;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const c = new AbortController();
  const pending = h.transport.query(snapshot, c.signal);
  const failed = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  c.abort();
  const other = await connectSignedTransport(
    { ...h.signer },
    "https://presence-admission.test/",
    h.key.pubkey,
  );
  for (let i = 0; i < 5; i++)
    await expect(other.query(snapshot)).rejects.toThrow("capacity");
  await other.query(ordinary);
  expect(h.signer.signEvent).toHaveBeenCalledTimes(2);
  release(signed(h.key, template));
  await failed;
  await other.query(snapshot);
  expect(fetcher).toHaveBeenCalledTimes(2); // Never dispatch the abandoned signed snapshot.
});
it("snapshot preparation stays owned through an unabortable body; correlated quota pauses ordinary callers", async () => {
  const h = await setup();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            body = c;
          },
        }),
      ),
  );
  const c = new AbortController();
  const pending = h.transport.query(snapshot, c.signal);
  const failed = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  c.abort();
  await expect(h.transport.query(snapshot)).rejects.toThrow("capacity");
  vi.stubGlobal("fetch", async () => Response.json([]));
  await h.transport.query(ordinary);
  body.enqueue(new TextEncoder().encode("[]"));
  body.close();
  await failed;
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 3s" },
      { status: 429 },
    ),
  );
  const p = h.transport.query(snapshot);
  const quota = expect(p).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 4000,
  });
  await vi.advanceTimersByTimeAsync(5000);
  await quota;
  const other = await connectSignedTransport(
    h.signer,
    "https://presence-admission.test",
    h.key.pubkey,
  );
  const fetcher = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  await expect(other.query(ordinary)).rejects.toMatchObject({ status: 429 });
  expect(fetcher).not.toHaveBeenCalled();
});

it("runtime priority spoofing cannot give ordinary signed queries optional admission", async () => {
  const h = await setup();
  const starts: number[] = [];
  vi.stubGlobal("fetch", async () => {
    starts.push(performance.now());
    return Response.json([]);
  });
  await h.transport.query(ordinary);
  const spoofed = h.transport.query(
    ordinary,
    undefined,
    "spoof",
    "presence" as "foreground",
  );
  await vi.advanceTimersByTimeAsync(499);
  expect(starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  await spoofed;
  expect(starts).toEqual([0, 500]);
});
