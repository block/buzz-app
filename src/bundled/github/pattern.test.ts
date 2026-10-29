import { describe, expect, it } from "vitest";
import { Pattern } from "./pattern";

describe("Pattern", () => {
  it("matches what JavaScript's own regular expressions match", () => {
    const patterns: [string, string][] = [
      ["^\\s*LGTM\\b", "i"],
      ["^(copilot|dependabot)\\b", "i"],
      ["a b\\/c", ""],
      ["approved$", ""],
      ["^line$", "m"],
      ["a.b", "s"],
      ["a.b", ""],
      ["[^a-c]x", ""],
      ["[A-Z]{2,3}\\d+", "i"],
      ["(?:ab)*c", ""],
      ["(?<w>x|y)+z", ""],
      ["colou?r", ""],
      ["\\Bend", ""],
      ["^$", ""],
      ["\\u{1F600}", "u"],
      ["\\uD83E\\uDD16", "u"],
      ["^\\uD83D\\uDE00$", "u"],
      ["\\uD83D\\uDE00", ""],
      ["^.$", "u"],
      ["^..$", ""],
      ["x{2}", ""],
      ["^(a|)+b", ""],
      ["^(a*)*b$", ""],
      ["\\x41\\u0042", "i"],
      ["[\\]\\\\]", ""],
      ["a|b|c", ""],
      ["\\.\\*", ""],
      ["^\\w+@\\w+$", ""],
      ["^(a+)+$", ""],
    ];
    const texts = [
      "",
      "LGTM",
      "  lgtm now",
      "Copilot-x",
      "dependabotx",
      "a b/c",
      "approved",
      "not approved yet",
      "x\nline\ny",
      "a\nb",
      "axb",
      "dx",
      "AB12",
      "ababc",
      "xyz",
      "color",
      "colour",
      "backend",
      "end",
      "😀",
      "🤖 Fixed",
      "ab😀",
      "aab",
      "b",
      "]",
      "\\",
      ".*",
      "me@host",
      "aaaa",
      "aaa!",
    ];
    for (const [source, flags] of patterns) {
      const pattern = new Pattern(source, flags);
      const native = new RegExp(source, flags);
      for (const text of texts)
        expect([source, flags, text, pattern.test(text)]).toEqual([
          source,
          flags,
          text,
          native.test(text),
        ]);
    }
  });
});
