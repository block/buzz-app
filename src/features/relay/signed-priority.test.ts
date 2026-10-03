// Reader-to-host priority propagation control contributed by Brain.

import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { createRelayReader } from "./reader";
import { hostSigner } from "./testing";
afterEach(() => {
  vi.useRealTimers();
});
it("production reader prioritizes queued work at real capacity, not a clock interval", async () => {
  vi.useFakeTimers();
  const calls: number[] = [];
  const release: Array<() => void> = [];
  const signer = hostSigner(undefined, async (_url, body) => {
    calls.push(JSON.parse(body)[0].limit);
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

it("signed transport forwards query priority to host request admission", async () => {
  const calls: number[] = [];
  const release: Array<() => void> = [];
  const t = await connectSignedTransport(
    hostSigner(undefined, async (_url, body) => {
      calls.push(JSON.parse(body)[0].limit);
      await new Promise<void>((resolve) => release.push(resolve));
      return Response.json([]);
    }),
    "https://priority-forwarding.test",
    "relay",
  );
  const active = [1, 2, 3, 4, 5, 6].map((limit) =>
    t.query([{ kinds: [0], limit }]),
  );
  await vi.waitFor(() => expect(calls).toHaveLength(6));
  const background = t.query(
    [{ kinds: [0], limit: 7 }],
    undefined,
    "read",
    "background",
  );
  const foreground = t.query(
    [{ kinds: [0], limit: 8 }],
    undefined,
    "read",
    "foreground",
  );
  release.shift()?.();
  await vi.waitFor(() => expect(calls).toHaveLength(7));
  expect(calls.at(-1)).toBe(8);
  release.shift()?.();
  await vi.waitFor(() => expect(calls).toHaveLength(8));
  expect(calls.at(-1)).toBe(7);
  for (const finish of release) finish();
  await Promise.all([...active, background, foreground]);
});
