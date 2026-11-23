import { expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import { todaysFirstScreenReads } from "./first-screen-reads";

function setup(
  results: readonly (string | ReadError)[],
  roster: { readable: boolean; failure?: ReadError | undefined } = {
    readable: true,
  },
) {
  const head = vi.fn(async () => {
    const result = results[head.mock.calls.length - 1];
    if (result instanceof ReadError) throw result;
    return result;
  });
  const listeners = new Set<() => void>();
  const confirm = vi.fn();
  const reads = todaysFirstScreenReads<string | undefined>({
    canRead: () => roster.readable,
    authorized: () => true,
    onList(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listFailure: () => roster.failure,
    confirm,
    head,
    unnamed: () => [],
    readNames: async () => {},
  });
  const listed = () => {
    for (const listener of [...listeners]) listener();
  };
  return { head, reads, confirm, listed };
}

const cancelled = () => new ReadError("cancelled", "cancelled from outside");

it("an open's head cancelled from outside is read again once", async () => {
  const once = setup([cancelled(), "head"]);
  await expect(
    once.reads.head("alpha", new AbortController().signal),
  ).resolves.toBe("head");
  expect(once.head).toHaveBeenCalledTimes(2);

  const twice = setup([cancelled(), cancelled(), "head"]);
  await expect(
    twice.reads.head("alpha", new AbortController().signal),
  ).rejects.toThrow("cancelled from outside");
  expect(twice.head).toHaveBeenCalledTimes(2);
});

it("an open waiting on the roster fails with its read, and its Retry reads the roster again", async () => {
  const roster: { readable: boolean; failure?: ReadError | undefined } = {
    readable: false,
  };
  const h = setup(["head"], roster);
  const signal = new AbortController().signal;
  const first = h.reads.head("alpha", signal);
  expect(h.confirm).not.toHaveBeenCalled();
  roster.failure = new ReadError("unavailable", "roster read failed");
  h.listed();
  await expect(first).rejects.toThrow("roster read failed");
  expect(h.head).not.toHaveBeenCalled();
  // Retry: a new open asks for the roster again and waits for it.
  h.confirm.mockImplementation(() => {
    roster.failure = undefined;
  });
  const retry = h.reads.head("alpha", signal);
  expect(h.confirm).toHaveBeenCalledTimes(1);
  roster.readable = true;
  h.listed();
  await expect(retry).resolves.toBe("head");
});
