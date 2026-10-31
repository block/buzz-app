// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  admit,
  DEFAULT_RULES,
  loadPolicy,
  membershipQuery,
  open,
  organizations,
  parse,
  parseMembership,
  POLICY_KEY,
  savePolicy,
  unresolved,
  type AuthorPolicy,
} from "./authors";
import { GitHubError, type GitHubCli } from "./gh";
import { BODY_CHARS, type Feedback } from "./pull-states";

const rules = (text: string) => parse(text) as AuthorPolicy;
const by = (author: string, body = "", bot = false): Feedback => ({
  id: "comment/1",
  author,
  url: "",
  body,
  ...(bot ? { bot: true as const } : {}),
});
const nobody = () => false;

afterEach(() => localStorage.clear());

describe("GitHub author rules", () => {
  it("by default admit everyone but the viewer's 🤖 comments", () => {
    const policy = loadPolicy();
    expect(policy.text).toBe(DEFAULT_RULES);
    expect(open(policy)).toBe(true);
    expect(organizations(policy)).toEqual([]);
    expect(admit(by("stranger", "hi"), policy, "john", nobody)).toBe(true);
    expect(admit(by("John", "please fix"), policy, "john", nobody)).toBe(true);
    expect(admit(by("John", "  🤖 Fixed"), policy, "john", nobody)).toBe(false);
    // Only the viewer's own 🤖 comments are agents'.
    expect(admit(by("stranger", "🤖 hi"), policy, "john", nobody)).toBe(true);
    // A bot named like the viewer is not the viewer.
    expect(admit(by("john", "🤖", true), policy, "john", nobody)).toBe(true);
  });

  it("let the fallback decide what no rule matches, and a bare rule match everyone", () => {
    expect(loadPolicy().fallback).toBe("allow");
    const closed = rules("allow author:wes");
    expect(closed.fallback).toBe("deny");
    expect(open(closed)).toBe(false);
    expect(admit(by("stranger"), closed, "john", nobody)).toBe(false);
    const opened = parse("allow author:wes", "allow") as AuthorPolicy;
    expect(open(opened)).toBe(true);
    expect(admit(by("stranger"), opened, "john", nobody)).toBe(true);
    expect(admit(by("wes"), opened, "john", nobody)).toBe(true);
    const deny = parse("allow author:wes\ndeny", "allow") as AuthorPolicy;
    expect(admit(by("wes"), deny, "john", nobody)).toBe(true);
    expect(admit(by("stranger"), deny, "john", nobody)).toBe(false);
    expect(savePolicy("allow author:wes", "allow")).toEqual(opened);
    expect(loadPolicy()).toEqual(opened);
    // Rules saved before the fallback existed keep denying what none match.
    localStorage.setItem(POLICY_KEY, '{"version":2,"text":"allow author:wes"}');
    expect(loadPolicy()).toEqual(closed);
  });

  it("let the first matching rule decide, and deny what none match", () => {
    const policy = rules(`deny author:Noisy
allow org:block
allow author:Wes
allow author:copilot-pull-request-reviewer[bot]`);
    expect(open(policy)).toBe(false);
    expect(organizations(policy)).toEqual(["block"]);
    const member = (login: string, org: string) =>
      org === "block" && (login === "alice" || login === "noisy");
    expect(admit(by("wes"), policy, "john", member)).toBe(true);
    expect(admit(by("alice"), policy, "john", member)).toBe(true);
    expect(admit(by("noisy"), policy, "john", member)).toBe(false);
    expect(admit(by("stranger"), policy, "john", member)).toBe(false);
    expect(admit(by("john"), policy, "john", member)).toBe(false);
    // A bot's login ends in [bot], and it is in no organization.
    expect(
      admit(
        by("copilot-pull-request-reviewer", "", true),
        policy,
        "john",
        member,
      ),
    ).toBe(true);
    expect(admit(by("alice", "", true), policy, "john", member)).toBe(false);
    expect(admit(by("ghost"), policy, "john", () => true)).toBe(false);
    // Membership not yet known holds the verdict, unless an earlier rule decides.
    expect(admit(by("bob"), policy, "john", () => undefined)).toBeUndefined();
    expect(
      admit(
        by("wes"),
        rules("allow author:wes\nallow org:block"),
        "john",
        () => undefined,
      ),
    ).toBe(true);
  });

  it("match authors and bodies by pattern, logins case aside", () => {
    const policy = rules(`deny body:/^\\s*LGTM\\b/i
allow author:/^(copilot|dependabot)\\b/
allow author:/^ADA_/ prefix:Review: please
deny body:/a b\\/c/
allow org:Block body:/bug/s`);
    expect(admit(by("Copilot-x", "", true), policy, "j", nobody)).toBe(true);
    expect(admit(by("dependabot", "", true), policy, "j", nobody)).toBe(true);
    expect(
      admit(by("ada_block", "Review: please look"), policy, "j", nobody),
    ).toBe(true);
    expect(admit(by("ada_block", "Review: later"), policy, "j", nobody)).toBe(
      false,
    );
    expect(admit(by("copilot", " lgtm"), policy, "j", nobody)).toBe(false);
    expect(admit(by("eve", "a b/c bug"), policy, "j", () => true)).toBe(false);
    const member = (_: string, org: string) => org === "block";
    expect(admit(by("eve", "a\nbug"), policy, "j", member)).toBe(true);
    expect(admit(by("eve", "fine"), policy, "j", member)).toBe(false);
    expect(organizations(policy)).toEqual(["block"]);
  });

  it("match bodies only as far as a wake quotes them", () => {
    const policy = rules("allow body:/approved$/\ndeny");
    const body = `${"x".repeat(999)}approved`;
    expect(admit(by("eve", body), policy, "j", nobody)).toBe(false);
    expect(admit(by("eve", body.slice(9)), policy, "j", nobody)).toBe(true);
  });

  it("match a hostile pattern in time the text's length bounds", () => {
    const policy = rules("deny body:/^(a+)+$/\nallow author:/^(\\w+)*$/");
    const started = performance.now();
    for (const length of [25, BODY_CHARS - 1])
      expect(
        admit(
          by(`${"a".repeat(length)}-`, `${"a".repeat(length)}!`),
          policy,
          "j",
          nobody,
        ),
      ).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("hold all feedback while saved rules no longer parse, keeping them", () => {
    // An earlier build ran patterns natively, so it saved lookaround.
    const text = "allow author:/^(?!eve$)[a-z]+$/";
    localStorage.setItem(
      POLICY_KEY,
      JSON.stringify({ version: 2, text, fallback: "deny" }),
    );
    const policy = loadPolicy();
    expect(policy.text).toBe(text);
    expect(policy.error).toContain("Line 1: a pattern's groups can only be");
    expect(open(policy)).toBe(false);
    expect(organizations(policy)).toEqual([]);
    expect(admit(by("eve"), policy, "j", nobody)).toBeUndefined();
    expect(admit(by("wes"), policy, "j", nobody)).toBeUndefined();
  });

  it("match a legacy octal escape as the one character it is", () => {
    const policy = rules("deny body:/\\012/\nallow");
    expect(admit(by("eve", "first\nsecond"), policy, "j", nobody)).toBe(false);
    expect(admit(by("eve", "\u000012"), policy, "j", nobody)).toBe(true);
  });

  it("refuse an escape whose meaning alone differs from JavaScript's", () => {
    // JavaScript reads \c as a backslash and c, and \U0041 as U0041.
    for (const [source, text] of [
      ["\\c", "\\c"],
      ["\\c1", "\\c1"],
      ["\\U0041", "U0041"],
      ["\\X41", "X41"],
    ] as const) {
      expect(new RegExp(source).test(text)).toBe(true);
      expect(parse(`deny body:/${source}/\nallow`)).toBe(
        `Line 1: a pattern cannot use the escape ${source.slice(0, 2)}`,
      );
    }
    const policy = rules("deny body:/\\x4A\\cJ/\nallow");
    expect(admit(by("eve", "J\n"), policy, "j", nobody)).toBe(false);
    expect(admit(by("eve", "x4AcJ"), policy, "j", nobody)).toBe(true);
  });

  it("name the line that is not a rule", () => {
    const errors = {
      "allow\nwho knows": "Line 2: it must start with allow or deny",
      "allow\n\n  allow login:wes":
        "Line 3: login:wes is not author:, org:, prefix: or body:",
      "allow author:two words":
        "Line 1: words is not author:, org:, prefix: or body:",
      "deny author:a author:b": "Line 1: it has two author: conditions",
      "allow org:bot[bot]":
        "Line 1: bot[bot] is not a GitHub organization login",
      "allow org:/block/": "Line 1: org: takes an organization's exact name",
      "allow author:wes!":
        "Line 1: wes! is not a GitHub login, @me or /pattern/",
      "allow author:/(/": "Line 1: Invalid regular expression",
      "allow author:/a/g": "Line 1: /a/g may only use the flags i, m, s and u",
      "allow body:/a/ii": "Line 1: /a/ii may only use the flags i, m, s and u",
      "allow body:/unclosed": "Line 1: body: needs a /pattern/",
      "allow body:text": "Line 1: body: needs a /pattern/",
      "allow prefix:": "Line 1: prefix: needs text",
      "allow body:/(a)\\1/": "Line 1: a pattern cannot use backreferences",
      "allow body:/(?=a)/": "Line 1: a pattern's groups can only be",
      "allow author:/a{2000}/": "Line 1: a pattern this long or repetitive",
      // GitHub could not be asked about even one commenter.
      [Array.from(
        { length: 120 },
        (_, index) => `allow org:organization-${index}`,
      ).join("\n")]:
        "the rules name too many organizations to ask GitHub about",
    };
    for (const [text, error] of Object.entries(errors)) {
      expect(parse(text)).toContain(error);
      expect(() => savePolicy(text)).toThrow(error);
    }
    expect(localStorage.getItem(POLICY_KEY)).toBeNull();
  });

  it("save and load rules, reading anything unreadable as the defaults", () => {
    const saved = savePolicy(
      "  allow author:Dependabot[BOT]\n\n allow org:block  ",
    );
    expect(saved.text).toBe("allow author:Dependabot[BOT]\nallow org:block");
    expect(loadPolicy()).toEqual(saved);
    expect(admit(by("dependabot", "", true), loadPolicy(), "j", nobody)).toBe(
      true,
    );
    localStorage.setItem(POLICY_KEY, "{");
    expect(loadPolicy().text).toBe(DEFAULT_RULES);
  });

  it("ask which organizations each author is in, and read the answer", () => {
    expect(membershipQuery(["alice", "bob"], ["block", "squareup"])).toContain(
      'u1:user(login:"bob"){o0:organization(login:"block"){id} o1:organization(login:"squareup"){id}}',
    );
    const answer = {
      u0: { o0: null, o1: { id: "O" } },
      u1: { o0: null, o1: null },
    };
    expect(
      parseMembership(answer, ["Alice", "bob"], ["block", "SquareUp"]),
    ).toEqual(
      new Map([
        ["alice", new Set(["squareup"])],
        ["bob", new Set()],
      ]),
    );
    expect(parseMembership(null, ["alice"], ["block"])).toBeUndefined();
  });
});

describe("names GitHub cannot resolve", () => {
  it("warns about missing organizations and users, and organizations whose private members the viewer cannot see", async () => {
    const queries: string[] = [];
    const gh = (async (query: string) => {
      queries.push(query);
      throw new GitHubError(
        "Could not resolve to an Organization with the login of 'nope'.",
        "NOT_FOUND",
        {
          o0: { viewerIsAMember: true },
          o1: { viewerIsAMember: false },
          o2: null,
          u0: { id: "U_1" },
          u1: null,
        },
      );
    }) as GitHubCli;
    const policy = rules(
      "allow org:Block\nallow org:aaif-goose\nallow org:nope\nallow author:jbg\nallow author:dependabot\nallow author:JBG\nallow author:@me\nallow author:codex[bot]\nallow author:/^x$/",
    );
    expect(await unresolved(policy, gh)).toEqual([
      "org:aaif-goose: you are not a member of aaif-goose, so only its public members match",
      "org:nope: GitHub has no organization nope, so it matches no one",
      "author:dependabot: GitHub has no user dependabot; a bot's login ends in [bot]",
    ]);
    expect(queries).toEqual([
      'query{o0:organization(login:"block"){viewerIsAMember} o1:organization(login:"aaif-goose"){viewerIsAMember} o2:organization(login:"nope"){viewerIsAMember} u0:user(login:"jbg"){id} u1:user(login:"dependabot"){id}}',
    ]);
  });

  it("says the names went unchecked when GitHub cannot answer, and asks nothing without names", async () => {
    let asked = 0;
    const failing = (async () => {
      asked++;
      throw new GitHubError("API rate limit exceeded", "RATE_LIMITED", {
        o0: null,
      });
    }) as GitHubCli;
    expect(await unresolved(rules("allow org:block"), failing)).toEqual([
      "GitHub could not be asked about the names in these rules: API rate limit exceeded",
    ]);
    expect(await unresolved(rules("allow org:block"), undefined)).toEqual([
      "GitHub could not be asked about the names in these rules: gh is unavailable here",
    ]);
    expect(
      await unresolved(rules(`${DEFAULT_RULES}\nallow author:/^x$/`), failing),
    ).toEqual([]);
    expect(asked).toBe(1);
  });
});
