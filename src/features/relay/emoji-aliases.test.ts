import { expect, it } from "vitest";
import {
  EMOJI_ALIAS_SET,
  parseEmojiAliasSet,
  prepareAliasMessage,
  prepareAliasReaction,
  resolveEmojiAliases,
} from "./emoji-aliases";
import { EMOJI_SET, emojiTags, validEmojiSetTemplate } from "./emoji";
import { groupReactions } from "./fold";
import { keypair, signed, type Key } from "./testing";

const alice = keypair(),
  bob = keypair();
const url = "https://media.test/party.png";
const custom = [{ shortcode: "party", url }];
function set(
  tags: string[][],
  author: Key = alice,
  created_at = 10,
  coordinate = EMOJI_ALIAS_SET,
) {
  return signed(author, {
    kind: 30030,
    content: "",
    created_at,
    tags: [["d", coordinate], ...tags],
  });
}
const native = (name = "project_small", value = "🌱") => [
  "alias",
  name,
  "unicode",
  value,
];
const linked = (
  name = "party_alias",
  author = alice.pubkey,
  target = "party",
) => ["alias", name, "custom", author, target];
const images = (author = alice, time = 10, targetUrl = url) =>
  set([["emoji", "party", targetUrl]], author, time, EMOJI_SET);
const definitions = set([native(), linked()]);

it("decodes Unicode and owner-bound custom targets without changing the legacy set format", () => {
  expect(parseEmojiAliasSet(definitions)).toEqual([
    { shortcode: "project_small", target: { kind: "unicode", value: "🌱" } },
    {
      shortcode: "party_alias",
      target: { kind: "custom", author: alice.pubkey, shortcode: "party" },
    },
  ]);
  expect(parseEmojiAliasSet(set([]))).toEqual([]);
  expect(validEmojiSetTemplate(definitions)).toBe(false);
  expect(parseEmojiAliasSet(images())).toBeUndefined();
  expect(emojiTags(definitions)).toEqual([]);
});

it.each(["🌱", "👍🏽", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣", "❤️"])(
  "accepts the picker sequence %s intact",
  (value) => {
    const aliases = resolveEmojiAliases([
      set([native("project_small", value)]),
    ]);
    expect(prepareAliasMessage(":project_small:", aliases, [])).toEqual({
      content: value,
      tags: [],
    });
  },
);

it.each([
  "",
  "hello",
  "🌱🌱",
  " 🌱",
  "🌱\n",
  "1",
  "A",
  "\u202e🌱",
  "🌱\u0301",
  "\ud800",
])("rejects non-picker Unicode sequences %j", (value) => {
  expect(
    parseEmojiAliasSet(set([native("project_small", value)])),
  ).toBeUndefined();
});

it("rejects malformed sets atomically, including duplicate names, aliases as targets and extra metadata", () => {
  for (const tags of [
    [native(), native()],
    [native("UPPER")],
    [native(":wrapped:")],
    [native("has space")],
    [native("a".repeat(65))],
    [["alias", "other", "alias", "project_small"]],
    [linked("other", "not-a-key")],
    [linked("other", alice.pubkey, ":party:")],
    [native(), ["p", bob.pubkey]],
    [[...native(), "extra"]],
    [["alias", "other", "custom", alice.pubkey]],
    Array.from({ length: 501 }, (_, i) => native(`alias_${i}`)),
  ])
    expect(parseEmojiAliasSet(set(tags))).toBeUndefined();
  for (const patch of [
    { content: "unexpected" },
    { kind: 7 },
    { created_at: -1 },
    { created_at: 0.5 },
    { tags: null },
    { tags: [["d", EMOJI_ALIAS_SET], null] },
    {
      tags: [
        ["d", EMOJI_ALIAS_SET],
        ["alias", "other", "unicode", 1],
      ],
    },
    { tags: [{ 0: "d", 1: EMOJI_ALIAS_SET, length: 2 }] },
  ])
    expect(parseEmojiAliasSet({ ...definitions, ...patch })).toBeUndefined();
  expect(parseEmojiAliasSet(null)).toBeUndefined();
  expect(parseEmojiAliasSet("bad")).toBeUndefined();
});

it("collapses author replacements before resolving, independent of delivery order", () => {
  const newer = set([native("project_small", "🌳")], alice, 11);
  for (const events of [
    [newer, definitions],
    [definitions, newer],
  ]) {
    const aliases = resolveEmojiAliases(events);
    expect(aliases).toHaveLength(1);
    expect(prepareAliasMessage(":project_small:", aliases, [])).toEqual({
      content: "🌳",
      tags: [],
    });
  }
  const empty = set([], alice, 12);
  expect(resolveEmojiAliases([empty, definitions])).toEqual([]);
  const invalid = set([native("BAD")], alice, 12);
  expect(resolveEmojiAliases([invalid, definitions])).toEqual([]);
  const tie = set([native("project_small", "🌳")]);
  const winner = definitions.id < tie.id ? definitions : tie;
  expect(resolveEmojiAliases([definitions, tie])).toEqual(
    resolveEmojiAliases([winner]),
  );
  expect(resolveEmojiAliases([tie, definitions])).toEqual(
    resolveEmojiAliases([winner]),
  );
});

it("surfaces competing authors and built-in/custom names without newest-wins retargeting", () => {
  const competitor = set([native()], bob, 99);
  const aliases = resolveEmojiAliases([definitions, competitor, images()]);
  expect(
    aliases
      .filter((entry) => entry.shortcode === "project_small")
      .map((entry) => entry.status),
  ).toEqual(["conflict", "conflict"]);
  expect(() => prepareAliasMessage(":project_small:", aliases, custom)).toThrow(
    /conflicting name/,
  );
  expect(() =>
    prepareAliasReaction(":project_small:", aliases, custom),
  ).toThrow(/conflicting name/);
  const collisions = resolveEmojiAliases([
    set([native("seedling"), native("+1"), native("party")]),
    images(),
  ]);
  // Invalid names reject their whole set; valid collisions remain visible as conflicts.
  expect(collisions).toEqual([]);
  expect(
    resolveEmojiAliases([
      set([native("seedling"), native("party")]),
      images(),
    ]).every((entry) => entry.status === "conflict"),
  ).toBe(true);
  expect(
    resolveEmojiAliases([
      definitions,
      competitor,
      set([], bob, 100),
      images(),
    ]).find((entry) => entry.shortcode === "project_small")?.status,
  ).toBe("ready");
});

it("does not let conflicting aliases disable existing custom or built-in shortcodes", () => {
  const aliases = resolveEmojiAliases([
    set([native("party"), native("seedling")]),
    images(),
  ]);
  expect(aliases.every((entry) => entry.status === "conflict")).toBe(true);
  expect(prepareAliasMessage(":party: :seedling:", aliases, custom)).toEqual({
    content: ":party: :seedling:",
    tags: [["emoji", "party", url]],
  });
  expect(prepareAliasReaction(":party:", aliases, custom)).toEqual({
    content: ":party:",
    tags: [["emoji", "party", url]],
  });
  expect(prepareAliasReaction(":seedling:", aliases, custom)).toEqual({
    content: ":seedling:",
    tags: [],
  });
});

it("pins a custom target's author and follows only that author's replacements", () => {
  const otherImage = images(bob, 100, "https://other.test/party.png");
  const first = resolveEmojiAliases([definitions, images(), otherImage]);
  expect(prepareAliasReaction(":party_alias:", first, custom)).toEqual({
    content: ":party:",
    tags: [["emoji", "party", url]],
  });
  const updated = resolveEmojiAliases([
    definitions,
    images(alice, 11, "ipfs://new-image"),
    images(),
    otherImage,
  ]);
  expect(prepareAliasReaction(":party_alias:", updated, custom).tags).toEqual([
    ["emoji", "party", "ipfs://new-image"],
  ]);
  const removed = resolveEmojiAliases([
    definitions,
    images(),
    set([], alice, 12, EMOJI_SET),
    otherImage,
  ]);
  expect(
    removed.find((entry) => entry.shortcode === "party_alias")?.status,
  ).toBe("missing-target");
  expect(() => prepareAliasMessage(":party_alias:", removed, [])).toThrow(
    /unavailable target/,
  );
  expect(() => prepareAliasReaction(":party_alias:", removed, [])).toThrow(
    /unavailable target/,
  );
});

it("resolves from the supplied community only and never treats another alias as a custom target", () => {
  const a = resolveEmojiAliases([set([native()])]);
  const b = resolveEmojiAliases([set([native("project_small", "🌳")])]);
  expect(prepareAliasMessage(":project_small:", a, []).content).toBe("🌱");
  expect(prepareAliasMessage(":project_small:", b, []).content).toBe("🌳");
  expect(prepareAliasMessage(":project_small:", [], []).content).toBe(
    ":project_small:",
  );
  const cycle = resolveEmojiAliases([
    set([
      linked("loop_a", alice.pubkey, "loop_b"),
      linked("loop_b", alice.pubkey, "loop_a"),
    ]),
  ]);
  expect(cycle.map((entry) => entry.status)).toEqual([
    "missing-target",
    "missing-target",
  ]);
});

it("preserves text boundaries, unknown names, links, case and event-local custom tags", () => {
  const aliases = resolveEmojiAliases([definitions, images()]);
  const content =
    ":unknown:project_small: :PARTY_ALIAS: :party_alias: :party: https://host.test/:project_small: http://host.test/:party_alias:";
  expect(prepareAliasMessage(content, aliases, custom)).toEqual({
    content:
      ":unknown🌱 :PARTY_ALIAS: :party_alias: :party: https://host.test/:project_small: http://host.test/:party_alias:",
    tags: [
      ["emoji", "party_alias", url],
      ["emoji", "party", url],
    ],
  });
  expect(
    prepareAliasMessage("🌱 plain text :unknown:", aliases, custom),
  ).toEqual({ content: "🌱 plain text :unknown:", tags: [] });
});

it("snapshots custom aliases under their own name so a namesake can have a different URL", () => {
  const aliases = resolveEmojiAliases([definitions, images()]);
  const prepared = prepareAliasMessage(":party_alias: :party:", aliases, [
    { shortcode: "party", url: "https://other.test/party.png" },
  ]);
  expect(prepared.tags).toEqual([
    ["emoji", "party_alias", url],
    ["emoji", "party", "https://other.test/party.png"],
  ]);
  const afterEdit = resolveEmojiAliases([
    set([native("party_alias", "🌳")], alice, 11),
  ]);
  expect(prepareAliasMessage(":party_alias:", afterEdit, []).content).toBe(
    "🌳",
  );
  expect(prepared.content).toBe(":party_alias: :party:");
  expect(prepared.tags[0]).toEqual(["emoji", "party_alias", url]);
});

it.each([
  [":project_small:", "🌱"],
  [":PARTY_ALIAS:", ":party:"],
])("folds alias %s and direct %s reactions into one group", (alias, target) => {
  const aliases = resolveEmojiAliases([definitions, images()]);
  const resolved = prepareAliasReaction(alias, aliases, custom);
  const direct = prepareAliasReaction(target, aliases, custom);
  expect(resolved).toEqual(direct);
  const reactions = [alice, bob].map((author, index) =>
    signed(author, {
      kind: 7,
      created_at: 30 + index,
      content: index ? direct.content : resolved.content,
      tags: [["e", "a".repeat(64)], ...(index ? direct.tags : resolved.tags)],
    }),
  );
  expect(groupReactions(reactions)).toMatchObject([
    {
      content: target,
      events: [{ authorId: alice.pubkey }, { authorId: bob.pubkey }],
    },
  ]);
});

it("keeps unknown reactions and literal text intact", () => {
  const aliases = resolveEmojiAliases([definitions, images()]);
  for (const content of [
    ":unknown:",
    "🌱",
    "not :project_small:",
    "https://host.test/:project_small:",
  ])
    expect(prepareAliasReaction(content, aliases, [])).toEqual({
      content,
      tags: [],
    });
});
