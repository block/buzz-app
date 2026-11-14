import { expect, it } from "vitest";
import { guestKeys } from "./guests";
import { guestMentionDetail } from "../../bundled/mentions/mention-candidates";

it("finds only the confirmed roster's guests", () => {
  const channel = { id: "c", name: "c", members: ["a", "b"], guests: ["a"] };
  expect([...guestKeys(channel as never)]).toEqual(["a"]);
  expect(guestKeys({ ...channel, cached: true } as never).size).toBe(0);
  expect(guestKeys({ ...channel, guests: undefined } as never).size).toBe(0);
  expect(guestKeys(undefined).size).toBe(0);
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
