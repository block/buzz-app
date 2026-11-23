import { describe, expect, it } from "vitest";
import {
  landingInfo,
  landingTags,
  normalizeWelcome,
  validWelcomeCommand,
  validWelcomeTitleCommand,
  welcomeTextProblem,
  welcomeTitleProblem,
} from "./landing";

describe("landingTags", () => {
  it("reads the bare designation and its custom message and title", () => {
    expect(landingTags([["d", "x"]])).toEqual({});
    expect(landingTags([["landing"]])).toEqual({ landing: true });
    expect(landingTags([["landing"], ["welcome", "Hi\nall"]])).toEqual({
      landing: true,
      welcome: "Hi\nall",
    });
    expect(
      landingTags([
        ["landing"],
        ["welcome", "# Hi\n\n\t**all**"],
        ["welcome_title", "Hello, Acme"],
      ]),
    ).toEqual({
      landing: true,
      welcome: "# Hi\n\n\t**all**",
      welcomeTitle: "Hello, Acme",
    });
    // Each part is customized on its own.
    expect(landingTags([["landing"], ["welcome_title", "Hello"]])).toEqual({
      landing: true,
      welcomeTitle: "Hello",
    });
  });

  it("ignores a message or title without the designation", () => {
    // A stale tag can survive on the previous welcome channel.
    expect(
      landingTags([
        ["welcome", "Old"],
        ["welcome_title", "Old"],
      ]),
    ).toEqual({});
  });

  it("falls back to the default for a blank, repeated or invalid message or title", () => {
    for (const tags of [
      [["landing"], ["welcome", ""]],
      [["landing"], ["welcome", "  "]],
      [["landing"], ["welcome"]],
      [["landing"], ["welcome", "a"], ["welcome", "b"]],
      [["landing"], ["welcome", "cr\rhere"]],
      [["landing"], ["welcome_title", ""]],
      [["landing"], ["welcome_title", " "]],
      [["landing"], ["welcome_title", "two\nlines"]],
      [["landing"], ["welcome_title", "a"], ["welcome_title", "b"]],
    ])
      expect(landingTags(tags)).toEqual({ landing: true });
  });
});

describe("welcome text", () => {
  it("normalizes line endings and trims before sending", () => {
    expect(normalizeWelcome("  Hi\r\nall\rthere \n")).toBe("Hi\nall\nthere");
  });

  it("mirrors the relay's limits in Unicode scalar values", () => {
    expect(welcomeTextProblem("é".repeat(4000))).toBeUndefined();
    // Surrogate pairs count once, as Rust `chars()` does.
    expect(welcomeTextProblem("😀".repeat(4000))).toBeUndefined();
    expect(welcomeTextProblem("a".repeat(4001))).toBe("long");
    expect(welcomeTextProblem(" \n ")).toBe("empty");
    expect(welcomeTextProblem("\u2003\u3000")).toBe("empty");
    // Markdown needs line breaks and tabs for structure and code.
    expect(welcomeTextProblem("line\nbreak")).toBeUndefined();
    expect(welcomeTextProblem("- item\n\t- nested")).toBeUndefined();
    for (const text of [
      "cr\r",
      "nul\u0000",
      "vt\u000b",
      "del\u007f",
      "c1\u0085",
    ])
      expect(welcomeTextProblem(text)).toBe("control");
  });

  it("admits the empty default marker only as a command", () => {
    expect(validWelcomeCommand("")).toBe(true);
    expect(validWelcomeCommand("Hello")).toBe(true);
    expect(validWelcomeCommand(" ")).toBe(false);
  });
});

describe("welcome title", () => {
  it("mirrors the relay's one-line limits in Unicode scalar values", () => {
    expect(welcomeTitleProblem("é".repeat(120))).toBeUndefined();
    expect(welcomeTitleProblem("😀".repeat(120))).toBeUndefined();
    expect(welcomeTitleProblem("a".repeat(121))).toBe("long");
    expect(welcomeTitleProblem(" ")).toBe("empty");
    for (const text of [
      "two\nlines",
      "tab\t",
      "cr\r",
      "del\u007f",
      "c1\u0085",
      "line\u2028sep",
      "para\u2029sep",
    ])
      expect(welcomeTitleProblem(text)).toBe("control");
    // The message rejects neither separator; only the title is one line.
    expect(welcomeTextProblem("line\u2028sep")).toBeUndefined();
  });

  it("admits the empty default marker only as a command", () => {
    expect(validWelcomeTitleCommand("")).toBe(true);
    expect(validWelcomeTitleCommand("Hello")).toBe(true);
    expect(validWelcomeTitleCommand(" ")).toBe(false);
  });
});

describe("welcome blank and direction rules", () => {
  it("counts text of only whitespace and invisible characters as blank, as the relay does", () => {
    for (const text of [
      "\u200B",
      "\u2800",
      " \u200B ",
      "\uFEFF",
      "\u00AD\u034F\u115F\u1160\u3164\uFFA0",
      "\u180B\u2060\u206F\uFE00\uFE0F\uFFF9",
      "\u{1D173}\u{E0000}\u{E007F}",
      "\u{1BCA0}\u{1BCA3}\u{E0100}\u{E01EF}",
    ]) {
      expect(welcomeTextProblem(text)).toBe("empty");
      expect(welcomeTitleProblem(text)).toBe("empty");
    }
    // Blank is checked first, so only direction marks are still empty.
    expect(welcomeTextProblem("\u200E\u200F")).toBe("empty");
    // Invisible characters beside visible text are kept.
    expect(welcomeTextProblem("Hello\u200Bworld")).toBeUndefined();
    expect(welcomeTitleProblem("Hello\u200Bworld")).toBeUndefined();
  });

  it("refuses text-direction characters anywhere, before the length", () => {
    for (const mark of [
      "\u061C",
      "\u200E",
      "\u200F",
      "\u202A",
      "\u202E",
      "\u2066",
      "\u2069",
    ]) {
      expect(welcomeTextProblem(`${mark}abc`)).toBe("bidi");
      expect(welcomeTitleProblem(`a${mark}bc`)).toBe("bidi");
    }
    expect(welcomeTextProblem(`\u202E${"a".repeat(4001)}`)).toBe("bidi");
    expect(validWelcomeCommand("\u202Eabc")).toBe(false);
    expect(validWelcomeTitleCommand("\u202Eabc")).toBe(false);
    // A published value the relay would refuse shows the default.
    expect(
      landingTags([
        ["landing"],
        ["welcome", "\u202Eabc"],
        ["welcome_title", "\u200B"],
      ]),
    ).toEqual({ landing: true });
  });
});

describe("landingInfo", () => {
  const id = "6f1c2a4e-0b7d-4c1e-9a52-2f0d8b3c7e11";

  it("reads support and the designated channel from NIP-11", () => {
    expect(
      landingInfo({
        supported_extensions: ["buzz-gif", "buzz-landing-channel"],
        landing_channel: id,
      }),
    ).toEqual({ landingChannels: true, landingChannel: id });
    expect(
      landingInfo({ supported_extensions: ["buzz-landing-channel"] }),
    ).toEqual({ landingChannels: true });
  });

  it("ignores a designation from a relay without the extension", () => {
    expect(landingInfo({ landing_channel: id })).toEqual({
      landingChannels: false,
    });
    expect(landingInfo(undefined)).toEqual({ landingChannels: false });
  });

  it("ignores a malformed designation", () => {
    for (const landing_channel of [id.toUpperCase(), "", null, 1, "general"])
      expect(
        landingInfo({
          supported_extensions: ["buzz-landing-channel"],
          landing_channel,
        }),
      ).toEqual({ landingChannels: true });
  });
});
