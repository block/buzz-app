import { expect, it } from "vitest";
import { searchEmoji, searchCustomEmoji } from "./emoji-search";

it("searches native names, aliases and separator-insensitive shortcodes", async () => {
  expect((await searchEmoji("smile", []))[0]?.shortcode).toBe("smile");
  expect(
    (await searchEmoji("thumbsup", [])).some((item) => item.text === "👍"),
  ).toBe(true);
  expect(
    (await searchEmoji("pointup", [])).some(
      (item) => item.shortcode === "point_up",
    ),
  ).toBe(true);
});
it("keeps current custom catalogs separate and ranks exact shortcodes first", async () => {
  const a = [
    { shortcode: "smile", url: "https://a.test/a.png" },
    { shortcode: "bufo_smile", url: "https://a.test/b.png" },
  ];
  const b = [{ shortcode: "smile", url: "https://b.test/a.png" }];
  const [first, second] = await Promise.all([
    searchEmoji("smile", a),
    searchEmoji("smile", b),
  ]);
  expect(
    first
      .slice(0, 2)
      .map((item) => item.id)
      .sort(),
  ).toEqual(["custom/smile", "unicode/smile"]);
  expect(second.find((item) => item.id === "custom/smile")?.url).toBe(
    b[0]?.url,
  );
  expect(second.some((item) => item.url?.startsWith("https://a.test"))).toBe(
    false,
  );
  expect((await searchEmoji("smile", [])).every((item) => !item.url)).toBe(
    true,
  );
  expect(
    searchCustomEmoji("partyparrot", [
      { shortcode: "party-parrot", url: "https://a.test" },
    ])[0]?.text,
  ).toBe(":party-parrot:");
});
it("bounds results and treats empty queries as no intent", async () => {
  expect((await searchEmoji("a", [], 10000)).length).toBeLessThanOrEqual(50);
  expect(await searchEmoji("", [])).toEqual([]);
});
it("copies native primitives even when Mart previously mutated the shared dictionary", async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  const raw = (await import("@emoji-mart/data"))
    .default as unknown as import("@emoji-mart/data").EmojiMartData;
  const smile = raw.emojis.smile;
  if (!smile) throw new Error("Missing pinned fixture emoji");
  const originalName = smile.name;
  const originalKeywords = [...smile.keywords];
  const customId = "buzz-custom/other-community/alien";
  try {
    // Mart's custom entries have an image source, not a native Unicode skin.
    raw.emojis[customId] = {
      id: customId,
      name: "Other community alien",
      keywords: ["smile"],
      version: 1,
      skins: [{ unified: "", native: "" }],
    };
    const isolated = await import("./emoji-search");
    expect(
      (await isolated.searchEmoji("smile", [])).some((item) =>
        item.id.includes(customId),
      ),
    ).toBe(false);
    smile.name = "MUTATED PICKER RECORD";
    smile.keywords.push("contamination");
    expect(
      (await isolated.searchEmoji("smile", [])).find(
        (item) => item.shortcode === "smile",
      )?.name,
    ).toBe(originalName);
    expect(
      (await isolated.searchEmoji("contamination", [])).some(
        (item) => item.shortcode === "smile",
      ),
    ).toBe(false);
  } finally {
    smile.name = originalName;
    smile.keywords = originalKeywords;
    delete raw.emojis[customId];
  }
});
