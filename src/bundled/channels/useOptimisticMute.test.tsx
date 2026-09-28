// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useOptimisticMute } from "./useOptimisticMute";

afterEach(cleanup);
function deferred() {
  let resolve!: (value: readonly string[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<readonly string[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

it("projects immediately, writes once in StrictMode and drops the overlay after confirmation", async () => {
  const save = deferred();
  const write = vi.fn(() => save.promise);
  const { result } = renderHook(() => useOptimisticMute(write), { wrapper });
  act(() => result.current.change("room", "Room", true));
  expect(result.current.intents.get("room")).toMatchObject({
    muted: true,
    pending: true,
  });
  expect(write).toHaveBeenCalledExactlyOnceWith("room", true);
  await act(async () => {
    save.resolve(["room"]);
  });
  expect(result.current.intents.size).toBe(0);
});

it("rolls back a failed unmute and retries the explicit intent rather than toggling confirmed state", async () => {
  const failed = deferred();
  const retry = deferred();
  const write = vi
    .fn()
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(retry.promise);
  const { result } = renderHook(() => useOptimisticMute(write), { wrapper });
  act(() => result.current.change("room", "Room", false));
  await act(async () => {
    failed.reject(new Error("offline"));
  });
  expect(result.current.intents.get("room")).toMatchObject({
    muted: false,
    pending: false,
    error: "offline",
  });
  act(() => result.current.change("room", "Room", false));
  expect(result.current.intents.get("room")).toMatchObject({
    muted: false,
    pending: true,
  });
  expect(write).toHaveBeenLastCalledWith("room", false);
  await act(async () => {
    retry.resolve([]);
  });
  expect(result.current.intents.size).toBe(0);
});

it.each(["success", "failure"])(
  "ignores an older %s during a rapid reversal and retains other channels",
  async (outcome) => {
    const first = deferred();
    const latest = deferred();
    const other = deferred();
    const write = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise)
      .mockReturnValueOnce(other.promise);
    const { result } = renderHook(() => useOptimisticMute(write), { wrapper });
    act(() => {
      result.current.change("room", "Room", true);
      result.current.change("room", "Room", false);
      result.current.change("other", "Other", true);
    });
    await act(async () => {
      if (outcome === "success") first.resolve(["room"]);
      else first.reject(new Error("older failure"));
    });
    expect(result.current.intents.get("room")).toMatchObject({
      muted: false,
      pending: true,
    });
    await act(async () => {
      latest.reject(new Error("latest failure"));
    });
    act(() => result.current.dismiss("room"));
    expect(result.current.intents.has("room")).toBe(false);
    expect(result.current.intents.get("other")?.pending).toBe(true);
    await act(async () => {
      other.resolve(["other"]);
    });
    expect(result.current.intents.size).toBe(0);
  },
);

it("leaves saving with the session and ignores a retired view’s late result", async () => {
  const oldSave = deferred();
  const newSave = deferred();
  const oldWrite = vi.fn(() => oldSave.promise);
  const newWrite = vi.fn(() => newSave.promise);
  const { result, rerender, unmount } = renderHook(
    ({ write }) => useOptimisticMute(write),
    { initialProps: { write: oldWrite }, wrapper },
  );
  act(() => result.current.change("room", "Room", true));
  rerender({ write: newWrite });
  expect(result.current.intents.size).toBe(0);
  act(() => result.current.change("room", "Room", false));
  await act(async () => {
    oldSave.reject(new Error("retired"));
  });
  expect(result.current.intents.get("room")).toMatchObject({
    muted: false,
    pending: true,
  });
  unmount();
  await act(async () => {
    newSave.resolve([]);
  });
});

it("retains a synchronous host failure for retry", () => {
  const write = vi.fn(() => {
    throw new Error("unavailable");
  });
  const { result } = renderHook(() => useOptimisticMute(write), { wrapper });
  act(() => result.current.change("room", "Room", true));
  expect(result.current.intents.get("room")).toMatchObject({
    pending: false,
    error: "unavailable",
  });
});
