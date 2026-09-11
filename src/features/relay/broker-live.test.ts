// Regression controls contributed by Brain; see WS_RETRY_REVIEW_2026_09_09.
import { assert, afterEach, expect, it, vi } from "vitest";
import { connectBrokerTransport } from "./transport";
function required<T>(value: T | undefined): T {
  assert.exists(value);
  return value;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const headers: ReturnType<typeof deferred<Response>>[] = [];
  const controls: ReturnType<typeof deferred<Response>>[] = [];
  const signals: AbortSignal[] = [];
  const snapshots: unknown[] = [];
  const bodyControllers: ReadableStreamDefaultController[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith("/session"))
        return Promise.resolve(
          Response.json({
            viewer: "a".repeat(64),
            relayAuthor: "b".repeat(64),
            live: true,
          }),
        );
      if (url.endsWith("/stream-retry") || url.endsWith("/stream-observer")) {
        const d = deferred<Response>();
        controls.push(d);
        signals.push(init.signal as AbortSignal);
        return d.promise;
      }
      if (url.endsWith("/stream")) {
        const d = deferred<Response>();
        headers.push(d);
        return d.promise;
      }
      throw Error(`unexpected fetch ${url}`);
    }),
  );
  function accept(index: number) {
    const body = new ReadableStream({
      start(c) {
        bodyControllers[index] = c;
      },
    });
    required(headers[index]).resolve(
      new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Buzz-Live-ID": String(index + 1).padStart(32, "0"),
        },
      }),
    );
  }
  function publish(index: number) {
    required(bodyControllers[index]).enqueue(
      new TextEncoder().encode(
        'event: state\ndata: {"status":"connected","routes":[]}\n\n',
      ),
    );
  }
  return {
    headers,
    controls,
    signals,
    snapshots,
    accept,
    publish,
    callbacks: {
      state(s: unknown) {
        snapshots.push(s);
      },
      receive() {},
      established() {},
      denied() {},
    },
  };
}
it("pre-header clicks preserve in-progress POST; duplicate controls coalesce", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.retry();
    owner.retry();
    await tick();
    expect(f.headers).toHaveLength(1);
    expect(f.controls).toHaveLength(0);
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    owner.retry();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(1);
    expect(f.headers).toHaveLength(1);
    required(f.controls[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(f.headers).toHaveLength(1);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});
for (const finish of ["replacement", "dispose"] as const)
  for (const outcome of ["status", "reject"] as const)
    it(`late retry ${outcome} cannot update ${finish}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      const t = await connectBrokerTransport();
      const owner = required(t.subscribe)(f.callbacks);
      try {
        f.accept(0);
        await tick();
        f.publish(0);
        await tick();
        owner.retry();
        await tick();
        expect(f.controls).toHaveLength(1);
        if (finish === "replacement") {
          owner.update(["a"]);
          f.accept(1);
          await tick();
          f.publish(1);
          await tick();
        } else owner.dispose();
        expect(required(f.signals[0]).aborted).toBe(true);
        const before = f.snapshots.length;
        // Deliberately uncooperative completion despite abort, proving callback fence.
        if (outcome === "status")
          required(f.controls[0]).resolve(new Response(null, { status: 500 }));
        else
          required(f.controls[0]).reject(
            new Error("deliberately late network rejection"),
          );
        await tick();
        expect(f.snapshots).toHaveLength(before);
        expect(f.headers).toHaveLength(finish === "replacement" ? 2 : 1);
      } finally {
        owner.dispose();
      }
    });

it("late observer 404 from a retired stream cannot interrupt its replacement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    required(owner.observe)(1);
    await tick();
    expect(f.controls).toHaveLength(1);
    owner.update(["a"]);
    f.accept(1);
    await tick();
    f.publish(1);
    await tick();
    expect(required(f.signals[0]).aborted).toBe(true);
    const before = f.snapshots.length;
    required(f.controls[0]).resolve(new Response(null, { status: 404 }));
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.snapshots).toHaveLength(before);
    expect(f.headers).toHaveLength(2);
    required(owner.observe)(2);
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(required(f.signals[1]).aborted).toBe(false);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});
