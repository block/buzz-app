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
