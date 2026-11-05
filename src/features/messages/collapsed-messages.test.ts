// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  COLLAPSED_MESSAGE_LIMIT,
  forgetCollapsedMessages,
  setMessageCollapsed,
  useMessageCollapsed,
} from "./collapsed-messages";

const alice = `https://one.example:${"a".repeat(64)}`;
const bob = `https://one.example:${"b".repeat(64)}`;
const elsewhere = `https://two.example:${"a".repeat(64)}`;
const saved = (scope: string) =>
  JSON.parse(
    localStorage.getItem(`buzz.collapsed-messages.v1:${scope}`) ?? "[]",
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const scope of [alice, bob, elsewhere]) forgetCollapsedMessages(scope);
  localStorage.clear();
});

it("keeps each community and viewer's collapsed messages apart", () => {
  setMessageCollapsed(alice, "m1", true, 5);
  const { result: own } = renderHook(() => useMessageCollapsed(alice, "m1"));
  const { result: other } = renderHook(() => useMessageCollapsed(bob, "m1"));
  const { result: away } = renderHook(() =>
    useMessageCollapsed(elsewhere, "m1"),
  );
  expect([own.current, other.current, away.current]).toEqual([
    true,
    false,
    false,
  ]);
  expect(saved(alice)).toEqual([["m1", 5]]);
  act(() => setMessageCollapsed(alice, "m1", false));
  expect(own.current).toBe(false);
  expect(saved(alice)).toEqual([]);
});

it("evicts the oldest-collapsed message past the limit", () => {
  localStorage.setItem(
    `buzz.collapsed-messages.v1:${alice}`,
    JSON.stringify([
      ["bad", "time"],
      7,
      ...Array.from({ length: COLLAPSED_MESSAGE_LIMIT }, (_, index) => [
        `m${index}`,
        COLLAPSED_MESSAGE_LIMIT - index,
      ]),
    ]),
  );
  setMessageCollapsed(alice, "new", true, 10_000);
  const ids = saved(alice).map(([id]: [string]) => id);
  expect(ids).toHaveLength(COLLAPSED_MESSAGE_LIMIT);
  // m999 was collapsed first (time 1), so it leaves first.
  expect(ids).not.toContain(`m${COLLAPSED_MESSAGE_LIMIT - 1}`);
  expect(ids).toContain("m0");
  expect(ids.at(-1)).toBe("new");
});

it("re-collapsing a message makes it the newest", () => {
  setMessageCollapsed(alice, "a", true, 1);
  setMessageCollapsed(alice, "b", true, 2);
  setMessageCollapsed(alice, "a", true, 3);
  expect(saved(alice)).toEqual([
    ["b", 2],
    ["a", 3],
  ]);
});

it("throws and keeps the shown state when the choice is not saved", () => {
  const { result } = renderHook(() => useMessageCollapsed(alice, "m1"));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(() => setMessageCollapsed(alice, "m1", true)).toThrow();
  expect(result.current).toBe(false);
});

it("shows another window's choices and a cleared community", () => {
  const { result } = renderHook(() => useMessageCollapsed(alice, "m1"));
  localStorage.setItem(
    `buzz.collapsed-messages.v1:${alice}`,
    JSON.stringify([["m1", 1]]),
  );
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `buzz.collapsed-messages.v1:${alice}`,
      }),
    );
  });
  expect(result.current).toBe(true);
  act(() => forgetCollapsedMessages(alice));
  expect(result.current).toBe(false);
});

it("treats unreadable choices as all expanded", () => {
  localStorage.setItem(`buzz.collapsed-messages.v1:${alice}`, "{");
  const { result } = renderHook(() => useMessageCollapsed(alice, "m1"));
  expect(result.current).toBe(false);
});
