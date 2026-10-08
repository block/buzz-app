import { describe, expect, it } from "vitest";
import { prepareMarkdown } from "../markdown-preparation";
import { markdownParagraphs, plainParagraphs } from "./prose";

// The fast path must never disagree with the parse: it either declines
// (the parse runs) or returns exactly the parse's paragraphs.
const agrees = (content: string) => {
  const plain = plainParagraphs(content);
  if (plain) expect(plain).toEqual(markdownParagraphs(content));
  return plain;
};

describe("plainParagraphs", () => {
  it.each([
    ["setext heading", "Title\n==="],
    ["setext heading", "Title\n---"],
    ["thematic break", "***"],
    ["thematic break", "---"],
    ["thematic break", "- - -"],
    ["thematic break", "___"],
    ["indented code", "    code"],
    ["tab indent", "\tcode"],
    ["indented continuation", "first\n    second"],
    ["ordered list", "1. item"],
    ["ordered list", "intro\n1) item"],
    ["unordered list", "- item"],
    ["unordered list", "+ item"],
    ["unordered list", "* item"],
    ["block quote", "> quote"],
    ["block quote", "intro\n> quote"],
    ["fence", "```\ncode\n```"],
    ["fence", "~~~\ncode\n~~~"],
    ["hard break", "line  \nnext"],
    ["trailing space", "line \nnext"],
    ["backslash escape", "a \\* b"],
    ["backslash hard break", "line\\\nnext"],
    ["entity", "a &amp; b"],
    ["numeric entity", "&#35; not a heading"],
    ["autolink", "<https://x.test>"],
    ["literal autolink", "see http://x.test now"],
    ["www autolink", "see www.example.com"],
    ["www autolink", "see WWW.example.com"],
    ["email autolink", "mail me@example.com"],
    ["emphasis", "an *emphasised* word"],
    ["emphasis", "an _emphasised_ word"],
    ["strikethrough", "a ~~struck~~ word"],
    ["code", "some `code` here"],
    ["brackets", "a [reference] here"],
    ["link", "[a](b)"],
    ["image", "![alt](b)"],
    ["footnote", "text[^1]"],
    ["angle brackets", "<b>x</b>"],
    ["angle brackets", "a < b"],
    ["table pipes", "a | b\n--|--\n1 | 2"],
    ["spoiler pipes", "a ||secret|| b"],
    ["heading", "# heading"],
    ["channel reference", "see #general"],
    ["leading space", " leading"],
    ["unicode edge space", "text "],
    ["control", "bell\u0007"],
  ])("leaves %s to the parse: %j", (_, content) => {
    expect(agrees(content)).toBeUndefined();
  });

  it.each([
    "Short.",
    "First line\nsecond line",
    "One paragraph\n\nanother\n\n\nand a third",
    "\nleading and trailing blank lines\n",
    "a - b + c = 2+2 (fine) 1st 2nd: yes! no? 50% $5 ^^",
    "Mr. Smith arrived at 9.30, then left.",
    "C++ and Rust are languages",
    "Привет мир, 日本語のテキスト, مرحبا بالعالم",
    "non breaking inside",
  ])("returns the parse's paragraphs without parsing: %j", (content) => {
    expect(agrees(content)).toBeDefined();
  });

  it("agrees with the parse wherever it applies, over generated content", () => {
    const pieces = [
      "a",
      "bc",
      " ",
      "  ",
      "\n",
      "\n\n",
      "-",
      "+",
      "=",
      "1",
      ".",
      ")",
      "(",
      "*",
      "_",
      "~",
      "`",
      "[",
      "]",
      "!",
      "<",
      ">",
      "#",
      "|",
      "\\",
      "&",
      "amp;",
      "@",
      ":",
      "/",
      "www.",
      "http",
      "\t",
      "    ",
      " ",
      "　",
      "é",
      "日",
      "'",
      '"',
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let accepted = 0;
    for (let sample = 0; sample < 6000; sample++) {
      const length = 1 + Math.floor(random() * 12);
      let content = "";
      for (let index = 0; index < length; index++)
        content += pieces[Math.floor(random() * pieces.length)];
      if (agrees(content)) accepted++;
    }
    // Not vacuous: plenty of generated content takes the fast path.
    expect(accepted).toBeGreaterThan(300);
  });
});

it("leaves content nested past the renderer's depth bound to measurement", () => {
  let content = "";
  for (let depth = 0; depth < 101; depth++)
    content += depth % 2 ? "_w " : "*w ";
  content += "x";
  for (let depth = 100; depth >= 0; depth--) content += depth % 2 ? "_" : "*";
  expect(prepareMarkdown(content).kind).toBe("plain");
  expect(markdownParagraphs(content)).toBe("plain-text");
});
