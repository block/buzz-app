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
      if (url.endsWith("/stream-retry") || url.endsWith("/stream-presence")) {
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
    presence(index: number, state: unknown) {
      required(bodyControllers[index]).enqueue(
        new TextEncoder().encode(
          `event: presence-state\ndata: ${JSON.stringify(state)}\n\n`,
        ),
      );
    },
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

it("presence controls coalesce continuous demand with a fixed deadline and stale author state cannot replace current demand", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const states = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({
    ...f.callbacks,
    presenceState: states,
  });
  try {
    f.accept(0);
    await tick();
    for (let i = 1; i <= 10; i++) {
      owner.presence?.update([i.toString(16).padStart(64, "0")]);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(f.controls).toHaveLength(1);
    const latest = "a".padStart(64, "0");
    f.presence(0, { status: "ready", authors: ["1".padStart(64, "0")] });
    await tick();
    expect(states.mock.lastCall?.[0]).toEqual({
      status: "pending",
      authors: [latest],
    });
    required(f.controls[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.controls).toHaveLength(2);
    f.presence(0, { status: "ready", authors: [latest] });
    await tick();
    expect(states.mock.lastCall?.[0]).toEqual({
      status: "ready",
      authors: [latest],
    });
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});

it("stream replacement clears a queued presence timer without poisoning later controls; late failed controls are fenced", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const states = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({
    ...f.callbacks,
    presenceState: states,
  });
  try {
    f.accept(0);
    await tick();
    owner.presence?.update(["a".repeat(64)]);
    owner.update(["a"]); // replacement while the first control is still queued
    f.accept(1);
    await tick();
    owner.presence?.update(["b".repeat(64)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.controls).toHaveLength(1);
    owner.update(["b"]);
    f.accept(2);
    await tick();
    const before = states.mock.calls.length;
    required(f.controls[0]).resolve(new Response(null, { status: 503 }));
    await tick();
    expect(states).toHaveBeenCalledTimes(before);
    owner.presence?.update(["c".repeat(64)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.controls).toHaveLength(2);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});
