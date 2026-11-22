import { describe, expect, it } from "vitest";
import { heardAs, spokenForms } from "./heard-as";

describe("spokenForms", () => {
  it("splits hyphens and says digits", () => {
    expect(spokenForms("relay-perf")).toEqual([["relay", "perf"]]);
    expect(spokenForms("drone01")).toEqual([
      ["drone", "01"],
      ["drone", "one"],
      ["drone", "zero", "one"],
      ["drone", "oh", "one"],
    ]);
    expect(spokenForms("q4-planning")).toEqual([
      ["q", "4", "planning"],
      ["q", "four", "planning"],
    ]);
  });

  it("stays small for names with many numbers", () => {
    expect(spokenForms("v1.0.2-rc01-2026").length).toBeLessThanOrEqual(8);
  });
});

describe("heardAs", () => {
  it("finds a name said with its digits spoken", () => {
    expect(heardAs("send this to drone oh one", "drone01")).toContain(
      "drone oh one",
    );
    expect(heardAs("add drone 02 to this", "drone02")).toContain("drone 02");
    expect(heardAs("add drone two to wells", "drone02")).toContain("drone two");
    expect(heardAs("send this to drone oh one", "drone00")).toEqual([]);
  });

  it("finds a hyphenated name said as words, also when one is misheard", () => {
    expect(heardAs("open relay perf", "relay-perf")).toContain("relay perf");
    expect(
      heardAs("share this with the relay purr channel", "relay-perf"),
    ).toContain("relay purr");
  });

  it("finds a name spelled as said, but not a part of a longer name", () => {
    expect(heardAs("put this next to engineering", "engineering")).toEqual([
      "engineering",
    ]);
    expect(heardAs("take me to buzz", "buzz-security")).toEqual([]);
  });

  it("keeps what soundsLike hears", () => {
    expect(heardAs("take me to bus security", "buzz-security")).toContain(
      "bus security",
    );
  });
});
