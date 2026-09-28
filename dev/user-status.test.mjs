import { expect, it } from "vitest";
import { validStatusTemplate } from "./user-status.mjs";

const template = {
  kind: 30315,
  content: "",
  created_at: 1700000000,
  tags: [["d", "general"]],
};
it("admits clears, text-only, emoji-only, custom emoji and expiration", () => {
  for (const event of [
    template,
    { ...template, content: "Working remotely" },
    { ...template, tags: [...template.tags, ["emoji", "🏠"]] },
    {
      ...template,
      tags: [
        ...template.tags,
        ["emoji", ":party:"],
        ["expiration", "1700086400"],
      ],
    },
  ])
    expect(validStatusTemplate(event)).toBe(true);
});
it("rejects unrelated coordinates, duplicate tags, invalid times, channels and oversized values", () => {
  for (const patch of [
    { kind: 0 },
    { created_at: -1 },
    { created_at: 1.1 },
    { content: "x".repeat(101) },
    { tags: [] },
    { tags: [["d", "music"]] },
    { tags: [...template.tags, ["d", "general"]] },
    { tags: [...template.tags, ["h", "channel"]] },
    { tags: [...template.tags, ["emoji", "party", "https://wrong.test"]] },
    { tags: [...template.tags, ["expiration", "NaN"]] },
    { tags: [...template.tags, ["expiration", "1700086400"]] },
    { tags: [...template.tags, ["emoji", "x".repeat(101)]] },
  ])
    expect(validStatusTemplate({ ...template, ...patch })).toBe(false);
});

it("bounds future signing timestamps while allowing same-second replacements", () => {
  const now = 1700000000;
  expect(validStatusTemplate({ ...template, created_at: now + 300 }, now)).toBe(
    true,
  );
  expect(validStatusTemplate({ ...template, created_at: now + 301 }, now)).toBe(
    false,
  );
});
