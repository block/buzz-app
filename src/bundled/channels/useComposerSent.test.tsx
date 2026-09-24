// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerSent } from "./useComposerSent";

afterEach(cleanup);

it("keeps onSend stable across parent renders and selects only for a requested session message", () => {
  const setSent = vi.fn();
  const select = vi.fn();
  const view = renderHook(
    ({ channelId, selectAfterSend }) =>
      useComposerSent(channelId, selectAfterSend, setSent, select),
    { initialProps: { channelId: "a", selectAfterSend: false } },
  );
  const initial = view.result.current;
  view.rerender({ channelId: "a", selectAfterSend: false });
  expect(view.result.current).toBe(initial);
  act(() => view.result.current("one"));
  expect(setSent).toHaveBeenCalledWith({ channelId: "a", id: "one" });
  expect(select).not.toHaveBeenCalled();
  view.rerender({ channelId: "b", selectAfterSend: true });
  expect(view.result.current).not.toBe(initial);
  act(() => view.result.current("two"));
  expect(setSent).toHaveBeenLastCalledWith({ channelId: "b", id: "two" });
  expect(select).toHaveBeenCalledExactlyOnceWith("b");
});
