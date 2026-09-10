import { expect, it, vi } from "vitest";
import { selectProfiles } from "./profile-selection";
import { createRelaySession } from "./session";
import type { Profile } from "./contracts";

it("does not notify or replace a selected snapshot for unrelated profile changes", () => {
  const store = createRelaySession(null);
  const alice = { name: "Alice" };
  let profiles: ReadonlyMap<string, Profile> = new Map([["alice", alice]]);
  let notify = () => {};
  const selection = selectProfiles(
    {
      ...store.session.profiles,
      snapshot: () => profiles,
      subscribe(listener) {
        notify = listener;
        return () => {};
      },
    },
    ["alice"],
  );
  const before = selection.snapshot();
  const listener = vi.fn();
  selection.subscribe(listener);
  profiles = new Map([
    ["alice", alice],
    ["bob", { name: "Bob" }],
  ]);
  notify();
  expect(listener).not.toHaveBeenCalled();
  expect(selection.snapshot()).toBe(before);
  profiles = new Map([["alice", { name: "Alice Updated" }]]);
  notify();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(selection.snapshot()).not.toBe(before);
  store.dispose();
});
