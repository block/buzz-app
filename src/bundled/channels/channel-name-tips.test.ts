import { describe, expect, it } from "vitest";
import { channelNameTips } from "./channel-name-tips";

const base = {
  name: "",
  temporary: false,
  description: "Questions for the payments team",
};

describe("channelNameTips", () => {
  it("is quiet for an empty name", () => {
    expect(channelNameTips(base)).toEqual({ tips: [], blockers: [] });
  });

  it("is quiet for a well-formed name", () => {
    const r = channelNameTips({ ...base, name: "payments-help" });
    expect(r.tips).toEqual([]);
    expect(r.blockers).toEqual([]);
  });

  it("suggests a type word when none is present", () => {
    const r = channelNameTips({ ...base, name: "payments" });
    expect(r.tips).toHaveLength(1);
    expect(r.blockers).toHaveLength(1);
  });

  it("suggests proj- first", () => {
    const r = channelNameTips({
      ...base,
      name: "food-proj-live-cart",
      temporary: true,
    });
    expect(r.tips.join(" ")).toMatch(/proj- comes first/);
  });

  it("hints at a ttl for tmp- and proj- channels without blocking", () => {
    const r = channelNameTips({ ...base, name: "proj-cart" });
    expect(r.tips.join(" ")).toMatch(/temporary lifetime/);
    expect(r.blockers).toEqual([]);
  });
});

describe("normalization and wording", () => {
  const check = (name: string) =>
    channelNameTips({ name, temporary: false, description: "x" }).blockers;
  it("requires lowercase kebab-case", () => {
    const fix = (name: string) => [
      `Use lowercase letters, numbers and single hyphens, like ${name}.`,
    ];
    expect(check("Payments-Team")).toEqual(fix("payments-team"));
    expect(check("payments_team")).toEqual(fix("payments-team"));
    expect(check("Payments Team")).toEqual(fix("payments-team"));
    expect(check("Proj-Foo")).toEqual(fix("proj-foo"));
    expect(check("payments-team")).toEqual([]);
    expect(check("foo-Proj-x")).toContain(
      "Move proj- to the start, like proj-checkout.",
    );
  });
  it("requires a topic alongside the type word", () => {
    expect(check("alerts")).not.toEqual([]);
  });
  it("points a mid-name type word to the end", () => {
    expect(check("team-payments")).toEqual([
      "Put the type word at the end, like payments-team.",
    ]);
  });
  it("blocks a bare proj, like a bare tmp", () => {
    expect(check("proj")).not.toEqual([]);
    expect(check("proj-")).not.toEqual([]);
  });
  it("requires single hyphens between lowercase words", () => {
    for (const name of [
      "payments--team",
      "-payments-team",
      "payments-team-",
      "proj--x",
      "proj-x-",
      "pay.ments-team",
      "pay/ments-team",
      "pay!ments-team",
      "💥-team",
    ])
      expect(check(name), name).toContainEqual(
        expect.stringMatching(/^Use lowercase letters/),
      );
  });
  it("suggests a tidy name without stray punctuation", () => {
    expect(check("Payments Team!")).toEqual([
      "Use lowercase letters, numbers and single hyphens, like payments-team.",
    ]);
  });
  it("accepts lowercase letters from any language, and digits", () => {
    for (const name of [
      "日本-team",
      "paymént-team",
      "ünï-help",
      "proj-2024",
      "123-team",
    ])
      expect(check(name), name).toEqual([]);
  });
  it("says to add a topic when only a type word is typed", () => {
    for (const name of ["proj", "tmp", "ext", "prod", "proj-", "tmp-"])
      expect(check(name).join(" "), name).toMatch(/Add a topic after/);
    for (const name of ["team", "plat", "alerts"])
      expect(check(name).join(" "), name).toMatch(/Add a topic before/);
  });
  it("accepts every type prefix and suffix with a topic", () => {
    for (const name of [
      "prod-api",
      "ext-vendor",
      "tmp-x",
      "cart-alerts",
      "cart-plat",
    ])
      expect(check(name), name).toEqual([]);
  });
  it("blocks a second proj- after the first word", () => {
    expect(check("x-proj")).toContain(
      "Move proj- to the start, like proj-checkout.",
    );
  });
});
