// Reader-to-host priority propagation control contributed by Brain.

import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { createRelayReader } from "./reader";
import { keypair, signed } from "./testing";
afterEach(() => vi.unstubAllGlobals());
it("production reader priority reaches actual signed fetch admission", async () => {
  const key = keypair();
  const calls: number[] = [];
  const signer = {
    getPublicKey: async () => key.pubkey,
    signEvent: async (t: Parameters<typeof signed>[1]) => signed(key, t),
  };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string)[0].limit);
    return Response.json([]);
  });
  const t = await connectSignedTransport(
    signer,
    "https://priority-review.test",
    "relay",
  );
  const r = createRelayReader(t);
  try {
    await r.reader.read([{ kinds: [0], limit: 1 }]);
    const b = r.reader.read([{ kinds: [0], limit: 2 }], {
      priority: "background",
    });
    await new Promise((r) => setTimeout(r, 50));
    const f = r.reader.read([{ kinds: [0], limit: 3 }], {
      priority: "foreground",
    });
    await Promise.all([b, f]);
    expect(calls).toEqual([1, 3, 2]);
  } finally {
    r.dispose();
  }
});
