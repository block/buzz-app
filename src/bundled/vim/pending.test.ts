// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createPending, WHICH_KEY } from "./pending";
import type { Sequence } from "./sequences";

const created: ReturnType<typeof createPending>[] = [];
afterEach(() => {
  for (const pending of created.splice(0)) pending.cancel();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const keydown = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
};

function setup(showAfter = 300) {
  const top = vi.fn();
  const actions = vi.fn();
  const sequences: Sequence[] = [
    { keys: "gg", title: "Top", run: top },
    { keys: "go", title: "Actions", run: actions },
  ];
  const pending = createPending(
    () => sequences,
    () => showAfter,
  );
  created.push(pending);
  return { pending, top, actions };
}

test("the next key runs a sequence and is consumed", () => {
  const { pending, top } = setup();
  pending.start("g");
  const event = keydown("g");
  expect(event.defaultPrevented).toBe(true);
  expect(top).toHaveBeenCalledTimes(1);
  expect(pending.snapshot()).toBeUndefined();
});

test("the menu shows after the pause, not before", () => {
  vi.useFakeTimers();
  const { pending } = setup();
  pending.start("g");
  expect(pending.snapshot()).toEqual({ typed: "g", shown: false });
  vi.advanceTimersByTime(299);
  expect(pending.snapshot()?.shown).toBe(false);
  vi.advanceTimersByTime(1);
  expect(pending.snapshot()).toEqual({ typed: "g", shown: true });
});

test("Escape, an unknown key, a modified key or a click elsewhere cancels", () => {
  const { pending, top, actions } = setup();
  pending.start("g");
  expect(keydown("Escape").defaultPrevented).toBe(true);
  expect(pending.snapshot()).toBeUndefined();

  pending.start("g");
  expect(keydown("x").defaultPrevented).toBe(true);
  expect(pending.snapshot()).toBeUndefined();

  pending.start("g");
  // The modified key still does its own job.
  expect(keydown("k", { metaKey: true }).defaultPrevented).toBe(false);
  expect(pending.snapshot()).toBeUndefined();

  pending.start("g");
  document.body.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true }),
  );
  expect(pending.snapshot()).toBeUndefined();
  expect(top).not.toHaveBeenCalled();
  expect(actions).not.toHaveBeenCalled();
});

test("a held first key does not complete the sequence", () => {
  const { pending, top } = setup();
  pending.start("g");
  expect(keydown("g", { repeat: true }).defaultPrevented).toBe(true);
  expect(top).not.toHaveBeenCalled();
  expect(pending.snapshot()?.typed).toBe("g");
});

test("arrows drive a shown menu, and the action runs where the sequence began", () => {
  const { pending, actions } = setup(0);
  const row = document.createElement("button");
  const menu = document.createElement("div");
  menu.setAttribute(WHICH_KEY, "");
  menu.tabIndex = -1;
  document.body.append(row, menu);
  row.focus();
  pending.start("g");
  menu.focus();
  expect(keydown("ArrowDown").defaultPrevented).toBe(false);
  expect(keydown("ArrowDown", { repeat: true }).defaultPrevented).toBe(false);
  expect(pending.snapshot()?.shown).toBe(true);
  let focusedWhenRun: Element | null = null;
  actions.mockImplementation(() => {
    focusedWhenRun = document.activeElement;
  });
  pending.press("o");
  expect(actions).toHaveBeenCalledTimes(1);
  expect(focusedWhenRun).toBe(row);
});
