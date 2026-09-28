import { expect, it } from "vitest";
import { controlFixture } from "../agents/control-testing";
import {
  exactProfileAgent,
  instanceTarget,
  parseInstanceTarget,
} from "./instance-target";
const target = {
  id: "native/one",
  pubkey: "ab".repeat(32),
  viewer: "cd".repeat(32),
  communityOrigin: "https://relay.example.test",
};
it("round trips an exact native target without accepting malformed or extra claims", () => {
  expect(parseInstanceTarget(instanceTarget(target))).toEqual(target);
  for (const value of [
    { ...target, id: "" },
    { ...target, viewer: "owner" },
    { ...target, pubkey: "other" },
    { ...target, communityOrigin: "wss://relay.example.test" },
    { ...target, owner: true },
  ]) {
    expect(
      parseInstanceTarget(
        `buzz:agent-instance:${encodeURIComponent(JSON.stringify(value))}`,
      ),
    ).toBeUndefined();
  }
  for (const value of [
    "nostr:npub1invalid",
    "buzz:agent-instance:%",
    `buzz:agent-instance:${"x".repeat(4096)}`,
  ])
    expect(parseInstanceTarget(value)).toBeUndefined();
});
it("never substitutes a sibling, duplicate ID, different key or community", () => {
  const { agent } = controlFixture();
  const first = { ...agent, ...target, relayUrl: "wss://relay.example.test" };
  const second = { ...first, id: "two" };
  const scope = `${target.communityOrigin}:${target.viewer}`;
  expect(
    exactProfileAgent([first, second], scope, target.pubkey),
  ).toBeUndefined();
  expect(exactProfileAgent([first, second], scope, target.pubkey, "two")).toBe(
    second,
  );
  expect(
    exactProfileAgent([first], scope, target.pubkey, "two"),
  ).toBeUndefined();
  expect(
    exactProfileAgent([first, first], scope, target.pubkey, first.id),
  ).toBeUndefined();
  expect(
    exactProfileAgent([first], scope, "ff".repeat(32), first.id),
  ).toBeUndefined();
  expect(
    exactProfileAgent(
      [first],
      `https://other.test:${target.viewer}`,
      target.pubkey,
      first.id,
    ),
  ).toBeUndefined();
});
