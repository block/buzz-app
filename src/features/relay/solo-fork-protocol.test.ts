import { expect, it } from "vitest";
import { soloFork } from "./solo-fork-protocol";

const source = "22222222-2222-4222-8222-222222222222";
const cutoff = "ab".repeat(32);
const pointer = ["forked_from", source, cutoff];
it("distinguishes ordinary metadata from one canonical ancestry pointer", () => {
  expect(soloFork({ tags: [] })).toBeUndefined();
  expect(soloFork({ tags: [pointer] })).toEqual({
    channelId: source,
    messageId: "ab".repeat(32),
  });
  for (const tags of [
    [pointer, pointer],
    [["forked_from", source]],
    [[...pointer, "extra"]],
    [["forked_from", "00000000-0000-0000-0000-000000000000", cutoff]],
    [["forked_from", source.replaceAll("-", ""), cutoff]],
    [["forked_from", source, "AB".repeat(32)]],
    [["forked_from", source, "g".repeat(64)]],
  ])
    expect(() => soloFork({ tags })).toThrow("invalid source metadata");
});
