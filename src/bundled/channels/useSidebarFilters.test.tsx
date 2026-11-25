// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { sidebarSections } from "./sidebar-sections";
import {
  SIDEBAR_ACTIVE_WINDOW,
  useSidebarFilters,
  type SidebarFilter,
} from "./useSidebarFilters";

const none = new Set<string>();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rowsOf = (
  result: { current: ReturnType<typeof useSidebarFilters> },
  key = "channels",
) =>
  result.current
    .find((section) => section.key === key)
    ?.rows.map(({ id }) => id);

it("keeps the open conversation and ones that need you, and expires idle activity", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const now = Date.now() / 1000;
  const roster: ChannelSummary[] = [
    {
      id: "old",
      name: "Old",
      lastActivityAt: now - SIDEBAR_ACTIVE_WINDOW / 1000,
    },
    {
      id: "fresh",
      name: "Fresh",
      lastActivityAt: now - SIDEBAR_ACTIVE_WINDOW / 1000 + 1,
    },
    { id: "waiting", name: "Waiting", lastActivityAt: 1 },
    { id: "quiet", name: "Quiet", lastActivityAt: 1 },
  ];
  const sections = sidebarSections(roster);
  const { result, rerender, unmount } = renderHook(
    ({ current, mode }) =>
      useSidebarFilters(
        sections,
        { channels: mode },
        current,
        new Set(["waiting"]),
      ),
    { initialProps: { current: "old", mode: "active" as SidebarFilter } },
  );
  expect(rowsOf(result)).toEqual(["fresh", "old", "waiting"]);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(rowsOf(result)).toEqual(["old", "waiting"]);
  rerender({ current: "quiet", mode: "active" });
  expect(rowsOf(result)).toEqual(["quiet", "waiting"]);
  rerender({ current: "quiet", mode: "all" });
  expect(rowsOf(result)).toEqual(["fresh", "old", "quiet", "waiting"]);
  // An older app's Unreads filter is no longer offered and shows everything.
  rerender({ current: "quiet", mode: "unreads" });
  expect(rowsOf(result)).toEqual(["fresh", "old", "quiet", "waiting"]);
  expect(result.current.find(({ key }) => key === "channels")?.allRows).toEqual(
    sections.find(({ key }) => key === "channels")?.rows,
  );
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("reschedules activity deadlines beyond the browser timeout limit", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const sections = sidebarSections([
    { id: "fresh", name: "Fresh", lastActivityAt: Date.now() / 1000 },
  ]);
  const { result, unmount } = renderHook(() =>
    useSidebarFilters(sections, { channels: "active" }, undefined, none),
  );
  act(() => {
    vi.advanceTimersByTime(2_147_483_647);
  });
  expect(rowsOf(result)).toHaveLength(1);
  act(() => {
    vi.advanceTimersByTime(SIDEBAR_ACTIVE_WINDOW - 2_147_483_647);
  });
  expect(rowsOf(result)).toHaveLength(0);
  unmount();
});

it("uses each section's saved window", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const age = 7 * 86400;
  const sections = sidebarSections([
    { id: "old", name: "Old", lastActivityAt: Date.now() / 1000 - age - 1 },
  ]);
  const { result, rerender, unmount } = renderHook(
    ({ seconds }) =>
      useSidebarFilters(sections, { channels: "active" }, undefined, none, {
        channels: seconds,
      }),
    { initialProps: { seconds: age } },
  );
  expect(rowsOf(result)).toEqual([]);
  rerender({ seconds: 14 * 86400 });
  expect(rowsOf(result)).toEqual(["old"]);
  unmount();
});

it("preserves unknown activity until a successful read", () => {
  const sections = sidebarSections([
    { id: "old", name: "Old", lastActivityAt: 1 },
    { id: "unknown", name: "Unknown" },
    { id: "quiet", name: "Quiet", activityKnown: true },
  ]);
  const { result, rerender, unmount } = renderHook(
    ({ ready }) =>
      useSidebarFilters(
        sections,
        { channels: "active" },
        undefined,
        none,
        {},
        ready,
      ),
    { initialProps: { ready: false } },
  );
  expect(rowsOf(result)).toEqual(["unknown"]);
  rerender({ ready: true });
  expect(rowsOf(result)).toEqual([]);
  unmount();
});
