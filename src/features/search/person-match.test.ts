import { describe, expect, it } from "vitest";
import {
  extendsName,
  foldName,
  matchPerson,
  normalizeName,
} from "./person-match";

describe("matchPerson", () => {
  it.each([
    ["Honey", "honey", 0],
    ["Honey Bee", "honey", 1],
    ["Honey Bee", "honey b", 1],
    ["A Honey", "honey", 2],
    ["A Honeybee", "honey", 3],
    ["Honey", "oney", undefined],
    ["Honey Bee", "honey  b", undefined],
    ["  Honey  ", " HONEY ", 0],
    ["José", "jose", 0],
    ["Jose", "José", 0],
    ["Mary José", "jose", 2],
    ["ΠΑΡΟΣ", "παρος", 0],
    ["İpek", "ipek", 0],
    ["ﬁona", "fio", 1],
  ])("%s for %s is tier %s", (name, query, tier) => {
    expect(matchPerson(name, query)?.tier).toBe(tier);
  });

  it("matches everything for an empty query", () => {
    expect(matchPerson("Anyone", "  ")).toEqual({ tier: 0, positions: [] });
  });

  it("underlines the name's own code points", () => {
    expect(matchPerson("Mary José", "jose")?.positions).toEqual([5, 6, 7, 8]);
    // A decomposed accent folds into its base letter.
    expect(matchPerson("Jose\u0301 Luis", "jose l")?.positions).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    // One ligature code point covers two typed letters.
    expect(matchPerson("ﬁona", "fio")?.positions).toEqual([0, 1]);
    expect(matchPerson("  Honey", "hon")?.positions).toEqual([2, 3, 4]);
  });

  it("normalizes the way it matches", () => {
    expect(normalizeName("  ÉLODIE ")).toBe("elodie");
    expect(foldName("José ")).toBe("jose ");
  });

  it("finds a longer name only when it continues with a new word", () => {
    expect(extendsName("José Luis", "jose")).toBe(true);
    expect(extendsName("Jose-Luis", "jose")).toBe(true);
    expect(extendsName("Jose\tLuis", "jose")).toBe(true);
    expect(extendsName("Josefa", "jose")).toBe(false);
    expect(extendsName("Jose", "jose")).toBe(false);
    expect(extendsName("Jose ", "jose")).toBe(false);
    expect(extendsName("Anything", "")).toBe(false);
  });
});
