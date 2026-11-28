import { expect, test } from "vitest";
import { keyLabel, LEADER, sequenceChoices, type Sequence } from "./sequences";

const run = () => {};
const sequences: Sequence[] = [
  { keys: "gg", title: "Top", run },
  { keys: "go", title: "Actions", run },
  { keys: `${LEADER}sk`, title: "Keyboard shortcuts", run },
  { keys: `${LEADER}s/`, title: "Search Buzz", run },
  { keys: `${LEADER}h`, title: "Home", run },
];
const groups = [{ keys: `${LEADER}s`, title: "Search" }];

test("a prefix lists each next key once, naming groups", () => {
  expect(sequenceChoices(LEADER, sequences, groups)).toEqual([
    { key: "s", title: "Search", group: true },
    { key: "h", title: "Home", group: false },
  ]);
  expect(sequenceChoices(`${LEADER}s`, sequences, groups)).toEqual([
    { key: "k", title: "Keyboard shortcuts", group: false },
    { key: "/", title: "Search Buzz", group: false },
  ]);
  expect(sequenceChoices("x", sequences, groups)).toEqual([]);
  expect(keyLabel(LEADER)).toBe("Space");
});
