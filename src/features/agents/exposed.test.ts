import { expect, it, vi } from "vitest";
import {
  abortable,
  linkedStore,
  linkedView,
  storeTopic,
  viewTopic,
} from "./exposed";
import { delivered, runtimeLink } from "./plugin-testing";

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

it("shows a runtime store to its UI: the initial value until the runtime's arrives, then each change", async () => {
  const setup = store({
    status: "ready",
    detail: undefined as string | undefined,
  });
  const link = runtimeLink({ topics: { setup: storeTopic(setup) } });
  const initial = Object.freeze({ status: "checking" });
  const shown = linkedStore(link, "setup", initial);
  const changed = vi.fn();
  shown.subscribe(changed);
  expect(shown.snapshot()).toBe(initial);
  await delivered();
  // What crosses is a copy, without its undefined fields.
  expect(shown.snapshot()).toEqual({ status: "ready" });
  const first = shown.snapshot();
  expect(shown.snapshot()).toBe(first);
  setup.set({ status: "signed-out", detail: "Sign in" });
  await delivered();
  expect(shown.snapshot()).toEqual({ status: "signed-out", detail: "Sign in" });
  expect(changed).toHaveBeenCalledTimes(2);
});

it("reads a runtime view by key, watching each key from its first read", async () => {
  const runtime = store<Record<string, string[]>>({ ada: ["one"] });
  const read = vi.fn((key: string) => runtime.snapshot()[key]);
  const link = runtimeLink({
    topics: { sessions: viewTopic(runtime.subscribe, read) },
  });
  const sessions = linkedView<string, readonly string[]>(link, "sessions", []);
  await delivered();
  expect(read).not.toHaveBeenCalled();
  expect(sessions.read("ada")).toEqual([]);
  await delivered();
  expect(sessions.read("ada")).toEqual(["one"]);
  // A key with nothing reads as the initial value.
  expect(sessions.read("bob")).toEqual([]);
  runtime.set({ ada: ["one", "two"], bob: ["three"] });
  await delivered();
  expect(sessions.read("ada")).toEqual(["one", "two"]);
  expect(sessions.read("bob")).toEqual(["three"]);
});

it("stops waiting for a call when its signal aborts, without an unhandled rejection", async () => {
  let answer!: (value: string) => void;
  const pending = new Promise<string>((resolve) => (answer = resolve));
  const abort = new AbortController();
  const waiting = abortable(pending, abort.signal);
  abort.abort(new Error("Closed"));
  await expect(waiting).rejects.toThrow("Closed");
  answer("late");
  const settled = abortable(Promise.resolve("now"), undefined);
  await expect(settled).resolves.toBe("now");
  const early = new AbortController();
  early.abort(new Error("Before"));
  await expect(
    abortable(Promise.reject(new Error("Ignored")), early.signal),
  ).rejects.toThrow("Before");
});
