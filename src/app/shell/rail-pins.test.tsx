// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useRailPins, type RailEntry } from "./rail-pins";

const pin: RailEntry = {
  id: "channel:planning",
  label: "Planning",
  kind: "channel",
  target: {
    version: 1,
    kind: "conversation",
    channelId: "planning",
    scope: { viewer: "a".repeat(64), communityOrigin: "https://example.org" },
  },
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("pins stay with their account and community across hook lifetimes", () => {
  const first = renderHook(({ scope }) => useRailPins(scope), {
    initialProps: { scope: "account-a:community-a" },
  });
  act(() => {
    expect(first.result.current.setPinned(pin, true)).toBe(true);
  });
  first.rerender({ scope: "account-a:community-b" });
  expect(first.result.current.pins).toEqual([]);
  first.rerender({ scope: "account-b:community-a" });
  expect(first.result.current.pins).toEqual([]);
  first.unmount();
  const restored = renderHook(() => useRailPins("account-a:community-a"));
  expect(restored.result.current.pins).toEqual([pin]);
  act(() => {
    restored.result.current.setPinned(pin, false);
  });
  expect(restored.result.current.pins).toEqual([]);
});

test("a failed storage write leaves the confirmed pin set intact", () => {
  const { result } = renderHook(() => useRailPins("account:community"));
  act(() => {
    result.current.setPinned(pin, true);
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  act(() => {
    expect(result.current.setPinned(pin, false)).toBe(false);
  });
  expect(result.current.pins).toEqual([pin]);
});

test("obsolete pin targets do not prevent valid pins from restoring", () => {
  localStorage.setItem(
    'buzz-view.v1:["account:community","navigation-pins:v1"]',
    JSON.stringify([
      { ...pin, id: "obsolete", target: { kind: "removed-route" } },
      pin,
    ]),
  );
  const { result } = renderHook(() => useRailPins("account:community"));
  expect(result.current.pins).toEqual([pin]);
});
