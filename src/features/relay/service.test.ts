import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay } from "./service";
import type { ReadTransport } from "./transport";
import { flush } from "./testing";

const roots: Context[] = [];
function root() {
  const ctx = new Context();
  roots.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
});
const transport = (viewer: string): ReadTransport => ({
  viewer,
  relayAuthor: "relay",
  media: () => undefined,
  query: vi.fn(async () => []),
});
it("shares a session above plugin lifetimes, rather than one store per consumer", async () => {
  const ctx = root();
  const source = transport("viewer");
  const connect = vi.fn(async () => source);
  const data = provideRelay(ctx, connect);
  await flush();
  const received: unknown[] = [];
  const consumer = ctx.plugin({
    inject: ["relay"],
    apply(scope) {
      received.push(scope.relay.snapshot().session);
    },
  });
  await consumer.await();
  const other = ctx.plugin({
    inject: ["relay"],
    apply(scope) {
      received.push(scope.relay.snapshot().session);
    },
  });
  await other.await();
  expect(received[0]).toBe(received[1]);
  await consumer.dispose();
  expect(data.snapshot().status).toBe("ready");
  expect(connect).toHaveBeenCalledTimes(1);
  expect(source.query).toHaveBeenCalledTimes(1);
});
it("rejects an old connection result after disconnect and replacement", async () => {
  const ctx = root();
  const pending: ((transport: ReadTransport) => void)[] = [];
  const data = provideRelay(
    ctx,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await flush();
  const old = pending.shift();
  data.disconnect();
  data.retry();
  await flush();
  pending.shift()?.(transport("new"));
  await flush();
  const current = data.snapshot();
  old?.(transport("old"));
  await flush();
  expect(data.snapshot()).toBe(current);
  expect(current.viewer).toBe("new");
});
it("times out a stalled connection and releases timers on app disposal", async () => {
  vi.useFakeTimers();
  const ctx = root();
  const data = provideRelay(ctx, () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot().status).toBe("error");
  data.retry();
  expect(vi.getTimerCount()).toBe(1);
  await ctx.fiber.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
