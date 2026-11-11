import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retryInviteClaim } from "./claim-retry";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([200, 400, 401, 403, 429, 500, 502, 504])(
  "returns HTTP %s immediately without another attempt",
  async (status) => {
    const response = new Response(null, { status });
    const request = vi.fn().mockResolvedValue(response);
    expect(await retryInviteClaim(request, new AbortController().signal)).toBe(
      response,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  [0, 500],
  [0.5, 1000],
  [0.999, 1499],
])("waits for the jitter boundary with random=%s", async (random, delay) => {
  vi.mocked(Math.random).mockReturnValue(random);
  const response = Response.json({ status: "joined" });
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(response);
  const pending = retryInviteClaim(request, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(request).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe(response);
  expect(request).toHaveBeenCalledTimes(2);
});

it("returns the second 503 without another timer or attempt", async () => {
  const response = new Response(null, { status: 503 });
  const request = vi.fn().mockImplementation(async () => response.clone());
  const pending = retryInviteClaim(request, new AbortController().signal);
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(503);
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not replay an ambiguous transport failure", async () => {
  const error = new TypeError("Connection lost");
  const request = vi.fn().mockRejectedValue(error);
  await expect(
    retryInviteClaim(request, new AbortController().signal),
  ).rejects.toBe(error);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancelled", "deadline exceeded"])(
  "stops before another request when the caller is %s",
  async (reason) => {
    const controller = new AbortController();
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const pending = retryInviteClaim(request, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(999);
    controller.abort(reason);
    await rejected;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("sends nothing when the caller already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn();
  await expect(retryInviteClaim(request, controller.signal)).rejects.toBe(
    controller.signal.reason,
  );
  expect(request).not.toHaveBeenCalled();
});

it("keeps the original deadline when the first 503 arrives late", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort("deadline"), 25_000);
  const request = vi.fn(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response(null, { status: 503 })), 24_500),
      ),
  );
  const pending = retryInviteClaim(request, controller.signal);
  const rejected = expect(pending).rejects.toBe("deadline");
  await vi.advanceTimersByTimeAsync(25_000);
  await rejected;
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
