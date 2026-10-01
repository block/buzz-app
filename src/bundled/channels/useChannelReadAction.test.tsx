// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChannelReadAction } from "./useChannelReadAction";
afterEach(cleanup);
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function mount() {
  return renderHook(useChannelReadAction, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    ),
  });
}
it("keeps read errors in the menu and completes only after a successful retry", async () => {
  const view = mount();
  const first = deferred();
  const completed = vi.fn();
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.run(() => first.promise, completed);
  });
  expect(view.result.current.state).toEqual({ pending: true });
  await act(async () => {
    first.reject(new Error("Read transaction failed"));
    await pending;
  });
  expect(view.result.current.state).toEqual({
    pending: false,
    error: "Read transaction failed",
  });
  expect(completed).not.toHaveBeenCalled();
  await act(() => view.result.current.run(async () => {}, completed));
  expect(completed).toHaveBeenCalledOnce();
});
it.each(["resolve", "reject"] as const)(
  "ignores a retired %s without closing or replacing a reopened menu",
  async (finish) => {
    const view = mount();
    const first = deferred();
    const second = deferred();
    const completed = vi.fn();
    let old!: Promise<void>;
    let current!: Promise<void>;
    act(() => {
      old = view.result.current.run(() => first.promise, completed);
    });
    act(() => view.result.current.reset());
    act(() => {
      current = view.result.current.run(() => second.promise, completed);
    });
    await act(async () => {
      first[finish](new Error("retired"));
      await old;
    });
    expect(view.result.current.state).toEqual({ pending: true });
    expect(completed).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve();
      await current;
    });
    expect(completed).toHaveBeenCalledOnce();
  },
);
it("does not restore focus or close a replacement page after unmount", async () => {
  const view = mount();
  const gate = deferred();
  const completed = vi.fn();
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.run(() => gate.promise, completed);
  });
  view.unmount();
  await act(async () => {
    gate.resolve();
    await pending;
  });
  expect(completed).not.toHaveBeenCalled();
});
