// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  personalPull,
  savePersonalPull,
  watchPersonalPulls,
} from "./personal-pull";

const scope = { scope: "https://example.org", viewer: "c".repeat(64) };
const url = "https://github.com/example/project/pull/7";
const other = "https://github.com/example/project/pull/8";

function storageLocks() {
  let tail = Promise.resolve<unknown>(undefined);
  return {
    request: vi.fn((_key: string, _options: unknown, work: () => unknown) => {
      const next = tail.catch(() => {}).then(work);
      tail = next;
      return next;
    }),
  };
}
beforeEach(() => vi.stubGlobal("navigator", { locks: storageLocks() }));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("scopes persisted links by viewer, community and conversation", async () => {
  await savePersonalPull(scope, "chat", url);
  expect(personalPull(scope, "chat")).toEqual({ url, source: "manual" });
  for (const [target, channel] of [
    [{ ...scope, scope: "https://other.example.org" }, "chat"],
    [{ ...scope, viewer: "b".repeat(64) }, "chat"],
    [scope, "other"],
  ] as const)
    expect(personalPull(target, channel)).toBeUndefined();
});

it("keeps explicit replacement and unlink through duplicate announcements", async () => {
  expect(await savePersonalPull(scope, "chat", url, { automatic: true })).toBe(
    true,
  );
  expect(await savePersonalPull(scope, "chat", url, { automatic: true })).toBe(
    true,
  );
  expect(
    await savePersonalPull(scope, "chat", other, { automatic: true }),
  ).toBe(false);
  await savePersonalPull(scope, "chat", other);
  expect(await savePersonalPull(scope, "chat", url, { automatic: true })).toBe(
    false,
  );
  await savePersonalPull(scope, "chat", null);
  expect(await savePersonalPull(scope, "chat", url, { automatic: true })).toBe(
    false,
  );
  expect(personalPull(scope, "chat")).toEqual({ url: null, source: "manual" });
});

it("serializes simultaneous connections and lets an explicit unlink win", async () => {
  const results = await Promise.all([
    savePersonalPull(scope, "chat", url, { automatic: true }),
    savePersonalPull(scope, "chat", url, { automatic: true }),
    savePersonalPull(scope, "chat", null),
    savePersonalPull(scope, "chat", url, { automatic: true }),
  ]);
  expect(results).toEqual([true, true, true, false]);
  expect(personalPull(scope, "chat")?.url).toBeNull();
});

it("notifies same-window connections and external storage changes, then disposes", async () => {
  const listener = vi.fn();
  const stop = watchPersonalPulls(scope, listener);
  await savePersonalPull(scope, "chat", url);
  expect(listener).toHaveBeenCalledOnce();
  const key = localStorage.key(0) ?? "missing";
  window.dispatchEvent(new StorageEvent("storage", { key }));
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  await savePersonalPull(scope, "chat", null);
  expect(listener).toHaveBeenCalledTimes(2);
});

it("revalidates cancellation and access when a queued storage lock is acquired", async () => {
  let allowed = true;
  const save = savePersonalPull(scope, "chat", url, { allowed: () => allowed });
  allowed = false;
  await expect(save).rejects.toThrow("access changed");
  const controller = new AbortController();
  const canceled = savePersonalPull(scope, "chat", url, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(canceled).rejects.toThrow();
  expect(localStorage.length).toBe(0);
});

it("keeps a damaged preference as a tombstone and reports storage failures", async () => {
  await savePersonalPull(scope, "chat", url);
  localStorage.setItem(localStorage.key(0) ?? "missing", "{");
  expect(
    await savePersonalPull(scope, "chat", other, { automatic: true }),
  ).toBe(false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("full");
  });
  await expect(savePersonalPull(scope, "chat", url)).rejects.toThrow("full");
  vi.stubGlobal("navigator", {});
  await expect(savePersonalPull(scope, "chat", url)).rejects.toThrow(
    "storage locks",
  );
});

it("projects personal changes into existing shared state without reading a Team channel", async () => {
  const { createSoloPulls } = await import("./solo-pull");
  const states = {
    watch: vi.fn(() => () => {}),
    get: () => undefined,
    readAt: () => undefined,
  };
  const read = vi.fn(async () => []);
  const session = {
    ...scope,
    snapshotRead: read,
    channels: {
      list: () => ({ channels: [{ id: "chat", channelType: "stream" }] }),
    },
  };
  const pulls = createSoloPulls(session as never, states as never, true);
  const changed = vi.fn();
  const stop = pulls.watch("chat", changed);
  await savePersonalPull(scope, "chat", url);
  expect(pulls.get("chat")).toEqual({ url, state: undefined });
  expect(states.watch).toHaveBeenCalledWith(
    url,
    expect.any(Function),
    "details",
    expect.objectContaining({ interactive: false }),
  );
  await savePersonalPull(scope, "chat", null);
  expect(pulls.get("chat")).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
});
