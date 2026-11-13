import { expect, it } from "vitest";
import { guestKeys } from "./guests";
import { guestMentionDetail } from "../../bundled/mentions/mention-candidates";

const roles = (map: Record<string, string>) =>
  ({
    snapshot: () => ({ authority: { roles: map } }),
    subscribe: () => () => {},
    refresh: async () => {},
  }) as never;

it("finds only the roster's guests, and none when roles are unknown", () => {
  expect([...guestKeys(roles({ a: "guest", b: "member" }), "c")]).toEqual([
    "a",
  ]);
  expect(guestKeys(undefined, "c").size).toBe(0);
});

it("says where a viewing-only agent answers", () => {
  expect(guestMentionDetail(true, true)).toBe(
    "Viewing only · Answers in your DM or a Solo chat",
  );
  expect(guestMentionDetail(true, false)).toBe(
    "Viewing only · Can’t reply here",
  );
  expect(guestMentionDetail(false, false)).toBe("Viewing only");
});
