import { railSections } from "./rail-sections";
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useRailLayout } from "./rail-layout";
import type { RailEntry } from "./rail-pins";

const entry: RailEntry = {
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

test("a saved section that isn't shown keeps its place through reorders and new sections", () => {
  const { result, unmount } = renderHook(() => useRailLayout("order"));
  act(() => {
    result.current.reorder("solo", "pins", [
      "pins",
      "example.plugin/section",
      "solo",
    ]);
  });
  expect(result.current.layout.order).toEqual([
    "solo",
    "pins",
    "example.plugin/section",
  ]);
  // The plugin is starting or disabled: its section isn't shown.
  act(() => {
    result.current.reorder("pins", "solo", ["solo", "pins"]);
    result.current.create("project", "Project");
  });
  unmount();
  const restored = renderHook(() => useRailLayout("order"));
  expect(restored.result.current.layout.order).toEqual([
    "pins",
    "solo",
    "example.plugin/section",
  ]);
  expect(restored.result.current.layout.sections).toEqual([
    { id: "custom:project", title: "Project" },
  ]);
});

// Storage failure and account switches are state-owner contracts; pointer/drop
// geometry and the naming/cancel flow belong to messages-layout.spec.mjs.
test("a saved arrangement survives remounts, stays scoped, and retains confirmed placement after a failed write", () => {
  const first = renderHook(({ scope }) => useRailLayout(scope), {
    initialProps: { scope: "account-a:community-a" },
  });
  act(() => {
    expect(first.result.current.create("project", "Project", entry)).toBe(true);
    expect(
      first.result.current.reorder("solo", "pins", [
        "pins",
        "messages",
        "solo",
        "custom:project",
      ]),
    ).toBe(true);
  });
  first.rerender({ scope: "account-a:community-b" });
  expect(first.result.current.layout.placements).toEqual([]);
  first.rerender({ scope: "account-b:community-a" });
  expect(first.result.current.layout.sections).toEqual([]);
  first.unmount();
  const restored = renderHook(() => useRailLayout("account-a:community-a"));
  expect(restored.result.current.layout.order).toEqual([
    "solo",
    "pins",
    "messages",
    "custom:project",
  ]);
  expect(restored.result.current.layout.placements).toEqual([
    { section: "custom:project", entry },
  ]);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  act(() => {
    expect(restored.result.current.move(entry, "custom:other")).toBe(false);
  });
  expect(restored.result.current.layout.placements).toEqual([
    { section: "custom:project", entry },
  ]);
  write.mockRestore();
  act(() => {
    expect(restored.result.current.remove("custom:project")).toBe(true);
  });
  expect(restored.result.current.layout.sections).toEqual([]);
  expect(restored.result.current.layout.placements).toEqual([]);
});

test("cards, expanded lists, and routing share contributed section membership", () => {
  const model = railSections(
    {
      order: [],
      sections: [],
      placements: [{ section: "example.plugin/section", entry }],
    },
    [{ id: "example.plugin/section", title: "Plugin work" }],
  );
  expect(model.sections.get("example.plugin/section")).toBe("Plugin work");
  expect(model.owner((candidate) => candidate.id === entry.id)).toBe(
    "example.plugin/section",
  );
  // The section holds a copy: the conversation stays in its own list.
  expect(model.entries("messages", [entry])).toEqual([entry]);
  expect(model.entries("example.plugin/section", [])).toEqual([entry]);
  // Disabling the contribution leaves only the conversation's own list.
  const disabled = railSections({
    order: [],
    sections: [],
    placements: [{ section: "example.plugin/section", entry }],
  });
  expect(
    disabled.owner((candidate) => candidate.id === entry.id),
  ).toBeUndefined();
  expect(disabled.entries("messages", [entry])).toEqual([entry]);
});

test("a conversation keeps its own list while sections a person made hold copies", () => {
  const saved = (placements: { section: string; entry: typeof entry }[]) =>
    railSections({
      order: [],
      sections: [
        { id: "custom:work", title: "Work" },
        { id: "custom:later", title: "Later" },
      ],
      placements,
    });
  const copied = saved([
    { section: "custom:work", entry },
    { section: "custom:later", entry },
  ]);
  expect(copied.entries("messages", [entry])).toEqual([entry]);
  expect(copied.entries("custom:work", [])).toEqual([entry]);
  expect(copied.entries("custom:later", [])).toEqual([entry]);
  // An arrangement saved earlier could put a conversation in Solo or Plugins.
  const misplaced = saved([{ section: "solo", entry }]);
  expect(misplaced.entries("solo", [])).toEqual([]);
  expect(misplaced.entries("messages", [entry])).toEqual([entry]);
});
