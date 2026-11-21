// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createRememberedStates,
  REMEMBERED_STATES,
  RESAVE_MS,
} from "./remembered-states";

const pull = "https://github.com/block/buzz-app/pull/7";
const issue = "https://github.com/block/buzz-app/issues/8";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("keeps what links show of each read across sessions, and nothing else", () => {
  const remembered = createRememberedStates(localStorage);
  remembered.remember(
    [
      [
        pull,
        {
          state: "open",
          title: "Cache link states",
          checks: "pending",
          conflicts: false,
          head: "abc",
          feedback: { viewer: "me", ids: [], items: [] },
        },
      ],
      [issue, { state: "closed", reason: "not planned", title: "Old" }],
    ],
    1_000,
  );
  const later = createRememberedStates(localStorage);
  expect(later.get(pull)).toEqual({
    state: "open",
    title: "Cache link states",
    checks: "pending",
    conflicts: false,
  });
  expect(later.readAt(pull)).toBe(1_000);
  expect(later.get(issue)).toEqual({
    state: "closed",
    reason: "not planned",
    title: "Old",
  });
  // One object while unchanged, so a link showing it is left be.
  expect(later.get(pull)).toBe(later.get(pull));
  const shown = later.get(pull);
  later.remember(
    [
      [
        pull,
        {
          state: "open",
          title: "Cache link states",
          checks: "pending",
          conflicts: false,
          head: "def",
        },
      ],
    ],
    2_000,
  );
  expect(later.get(pull)).toBe(shown);
  expect(later.readAt(pull)).toBe(2_000);
});

it("lets the ones read longest ago go first", () => {
  const remembered = createRememberedStates(localStorage);
  const url = (n: number) => `https://github.com/block/buzz-app/pull/${n}`;
  for (let n = 1; n <= REMEMBERED_STATES; n++)
    remembered.remember([[url(n), { state: "merged" }]], n);
  // Read again, the first is the newest.
  remembered.remember([[url(1), { state: "merged" }]], REMEMBERED_STATES + 1);
  remembered.remember([[url(0), { state: "open" }]], REMEMBERED_STATES + 2);
  const later = createRememberedStates(localStorage);
  expect(later.get(url(1))).toBeDefined();
  expect(later.get(url(2))).toBeUndefined();
  expect(later.get(url(0))).toEqual({ state: "open" });
});

it("skips what it cannot make sense of, and works without storage", () => {
  localStorage.setItem(
    "buzz.github.link-states.v1",
    JSON.stringify({
      [pull]: { at: 1, state: { state: "open", title: "Fine" } },
      [issue]: { at: 1, state: { state: "exploded" } },
      x: { at: "soon", state: { state: "open" } },
    }),
  );
  const remembered = createRememberedStates(localStorage);
  expect(remembered.get(pull)).toEqual({ state: "open", title: "Fine" });
  expect(remembered.get(issue)).toBeUndefined();
  expect(remembered.get("x")).toBeUndefined();

  localStorage.setItem("buzz.github.link-states.v1", "{not json");
  expect(createRememberedStates(localStorage).get(pull)).toBeUndefined();

  const unsaved = createRememberedStates(null);
  unsaved.remember([[pull, { state: "draft" }]], 1);
  expect(unsaved.get(pull)).toEqual({ state: "draft" });
});

it("saves a read again unchanged only every few minutes, and lets go of those forgotten", () => {
  const storage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  } as unknown as Storage & { setItem: ReturnType<typeof vi.fn> };
  const remembered = createRememberedStates(storage);
  remembered.remember([[pull, { state: "open", title: "A" }]], 0);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  remembered.remember([[pull, { state: "open", title: "A" }]], 60_000);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(remembered.readAt(pull)).toBe(60_000);
  remembered.remember([[pull, { state: "open", title: "B" }]], 120_000);
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  remembered.remember(
    [[pull, { state: "open", title: "B" }]],
    120_000 + RESAVE_MS,
  );
  expect(storage.setItem).toHaveBeenCalledTimes(3);
  remembered.forget([issue]);
  expect(storage.setItem).toHaveBeenCalledTimes(3);
  remembered.forget([pull]);
  expect(storage.setItem).toHaveBeenCalledTimes(4);
  expect(remembered.get(pull)).toBeUndefined();
});

it("keeps them for the session where storage is refused", () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Refused", "SecurityError");
    },
  });
  try {
    const remembered = createRememberedStates();
    remembered.remember([[pull, { state: "merged" }]], 1);
    expect(remembered.get(pull)).toEqual({ state: "merged" });
  } finally {
    if (own) Object.defineProperty(globalThis, "localStorage", own);
  }
});

it("keeps an open pull request's review, so an approved one opens approved", () => {
  const remembered = createRememberedStates(localStorage);
  remembered.remember(
    [
      [pull, { state: "open", title: "A", review: "approved" }],
      [issue, { state: "open", review: "changes requested" }],
    ],
    1,
  );
  const later = createRememberedStates(localStorage);
  expect(later.get(pull)).toEqual({
    state: "open",
    title: "A",
    review: "approved",
  });
  expect(later.get(issue)).toEqual({
    state: "open",
    review: "changes requested",
  });

  localStorage.setItem(
    "buzz.github.link-states.v1",
    JSON.stringify({
      [pull]: { at: 1, state: { state: "open", review: "rubber-stamped" } },
    }),
  );
  expect(createRememberedStates(localStorage).get(pull)).toBeUndefined();
});
