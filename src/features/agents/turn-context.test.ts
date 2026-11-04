import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTurnContext,
  type TurnLease,
  type TurnContextContribution,
} from "./turn-context";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const roots: Context[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

function fixture() {
  const root = new Context();
  roots.push(root);
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const collector = createTurnContext<TurnLease>(root);
  const controller = new AbortController();
  let current = true;
  return {
    controller,
    expire: () => {
      current = false;
    },
    collect: () =>
      collector.collect({
        turn: (lease) => lease,
        signal: controller.signal,
        current: () => current,
      }),
    async add(id: string, run: TurnContextContribution<TurnLease>["run"]) {
      const fiber = root
        .extend({ pluginOwner: { id, revision: "1", turnContext: true } })
        .plugin((ctx) => {
          collector.register(ctx, { id: "context", run });
        });
      await fiber.await();
      return fiber;
    },
  };
}

it("returns no context without contributors or for empty and failed results", async () => {
  const f = fixture();
  expect(await f.collect()).toBe("");
  await f.add("empty", async () => "  ");
  await f.add("failed", async () => {
    throw new Error("failed");
  });
  expect(await f.collect()).toBe("");
});

it("starts contributors together and orders escaped sections by key", async () => {
  const f = fixture();
  const held = deferred<string>();
  const second = vi.fn(async () => "second");
  await f.add('b"<&', second);
  await f.add("a", () => held.promise);
  const result = f.collect();
  await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
  held.resolve("first");
  expect(await result).toBe(
    '<turn-context key="a/context">\nfirst\n</turn-context>\n\n<turn-context key="b&quot;&lt;&amp;/context">\nsecond\n</turn-context>',
  );
});

it("counts UTF-8 and wrappers and admits whole sections under the aggregate cap", async () => {
  const f = fixture();
  await f.add("a", async () => "é".repeat(4000));
  await f.add("b", async () => "b".repeat(8000));
  await f.add("c", async () => "c".repeat(500));
  await f.add("d", async () => "fits");
  await f.add("oversized", async () => "é".repeat(4096));
  const result = await f.collect();
  expect(result).toContain('key="a/context"');
  expect(result).toContain('key="b/context"');
  expect(result).not.toContain('key="c/context"');
  expect(result).toContain('key="d/context"');
  expect(result).not.toContain('key="oversized/context"');
  expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(
    16384,
  );
});

it("revokes the lease on settlement while keeping the successful contribution", async () => {
  const f = fixture();
  let lease!: TurnLease;
  await f.add("a", async (value) => {
    lease = value;
    expect(lease.live()).toBe(true);
    return "ok";
  });
  expect(await f.collect()).toContain("ok");
  expect(lease.live()).toBe(false);
  expect(lease.signal.aborted).toBe(true);
});

it("times out pending work without losing completed contributors or admitting late text", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const held = deferred<string>();
  let lease!: TurnLease;
  await f.add("a", async () => "ok");
  await f.add("b", (value) => {
    lease = value;
    return held.promise;
  });
  const result = f.collect();
  await vi.advanceTimersByTimeAsync(2999);
  expect(lease.live()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  const text = await result;
  expect(text).toContain("ok");
  expect(text).not.toContain('key="b/context"');
  expect(lease.signal.aborted).toBe(true);
  held.resolve("late");
  await held.promise;
  expect(await result).toBe(text);
});

it("unload revokes pending work and removes already-completed output", async () => {
  const f = fixture();
  const held = deferred<string>();
  const started = deferred<void>();
  let lease!: TurnLease;
  const complete = await f.add("a", async () => "removed");
  const pending = await f.add("b", (value) => {
    lease = value;
    started.resolve();
    return held.promise;
  });
  const result = f.collect();
  await started.promise;
  await complete.dispose();
  await pending.dispose();
  expect(await result).toBe("");
  expect(lease.signal.aborted).toBe(true);
  held.resolve("late");
});

it("stop immediately settles an uncooperative callback and currency is rechecked", async () => {
  const f = fixture();
  const started = deferred<void>();
  await f.add("a", async () => {
    started.resolve();
    return new Promise(() => {});
  });
  const result = f.collect();
  await started.promise;
  f.controller.abort();
  expect(await result).toBe("");
  const g = fixture();
  await g.add("a", async () => {
    g.expire();
    return "stale";
  });
  expect(await g.collect()).toBe("");
});

it("requires the installed manifest grant", () => {
  const root = new Context();
  roots.push(root);
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const collector = createTurnContext(root);
  expect(() =>
    collector.register(root, { id: "x", run: async () => "x" }),
  ).toThrow("Declare host.turnContext");
});
