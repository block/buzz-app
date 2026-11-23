import { describe, expect, it } from "vitest";
import {
  MatchRank,
  matchedPositions,
  matchName,
  matchRank,
  nameField,
  rankTerms,
  searchTerms,
  TERMS_APART,
} from "./match";
import { personFields } from "./people-rank";

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
    ["buzz-hive-team", "team buzz", MatchRank.words, "[buzz]-hive-[team]"],
    ["buzz-steam-team", "zz-team", MatchRank.words, "bu[zz]-steam-[team]"],
    ["mybuzz-steam", "buzz-team", MatchRank.words, "my[buzz]-s[team]"],
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

/** One name's rule, as channel and direct message rows use it. */
const nameRank = (name: string, needle: string) =>
  rankTerms(needle, [nameField(name)]);
/** The code points one name underlines. */
const namePositions = (name: string, needle: string) =>
  matchedPositions(needle, [nameField(name)]);

it("splits typed text into its words", () => {
  expect(searchTerms("community buzz")).toEqual(["community", "buzz"]);
  expect(searchTerms("  dark \t settings\n")).toEqual(["dark", "settings"]);
  expect(searchTerms("alice")).toEqual(["alice"]);
  expect(searchTerms("   ")).toEqual([]);
});

it("ranks one word exactly as the row's own rule ranks it", () => {
  const names = [
    "alice",
    "Alice Fixture",
    "Carol Fixture",
    "buzz-community",
    "team-launch-planning",
    "debounce-tags",
    "Show live and recent agent work alongside conversations.",
  ];
  const words = ["alice", "alce", "tlp", "beta", "bc", "wes", "mute", "x"];
  for (const name of names)
    for (const word of words) {
      expect(nameRank(name, word)).toBe(matchRank(name, word));
      expect(namePositions(name, word)).toEqual(
        matchName(name, word)?.positions,
      );
    }
  // Spaces around one word do not make it several.
  expect(nameRank("Alice Fixture", "fixture ")).toBe(
    matchRank("Alice Fixture", "fixture "),
  );
  // A word the rule misses is a miss, whichever way the rule says so.
  expect(rankTerms("alice", [], () => undefined)).toBeUndefined();
  expect(rankTerms("alice", [], () => Infinity)).toBeUndefined();
});

it("keeps the whole text's rank when the whole text matches", () => {
  // A phrase in the name, and the looser ranks that ignore the space.
  expect(nameRank("Alice Fixture", "alice fixture")).toBe(MatchRank.exact);
  expect(nameRank("Alice Fixture, Bob Fixture", "alice fixture")).toBe(
    MatchRank.prefix,
  );
  expect(nameRank("buzz-community", "buzz community")).toBe(MatchRank.wordRuns);
  expect(nameRank("buzz-hive-team", "team buzz")).toBe(MatchRank.words);
});

it("matches several words apart, in any order, by the weakest word", () => {
  // Upstream unordered-word matches keep their whole-query rank.
  expect(nameRank("buzz-community", "community buzz")).toBe(MatchRank.words);
  expect(nameRank("Alice Fixture", "fixture alice")).toBe(MatchRank.words);
  // Each word can still match by word runs; scattered letters stay excluded.
  expect(nameRank("team-launch-planning-notes", "notes tlp")).toBe(
    TERMS_APART + MatchRank.wordRuns,
  );
  expect(nameRank("Alice Fixture", "fixture alce")).toBeUndefined();
  // Every word must match.
  expect(nameRank("buzz-community", "community fuzz")).toBeUndefined();
  expect(nameRank("Alice Fixture", "fixture alice bob")).toBeUndefined();
});

it("holds words typed apart to different fragments of the row", () => {
  // A typed space says the words are different words of the row: a name of
  // one fragment cannot hold two, and "b" has only "buzz" to be in.
  expect(nameRank("quality", "q a")).toBeUndefined();
  expect(nameRank("quality", "q al")).toBeUndefined();
  expect(nameRank("buzz-community", "buzz b")).toBeUndefined();
  // Initials hold every word they start, so "team" has no word left.
  expect(nameRank("team-launch-planning", "team tlp")).toBeUndefined();
  // A word in another fragment still matches, also when its best place is
  // the one the other word needs: "b" starts "buzz" and "bugs".
  expect(nameRank("team-launch-planning-notes", "notes t")).toBe(
    TERMS_APART + MatchRank.wordStart,
  );
  expect(nameRank("buzz-bugs", "b buzz")).toBe(
    TERMS_APART + MatchRank.wordStart,
  );
  // The whole text is not held to this.
  expect(nameRank("q&a", "q a")).toBe(MatchRank.wordRuns);
  expect(nameRank("buzz-community", "buzz bu")).toBe(MatchRank.words);
});

it("ranks a row found only word by word after every whole-text match", () => {
  const loosest = MatchRank.words + 2; // the loosest rank plus a penalty
  expect(nameRank("team-launch-planning-notes", "notes tlp")).toBeGreaterThan(
    loosest,
  );
  // A phrase in one name leads a name that holds the words apart.
  const names = ["notes-for-voice", "my voice notes", "Voice Notes"];
  expect(
    names
      .map((name) => ({ name, rank: nameRank(name, "voice notes") }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
      .map(({ name }) => name),
  ).toEqual(["Voice Notes", "my voice notes", "notes-for-voice"]);
});

it("lets each word match a different field, with that field's cap and penalty", () => {
  // A plugin row: its name, then its description by contiguous text only,
  // two steps behind.
  const huddles = [
    nameField("Huddles"),
    nameField("plugins Start audio conversations in your channels.", {
      cap: MatchRank.substring,
      penalty: 2,
    }),
  ];
  // Name (1), and description word start (2) plus its penalty.
  expect(rankTerms("huddles audio", huddles)).toBe(TERMS_APART + 4);
  expect(rankTerms("audio huddles", huddles)).toBe(TERMS_APART + 4);
  // Both words in the description.
  expect(rankTerms("audio channels", huddles)).toBe(TERMS_APART + 4);
  // Two words need two fragments, in whichever fields: "au" is only in
  // "audio".
  expect(rankTerms("audio au", huddles)).toBeUndefined();
  // The cap still holds for each word: "ado" is in the description only as
  // letters in order.
  expect(rankTerms("huddles ado", huddles)).toBeUndefined();
  // One word is never split, so the cap holds for it as before.
  expect(rankTerms("alice", huddles)).toBeUndefined();
});

it("underlines the whole text's match, or failing that each word's", () => {
  const marked = (label: string, needle: string) => {
    const positions = new Set(namePositions(label, needle));
    return [...label]
      .map((char, index) => (positions.has(index) ? char.toUpperCase() : "."))
      .join("");
  };
  // The whole text: as `matchName` underlines it, the space included.
  expect(marked("alice fixture", "alice fix")).toBe("ALICE FIX....");
  expect(namePositions("buzz-community", "buzz community")).toEqual(
    matchName("buzz-community", "buzz community")?.positions,
  );
  // Words apart: every word, in the label's order.
  expect(marked("alice fixture", "fixture alice")).toBe("ALICE.FIXTURE");
  expect(marked("buzz-community", "comm buzz")).toBe("BUZZ.COMM.....");
  // The place the row matched through, not each word's best: "buzz" holds
  // its fragment, so "b" is the one in "bugs".
  expect(marked("buzz-bugs", "b buzz")).toBe("BUZZ.B...");
  // A word the row holds in another field underlines nothing here.
  expect(marked("huddles", "audio hud")).toBe("HUD....");
  expect(namePositions("huddles", "audio channels")).toBeUndefined();
  // The label's own rule decides: a person's name matches at word starts.
  const alice = personFields({
    pubkey: "a".repeat(64),
    label: "Alice Fixture",
    agent: false,
    relationship: 0,
    usageKeys: [],
  });
  expect(matchedPositions("fixture alice", alice)).toEqual([
    0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  ]);
  expect(matchedPositions("ixture alice", alice)).toEqual([0, 1, 2, 3, 4]);
});
