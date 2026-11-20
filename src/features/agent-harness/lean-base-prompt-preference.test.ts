// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { composeBase } from "./sections/compose";

const key = "buzz-agents-lean-base-prompt.v1";
const facts = { scope: "thread" } as const;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each([null, "off", "", "true", "invalid", "on"])(
  "defaults to lean unless explicitly disabled (stored=%s)",
  (stored) => {
    if (stored !== null) localStorage.setItem(key, stored);
    expect(composeBase(facts).text).toBe(
      composeBase(facts, stored !== "off").text,
    );
    expect(localStorage.getItem(key)).toBe(stored);
  },
);

it("keeps the lean default when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(composeBase(facts).text).toBe(composeBase(facts, true).text);
});
