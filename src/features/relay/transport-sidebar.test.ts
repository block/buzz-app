import { afterEach, expect, it, vi } from "vitest";
import { connectBrokerTransport } from "./transport";
import { keypair } from "./testing";

const channel = "00000000-0000-0000-0000-000000000001";
const viewer = keypair().pubkey;
const discovery = {
  version: 1,
  base_path: "/buzz/v1",
  max_channels: 20,
  max_intents: 100,
  max_contexts: 20,
  max_context_messages: 100,
  max_thread_summaries: 5,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["sidebar", "contexts", "write"] as const)(
  "%s has one 10s network deadline through body consumption, with immediate lifecycle cancellation",
  async (operation) => {
    vi.useFakeTimers();
    // Control the platform deadline without depending on Node's native timer clock.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const owner = new AbortController();
        setTimeout(
          () => owner.abort(new DOMException("Timed out", "TimeoutError")),
          ms,
        );
        return owner.signal;
      });
    let started = 0;
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: "relay",
          buzz_v1: discovery,
        });
      started++;
      const signal = init?.signal;
      // Headers have arrived, but a valid-looking JSON body never completes.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"account":'));
            signal?.addEventListener(
              "abort",
              () => {
                cancelled();
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        }),
      );
    });
    const transport = await connectBrokerTransport();
    const api = transport.sidebarApi;
    expect(api).toBeDefined();
    const run = (signal: AbortSignal) => {
      if (!api) throw new Error("Missing API");
      if (operation === "sidebar") return api.sidebar({}, signal);
      if (operation === "contexts")
        return api.contexts(
          [{ target: { channel_id: channel }, message_ids: [] }],
          signal,
        );
      return api.write(
        [
          {
            type: "mark_channel_read",
            channel_id: channel,
            message_id: "a".repeat(64),
          },
        ],
        signal,
      );
    };
    let settled = false;
    const request = run(new AbortController().signal).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(started).toBe(1);
    expect(settled).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10000);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toHaveBeenCalledTimes(1);

    const lifecycle = new AbortController();
    const next = run(lifecycle.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
    lifecycle.abort();
    expect(await next).toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledTimes(2);
  },
);
