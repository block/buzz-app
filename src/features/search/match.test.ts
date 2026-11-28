import { describe, expect, it } from "vitest";
import { MatchRank, matchName } from "./match";

/** The label with its matched code points in brackets. */
const marked = (label: string, needle: string) => {
  const found = matchName(label, needle);
  if (!found) return undefined;
  const at = new Set(found.positions);
  return [...label]
    .map((char, index) => (at.has(index) ? `[${char}]` : char))
    .join("")
    .replaceAll("][", "");
};

describe("matchName", () => {
  it.each([
    ["buzz-team", "buzz-team", MatchRank.exact, "[buzz-team]"],
    ["buzz-team-notes", "buzz-team", MatchRank.prefix, "[buzz-team]-notes"],
    ["old buzz-team", "buzz-team", MatchRank.wordStart, "old [buzz-team]"],
    ["mybuzz-team", "buzz-team", MatchRank.substring, "my[buzz-team]"],
    ["buzz-hive-team", "buzz-team", MatchRank.wordRuns, "[buzz-]hive-[team]"],
    [
      "team-launch-planning",
      "tlp",
      MatchRank.wordRuns,
      "[t]eam-[l]aunch-[p]lanning",
    ],
    [
      "buzz-community",
      "buzz community",
      MatchRank.wordRuns,
      "[buzz]-[community]",
    ],
    [
      "Latest aspen ab results",
      "lat res",
      MatchRank.wordRuns,
      "[Lat]est aspen ab [res]ults",
    ],
    ["ios17-release", "ios 17", MatchRank.wordRuns, "[ios17]-release"],
    [
      "on-call-handoff",
      "oncall handoff",
      MatchRank.wordRuns,
      "[on]-[call]-[handoff]",
    ],
    ["buzz-hive-team", "team buzz", MatchRank.words, "[buzz]-hive-[team]"],
    ["buzz-hive-team", "tea buz", MatchRank.words, "[buz]z-hive-[tea]m"],
    [
      "React docs for ReactNative",
      "react-native",
      MatchRank.words,
      "React docs for [ReactNative]",
    ],
    ["q-and-a", "a q", MatchRank.words, "[q]-and-[a]"],
    ["काम-की", "की काम", MatchRank.words, "[काम]-[की]"],
  ])("%s for %s", (label, needle, rank, underlined) => {
    expect(matchName(label, needle)?.rank).toBe(rank);
    expect(marked(label, needle)).toBe(underlined);
  });

  it.each([
    ["buzz-internal-investments", "buzz-team"],
    ["Buzz-alerts monitor false alarm tuning", "buzz-team"],
    ["https://github.com/example-org/buzz-app/pulls", "buzz-team"],
    ["general", "gnrl"],
    ["Add a local task log and Attention source", "lat ts"],
    ["Latest aspen ab results", "lat ts"],
    ["general", "-"],
    ["quality", "q&a"],
    ["काम", "की"],
    ["बाकी-काम", "की काम"],
    ["abc-cafe\u0301s", "e\u0301 abc"],
    ["काम-कल", "मक"],
  ])("%s does not match %s", (label, needle) => {
    expect(matchName(label, needle)).toBeUndefined();
  });
});
