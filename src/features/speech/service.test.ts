import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import { type Connect, listenHosted, listenOnDevice } from "./listen";
import {
  ON_DEVICE_SPEECH,
  SPEECH_PROVIDER_KEY,
  SpeechService,
  type OnDevice,
  type SpeechProvider,
  type SpeechProviderStatus,
} from "./service";

vi.mock("./listen", async (original) => ({
  ...(await original<typeof import("./listen")>()),
  listenHosted: vi.fn(() => ({ stop() {}, cancel() {} })),
  listenOnDevice: vi.fn(() => ({ stop() {}, cancel() {} })),
}));

beforeEach(() => {
  vi.mocked(listenHosted).mockClear();
  vi.mocked(listenOnDevice).mockClear();
});
afterEach(() => vi.useRealTimers());

const BUILDERLAB = "block.builderlab/builderlab";
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
const device = (available: boolean): OnDevice => ({
  available: async () => available,
  prepare: vi.fn(),
});
async function setup(storage: Storage = memory(), onDevice = device(true)) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new SpeechService(root, storage, onDevice);
  const plugin = async (id: string, provider: Partial<SpeechProvider>) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.speech.registerProvider(fake(provider)));
    await fiber.await();
    await flush();
    return fiber;
  };
  await flush();
  return { root, service, plugin };
}
function fake(provider: Partial<SpeechProvider>): SpeechProvider {
  return {
    id: "main",
    label: "Fake",
    description: "A test provider.",
    status: () => "ready",
    subscribe: () => () => {},
    connect: async () => ({ outcome: "answered", sdp: "answer" }),
    ...provider,
  };
}
/** The connect that the service hands the hosted listen. */
function lastConnect(): Connect {
  const call = vi.mocked(listenHosted).mock.calls.at(-1);
  if (!call) throw new Error("no hosted listen");
  return call[1];
}

it("listens on this Mac until a default provider can, and reports none otherwise", async () => {
  const { service, plugin } = await setup();
  expect(service.backend()).toBe(ON_DEVICE_SPEECH);
  service.listen({ onText() {}, onEnd() {} });
  expect(listenOnDevice).toHaveBeenCalledOnce();

  await plugin("block.builderlab", { id: "builderlab", label: "Builderlab" });
  expect(service.backend()).toBe(BUILDERLAB);
  expect(service.providers().map((each) => each.key)).toEqual([
    BUILDERLAB,
    ON_DEVICE_SPEECH,
  ]);

  const none = await setup(memory(), device(false));
  expect(none.service.backend()).toBeUndefined();
  expect(none.service.status()).toBe("unavailable");
  const onError = vi.fn();
  const onState = vi.fn();
  none.service.listen({ onText() {}, onEnd() {}, onError, onState });
  await flush();
  expect(onError).toHaveBeenCalledWith("unavailable", expect.any(String));
  expect(onState).toHaveBeenCalledWith("idle");
});

it("skips a default that needs setup, and waits for one that is checking", async () => {
  let status: SpeechProviderStatus = "checking";
  const listeners = new Set<() => void>();
  const { service, plugin } = await setup();
  await plugin("block.builderlab", {
    id: "builderlab",
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
  // On-device can listen, so a checking Builderlab doesn't hold it.
  expect(service.backend()).toBe(ON_DEVICE_SPEECH);
  status = "needs-setup";
  const changed = vi.fn();
  service.subscribe(changed);
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalled();
  expect(service.backend()).toBe(ON_DEVICE_SPEECH);
  status = "ready";
  expect(service.backend()).toBe(BUILDERLAB);
});

it("keeps the user's choice, and never sends speech elsewhere while it is missing", async () => {
  const storage = memory();
  const first = await setup(storage);
  const fiber = await first.plugin("example.speech", { label: "Example" });
  first.service.setBackend("example.speech/main");
  expect(storage.getItem(SPEECH_PROVIDER_KEY)).toBe("example.speech/main");
  first.service.setBackend("nobody/else");
  expect(first.service.backend()).toBe("example.speech/main");

  fiber.dispose();
  await flush();
  expect(first.service.backend()).toBeUndefined();
  expect(first.service.status()).toBe("unavailable");

  // After a reload, the saved choice holds once its plugin registers again.
  const second = await setup(storage);
  expect(second.service.backend()).toBeUndefined();
  await second.plugin("example.speech", {});
  expect(second.service.backend()).toBe("example.speech/main");
});

it("falls back to the defaults after a plugin retires its saved provider", async () => {
  const storage = memory({ [SPEECH_PROVIDER_KEY]: "example.speech/old" });
  const { root, service } = await setup(storage);
  expect(service.backend()).toBeUndefined();
  const scoped = root.extend({ pluginOwner: { id: "other", revision: "1" } });
  scoped.speech.retireProvider("old");
  expect(service.backend()).toBeUndefined();
  const owner = root.extend({
    pluginOwner: { id: "example.speech", revision: "1" },
  });
  expect(() => owner.speech.retireProvider("a/b")).toThrow();
  owner.speech.retireProvider("old");
  expect(storage.getItem(SPEECH_PROVIDER_KEY)).toBeNull();
  expect(service.backend()).toBe(ON_DEVICE_SPEECH);
  expect(() => root.speech.retireProvider("old")).toThrow();
});

it("warms on-device speech only when it listens", async () => {
  const onDevice = device(true);
  const { service, plugin } = await setup(memory(), onDevice);
  service.prepare();
  expect(onDevice.prepare).toHaveBeenCalledOnce();
  await plugin("block.builderlab", { id: "builderlab" });
  service.prepare();
  expect(onDevice.prepare).toHaveBeenCalledOnce();
});

it("passes the offer and community to the provider and checks its reply", async () => {
  const connect = vi.fn<SpeechProvider["connect"]>(async () => ({
    outcome: "answered",
    sdp: "v=0 answer",
  }));
  const { service, plugin } = await setup();
  await plugin("block.builderlab", { id: "builderlab", connect });
  service.listen({
    community: "wss://relay.example.org",
    onText() {},
    onEnd() {},
  });
  const signal = new AbortController().signal;
  await expect(lastConnect()("offer", signal)).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
  });
  expect(connect).toHaveBeenCalledWith(
    { offer: "offer", community: "wss://relay.example.org", timeoutMs: 20_000 },
    { signal: expect.any(AbortSignal) },
  );

  const replies: unknown[] = [
    { outcome: "failed", reason: "rate_limited" },
    { outcome: "failed", reason: "made_up" },
    { outcome: "answered", sdp: "" },
    "nonsense",
  ];
  for (const reply of replies) {
    connect.mockResolvedValueOnce(reply as never);
    service.listen({ onText() {}, onEnd() {} });
    replies[replies.indexOf(reply)] = await lastConnect()("offer", signal);
  }
  connect.mockRejectedValueOnce(new Error("boom"));
  service.listen({ onText() {}, onEnd() {} });
  replies.push(await lastConnect()("offer", signal));
  expect(replies.map((reply) => (reply as { reason: string }).reason)).toEqual([
    "rate_limited",
    "invalid_response",
    "invalid_response",
    "invalid_response",
    "service_error",
  ]);
});

it("stops waiting at the deadline and when the listen ends", async () => {
  let seen: AbortSignal | undefined;
  const connect = vi.fn<SpeechProvider["connect"]>((_, { signal }) => {
    seen = signal;
    return new Promise(() => {});
  });
  const { service, plugin } = await setup();
  await plugin("block.builderlab", { id: "builderlab", connect });
  vi.useFakeTimers();
  service.listen({ onText() {}, onEnd() {} });
  const reply = lastConnect()("offer", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(20_000);
  await expect(reply).resolves.toEqual({
    outcome: "failed",
    reason: "timeout",
  });
  expect(seen?.aborted).toBe(true);

  const ended = new AbortController();
  service.listen({ onText() {}, onEnd() {} });
  const cancelled = lastConnect()("offer", ended.signal);
  ended.abort();
  await expect(cancelled).resolves.toEqual({
    outcome: "failed",
    reason: "timeout",
  });
  expect(seen?.aborted).toBe(true);
});
