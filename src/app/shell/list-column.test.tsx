// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { sidebarSectionTarget } from "../../features/channel-navigation/sidebar-section-route";
import { useListColumn } from "./list-column";

afterEach(cleanup);

const scope = { viewer: "a".repeat(64), communityOrigin: "https://relay.test" };
const conversation = (channelId: string): OpenTarget => ({
  version: 1,
  kind: "conversation",
  channelId,
  scope,
});
const team = sidebarSectionTarget(scope, "messages");

/** Visits by id; `traversal` marks one navigation returned to, as Back does. */
function harness() {
  const listeners = new Set<() => void>();
  let snapshot = visit("start", conversation("start"));
  function visit(
    id: string,
    target: OpenTarget,
    traversal = false,
    attempt = "attempt",
  ) {
    return {
      entry: { id, target },
      attempt: {
        id: `${id}-${attempt}`,
        ...(traversal && { traversal: true }),
      },
    };
  }
  const navigator = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
  } as unknown as Navigation;
  const view = renderHook(() => useListColumn(navigator));
  return {
    list: () => view.result.current.list,
    column: () => view.result.current,
    go(id: string, target: OpenTarget, traversal = false, attempt?: string) {
      act(() => {
        snapshot = visit(id, target, traversal, attempt);
        for (const listener of listeners) listener();
      });
    },
  };
}

test("a section address opens its list, and other visits leave it as it is", () => {
  const t = harness();
  expect(t.list()).toMatchObject({ open: false });
  t.go("team", team);
  expect(t.list()).toMatchObject({ open: true, section: "messages" });
  t.go("alpha", conversation("alpha"));
  expect(t.list()).toMatchObject({ open: true, section: "messages" });
  act(() => t.column().setOpen(false, true));
  expect(t.list()).toMatchObject({ open: false, animate: true });
  t.go("beta", conversation("beta"));
  expect(t.list()).toMatchObject({ open: false, animate: false });
});

test("Back and Forward restore what each visit last showed", () => {
  const t = harness();
  t.go("team", team);
  t.go("alpha", conversation("alpha"));
  act(() => t.column().setOpen(false));
  t.go("start", conversation("start"), true);
  expect(t.list()).toMatchObject({ open: false });
  t.go("alpha", conversation("alpha"), true);
  expect(t.list()).toMatchObject({ open: false, section: "messages" });
  t.go("team", team, true);
  expect(t.list()).toMatchObject({ open: true, section: "messages" });
});

test("an open from the list keeps it, even when navigation returns to a held visit", () => {
  const t = harness();
  // Alpha was first opened from the sidebar, with no list.
  t.go("alpha", conversation("alpha"));
  t.go("team", team);
  act(() => t.column().ask("keep"));
  t.go("alpha", conversation("alpha"), true);
  expect(t.list()).toMatchObject({ open: true, section: "messages" });
  // The request was spent: a later Back is an ordinary traversal.
  act(() => t.column().setOpen(false));
  t.go("team", team, true);
  t.go("alpha", conversation("alpha"), true);
  expect(t.list()).toMatchObject({ open: false });
});

test("an open from the sidebar closes the list, at once and on the visit it lands on", () => {
  const t = harness();
  t.go("team", team);
  t.go("alpha", conversation("alpha"));
  t.go("team-again", team);
  act(() => t.column().ask("close"));
  expect(t.list()).toMatchObject({ open: false, section: undefined });
  // Navigation returns to alpha, which last showed the list.
  t.go("alpha", conversation("alpha"), true);
  expect(t.list()).toMatchObject({ open: false, section: undefined });
});

test("an open that stayed on its visit asks nothing of a later one", () => {
  const t = harness();
  t.go("team", team);
  t.go("alpha", conversation("alpha"));
  act(() => t.column().setOpen(false));
  t.go("team", team, true);
  act(() => t.column().ask("keep"));
  // Opening what is already open starts a new attempt on the same visit.
  t.go("team", team, true, "again");
  t.go("alpha", conversation("alpha"), true);
  expect(t.list()).toMatchObject({ open: false });
});

test("a section opened on one of its conversations lists that section", () => {
  const t = harness();
  t.go("team", team);
  act(() => t.column().setOpen(false));
  act(() => t.column().ask({ section: "saved" }));
  t.go("alpha", conversation("alpha"));
  expect(t.list()).toMatchObject({ open: true, section: "saved" });
});
