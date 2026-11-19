import { describe, expect, it } from "vitest";
import { soundKey, soundsLike } from "./sounds-like";

describe("soundsLike", () => {
  it("links misheard words to names that sound like them", () => {
    expect(soundKey("colonel")).toBe(soundKey("kernel"));
    expect(soundsLike("take me to the colonel channel", "kernel")).toEqual([
      "colonel",
    ]);
    // Split words join up.
    expect(soundsLike("my chat with em bot", "mbot")).toEqual(["em bot"]);
    expect(soundsLike("salmon's search status", "Salman Mohammed")).toEqual([
      "salmon",
    ]);
  });

  it("gives no hint for names already said, filler or weak matches", () => {
    expect(soundsLike("go to buzz security", "buzz-security")).toEqual([]);
    expect(soundsLike("plug in market place", "plugin-marketplace")).toEqual(
      [],
    );
    // Two-consonant keys also need the same first vowel.
    expect(soundsLike("talk to tim", "team")).toEqual([]);
    // Letters said one by one are not heard as a word.
    expect(soundsLike("the market place", "buzz-github-prs")).toEqual([]);
    expect(soundsLike("the quarterly tax filing channel", "kernel")).toEqual(
      [],
    );
  });
});
