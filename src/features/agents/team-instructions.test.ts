import { expect, it } from "vitest";
import { teamTextConflict, type TeamText } from "./team-instructions";

const a = "a".repeat(64);
const b = "b".repeat(64);
const other = (text: string, agents = [a]): TeamText => ({
  team: { type: "team", id: "other", name: "Reviewers", agents },
  text,
});
const team = { id: "mine", agents: [a] };

it("names the other team when a shared member would get different text", () => {
  expect(teamTextConflict([other("THEIRS")], team, "OURS")).toContain(
    '"Reviewers"',
  );
});

it.each([
  ["the saved team has no text", [other("THEIRS")], team, ""],
  ["the other team has no text", [other("")], team, "OURS"],
  ["the text matches after trimming", [other("OURS")], team, " OURS\n"],
  ["no member is shared", [other("THEIRS", [b])], team, "OURS"],
  [
    "the other entry is this team",
    [other("THEIRS")],
    { ...team, id: "other" },
    "OURS",
  ],
])("allows the save when %s", (_, others, saved, text) => {
  expect(teamTextConflict(others, saved, text)).toBeUndefined();
});
