import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  browserCheckpointStorage,
  MAX_CHECKPOINT_BYTES,
} from "./checkpoint-storage";

const stores: ReturnType<typeof browserCheckpointStorage>[] = [];
const storage = (scope: string) => {
  const owner = browserCheckpointStorage(scope);
  stores.push(owner);
  return owner;
};
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  for (const owner of stores.splice(0)) owner.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("isolates scopes across reopen and clears only the requested scope", async () => {
  const a = storage("viewer:a");
  await a.write({ version: 1 });
  await storage("other:a").write({ version: 2 });
  a.close();
  const next = storage("viewer:a");
  expect(await next.read()).toEqual({ version: 1 });
  await next.clear();
  expect(await next.read()).toBeUndefined();
  expect(await storage("other:a").read()).toEqual({ version: 2 });
});

it("bounds the origin to eight scopes and eight MiB, retaining the latest write", async () => {
  const owners = Array.from({ length: 10 }, (_, i) => storage(String(i)));
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => ++now);
  for (const owner of owners) await owner.write({ small: true });
  expect(await owners[0]?.read()).toBeUndefined();
  expect(await owners[1]?.read()).toBeUndefined();
  expect(await owners[9]?.read()).toEqual({ small: true });
  const large = "x".repeat(3 * 1024 * 1024);
  await owners[7]?.write(large);
  await owners[8]?.write(large);
  await owners[9]?.write(large);
  expect(await owners[7]?.read()).toBeUndefined();
  expect(await owners[8]?.read()).toBe(large);
  expect(await owners[9]?.read()).toBe(large);
});

it("removes an obsolete checkpoint instead of retaining it when replacement overflows", async () => {
  const owner = storage("scope");
  await owner.write("old");
  await owner.write("x".repeat(MAX_CHECKPOINT_BYTES));
  expect(await owner.read()).toBeUndefined();
});

it("falls back on unavailable, blocked and timed-out database opens", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(storage("absent").read()).rejects.toThrow("unavailable");
  const request: Partial<IDBOpenDBRequest> = {};
  vi.stubGlobal("indexedDB", { open: () => request });
  const blocked = storage("blocked").read();
  request.onblocked?.call(
    request as IDBOpenDBRequest,
    new Event("blocked") as IDBVersionChangeEvent,
  );
  await expect(blocked).rejects.toThrow("unavailable");
  vi.useFakeTimers();
  const expired = expect(storage("expired").read()).rejects.toThrow(
    "timed out",
  );
  await vi.advanceTimersByTimeAsync(1500);
  await expired;
});
