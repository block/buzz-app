import { expect, it, vi } from "vitest";
import { dmLabel } from "./dm-label";
import { publicKeyLabels } from "../../shared/identity/public-key";

it("keeps roster identity order, bounded labels, and the full namesake comparison set", () => {
  const keys = ["a", "b", "c", "d"].map((c) => c.repeat(64));
  const profiles = new Map(keys.map((key) => [key, { name: "Same" }]));
  const suffix = publicKeyLabels(keys);
  const resolve = vi.fn(
    (key: string, fallback: string) => `${fallback} · ${suffix.get(key)}`,
  );
  expect(dmLabel(keys, profiles, resolve)).toBe(
    `${keys
      .slice(0, 3)
      .map((key) => `Same · ${suffix.get(key)}`)
      .join(", ")} +1`,
  );
  expect(resolve).toHaveBeenCalledTimes(3);
  for (const key of keys.slice(0, 3))
    expect(resolve).toHaveBeenCalledWith(key, "Same", keys);
});
it("preserves missing-roster versus self-DM fallback and uses public labels for unnamed participants", () => {
  const key = "a".repeat(64),
    names = new Map();
  const resolve = (_key: string, fallback: string) => fallback;
  expect(dmLabel(undefined, names, resolve, "Room name")).toBe("Room name");
  expect(dmLabel([], names, resolve, "Room name")).toBe("Notes to self");
  expect(dmLabel(undefined, names, resolve)).toBe("Notes to self");
  expect(dmLabel([key], names, resolve)).toBe(publicKeyLabels([key]).get(key));
});
