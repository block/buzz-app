import { expect, it } from "vitest";
import { editAgentRoute } from "./edit-route";

const pubkey = "a".repeat(64);
it("accepts only the exact lowercase agent identity route", () => {
  expect(editAgentRoute({ pubkey })).toBe(pubkey);
  for (const params of [
    null,
    [],
    {},
    { pubkey: pubkey.toUpperCase() },
    { pubkey, action: "save" },
    { pubkey: "not-a-key" },
    { id: pubkey },
  ]) {
    expect(editAgentRoute(params)).toBeNull();
  }
});
