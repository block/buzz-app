import { expect, it, vi } from "vitest";
import { createMemberAdditions } from "./operations";

it("coalesces reopened views and retries only startup after confirmed membership", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const add = vi.fn(() => gate);
  const start = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Added, but startup failed"))
    .mockResolvedValue(undefined);
  const owner = createMemberAdditions(new AbortController().signal, add, start);
  const first = owner.add("channel", "person");
  const retry = owner.add("channel", "person");
  expect(retry).toBe(first);
  const failed = expect(first).rejects.toThrow("startup failed");
  release();
  await failed;
  expect(owner.snapshot()[0]).toMatchObject({
    confirmed: true,
    pending: false,
  });
  await owner.add("channel", "person");
  expect(add).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenNthCalledWith(
    1,
    "channel",
    "person",
    undefined,
    false,
  );
  expect(start).toHaveBeenNthCalledWith(
    2,
    "channel",
    "person",
    undefined,
    true,
  );
  expect(owner.snapshot()).toEqual([]);
});

it("session disposal cancels the continuation and clears recovery state", async () => {
  const lifetime = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = vi.fn();
  const owner = createMemberAdditions(lifetime.signal, () => gate, start);
  const operation = owner.add("channel", "person");
  await Promise.resolve();
  lifetime.abort();
  const cancelled = expect(operation).rejects.toThrow();
  release();
  await cancelled;
  expect(start).not.toHaveBeenCalled();
  expect(owner.snapshot()).toEqual([]);
  await expect(owner.add("channel", "person")).rejects.toThrow(
    "connection closed",
  );
});

it("allows consented membership without starting an agent before its outgoing mention", async () => {
  const add = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const owner = createMemberAdditions(new AbortController().signal, add, start);
  await owner.add("channel", "person", undefined, { startAgent: false });
  expect(add).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});

it("preserves a concurrent explicit Start while sharing the mention addition", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const add = vi.fn(() => gate);
  const start = vi.fn(async () => {});
  const owner = createMemberAdditions(new AbortController().signal, add, start);
  const mention = owner.add("channel", "person", undefined, {
    startAgent: false,
  });
  const explicit = owner.add("channel", "person");
  release();
  await Promise.all([mention, explicit]);
  expect(add).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});
