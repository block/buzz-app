// Reader-to-host priority propagation control contributed by Brain.

import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { createRelayReader } from "./reader";
import { keypair, signed } from "./testing";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("production reader prioritizes queued work at real capacity, not a clock interval", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const calls: number[] = [];
  const release: Array<() => void> = [];
  const signer = {
    getPublicKey: async () => key.pubkey,
    signEvent: async (t: Parameters<typeof signed>[1]) => signed(key, t),
  };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string)[0].limit);
    await new Promise<void>((resolve) => release.push(resolve));
    return Response.json([]);
  });
  const t = await connectSignedTransport(
    signer,
    "https://priority-review.test",
    "relay",
  );
  const r = createRelayReader(t);
  try {
    const active = [1, 2, 3].map((limit) =>
      r.reader.read([{ kinds: [0], limit }]),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const b = r.reader.read([{ kinds: [0], limit: 4 }], {
      priority: "background",
    });
    const f = r.reader.read([{ kinds: [0], limit: 5 }], {
      priority: "foreground",
    });
    release.shift()?.();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.at(-1)).toBe(5);
    release.shift()?.();
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(calls.at(-1)).toBe(4);
    for (const finish of release) finish();
    await Promise.all([...active, b, f]);
  } finally {
    r.dispose();
  }
});
