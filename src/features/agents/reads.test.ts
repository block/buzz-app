import { expect, it } from "vitest";
import { ownerDm } from "./reads";

const agent = "a".repeat(64);
const owner = "o".repeat(64);
const other = "b".repeat(64);

it("answers only in a DM with just the agent's owner", () => {
  const dm = (members: string[]) => ({ dm: true, members });
  expect(ownerDm(dm([agent, owner]), agent, owner)).toBe(true);
  expect(ownerDm(dm([owner]), agent, owner)).toBe(true);
  expect(ownerDm(dm([agent, owner, other]), agent, owner)).toBe(false);
  expect(ownerDm(dm([agent, other]), agent, owner)).toBe(false);
  expect(ownerDm(dm([agent]), agent, owner)).toBe(false);
  expect(ownerDm(dm([]), agent, owner)).toBe(false);
  expect(ownerDm(dm([agent, owner]), agent, undefined)).toBe(false);
  expect(ownerDm({ dm: false, members: [agent, owner] }, agent, owner)).toBe(
    false,
  );
  expect(ownerDm(undefined, agent, owner)).toBe(false);
});
