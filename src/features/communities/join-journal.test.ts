// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createJoinJournal } from "./join-journal";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("partitions pending joins by identity and community and fences replaced transactions", () => {
  const journal = createJoinJournal("a".repeat(64));
  const first = journal.begin("https://one.test", {
    name: "Saved",
    picture: "",
  });
  const other = journal.begin("https://two.test");
  const replacement = journal.begin("https://one.test/");
  expect(journal.current(first)).toBe(false);
  expect(journal.current(other)).toBe(true);
  journal.finish(first);
  expect(journal.current(replacement)).toBe(true);
  expect(journal.latest()?.profile?.name).toBe("Saved");
  expect(createJoinJournal("b".repeat(64)).latest()).toBeUndefined();
  journal.finish(replacement);
  expect(journal.latest()).toEqual(other);
});
it("preserves malformed recovery data instead of overwriting it before a new claim", () => {
  const key = `buzz-community-joins.v1:${"a".repeat(64)}`;
  localStorage.setItem(key, "corrupt");
  const journal = createJoinJournal("a".repeat(64));
  expect(() => journal.begin("https://one.test")).toThrow(
    "Could not read unfinished",
  );
  expect(localStorage.getItem(key)).toBe("corrupt");
});
