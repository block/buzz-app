import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigationController } from "./controller";
import { createMemoryHistory, homeTarget } from "./history";
import type { OpenTarget } from "./targets";
const settings: OpenTarget = {
  version: 1,
  kind: "settings",
  section: "appearance",
};
const page: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "test",
  pageId: "board",
};
const cleanups: (() => void)[] = [];
function setup(capacity = 100) {
  const history = createMemoryHistory(homeTarget, capacity);
  const host = createNavigationController(history);
  cleanups.push(host.dispose);
  return { host, navigation: host.navigation, history };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("navigation attempts over one history driver", () => {
  it("pushes, traverses without a push, preserves forward on retry, and truncates new branches", async () => {
    const { host, navigation: nav } = setup();
    const initial = nav.snapshot().entry;
    const first = nav.open(settings);
    const settingsEntry = nav.snapshot().entry;
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(first).resolves.toEqual({ status: "opened" });
    void nav.open(page);
    nav.back();
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    const retry = nav.retry();
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    const same = nav.open(settings);
    await expect(retry).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    nav.forward();
    await expect(same).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot().entry.target).toEqual(page);
    nav.back();
    nav.back();
    expect(nav.snapshot().entry).toBe(initial);
    void nav.open({ version: 1, kind: "settings", section: "plugins" });
    expect(nav.snapshot().canGoForward).toBe(false);
  });
  it("rejects late acknowledgments and aborts obsolete work even after successful reveal", async () => {
    const { host, navigation: nav } = setup();
    const first = nav.open(settings),
      old = nav.snapshot().attempt;
    const second = nav.open(page),
      current = nav.snapshot().attempt;
    expect(old.signal.aborted).toBe(true);
    expect(host.complete(old, { status: "opened" })).toBe(false);
    expect(nav.snapshot().status).toBe("opening");
    expect(host.complete({ ...current }, { status: "opened" })).toBe(false);
    expect(host.complete(current, { status: "opened" })).toBe(true);
    expect(host.complete(current, { status: "opened" })).toBe(false);
    await expect(first).resolves.toEqual({ status: "superseded" });
    await expect(second).resolves.toEqual({ status: "opened" });
    void nav.retry();
    expect(current.signal.aborted).toBe(true);
    expect(nav.snapshot().attempt.id).not.toBe(current.id);
  });
  it("reports truthful failure, timeout and cancellation and keeps the original target retryable", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    const first = nav.open(settings);
    host.complete(nav.snapshot().attempt, {
      status: "failed",
      reason: "unavailable",
    });
    await expect(first).resolves.toEqual({
      status: "failed",
      reason: "unavailable",
    });
    expect(nav.snapshot().entry.target).toEqual(settings);
    expect(nav.snapshot().attempt.signal.aborted).toBe(true);
    const retry = nav.retry();
    expect(nav.snapshot().reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(retry).resolves.toEqual({
      status: "failed",
      reason: "timeout",
    });
    const cancelled = nav.retry();
    host.cancel();
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
  it("rejects invalid targets before cancelling or moving the current intent", async () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const before = nav.snapshot();
    await expect(
      nav.open({ version: 42 } as unknown as OpenTarget),
    ).resolves.toEqual({ status: "failed", reason: "invalid-target" });
    expect(nav.snapshot()).toBe(before);
    expect(before.attempt.signal.aborted).toBe(false);
  });
  it("keeps separate visit identities for the same destination; replace doesn't push", () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const first = nav.snapshot().entry;
    void nav.open(page);
    void nav.open(settings);
    expect(nav.snapshot().entry.id).not.toBe(first.id);
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(page);
    void nav.open(homeTarget, { replace: true });
    nav.back();
    expect(nav.snapshot().entry).toBe(first);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(homeTarget);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
  it("uses driver-initiated traversal and bounds the memory driver without inventing history", () => {
    const { navigation: nav, history } = setup(2);
    void nav.open(settings);
    void nav.open(page);
    history.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    expect(nav.snapshot().canGoBack).toBe(false);
    history.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    history.forward();
    expect(nav.snapshot().entry.target).toEqual(page);
  });
  it("disposes owned work and listeners and cannot reopen afterward", async () => {
    const { host, navigation: nav } = setup();
    const pending = nav.open(page),
      attempt = nav.snapshot().attempt;
    host.dispose();
    expect(attempt.signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    const listener = vi.fn();
    nav.subscribe(listener);
    await expect(nav.open(settings)).resolves.toEqual({ status: "cancelled" });
    nav.back();
    nav.forward();
    expect(listener).not.toHaveBeenCalled();
    expect(host.complete(attempt, { status: "opened" })).toBe(false);
  });
});
