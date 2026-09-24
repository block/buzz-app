import { expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import {
  exactMention,
  rankMentions,
  mentionMatch,
  type MentionChoice,
} from "./mention-ranking";
const choice = (
  key: string,
  name: string,
  extra: Partial<MentionChoice> = {},
): MentionChoice => ({
  recipient: { pubkey: key.repeat(64), name },
  label: name,
  aliases: [name],
  member: true,
  agent: false,
  managed: false,
  owned: false,
  ...extra,
});
it("groups before relevance, then exact/prefix/word/word-prefix with deterministic ties", () => {
  const rows = [
    choice("a", "A Honey"),
    choice("b", "Honey Bee"),
    choice("c", "Honey"),
    choice("d", "Honey", { member: false, agent: true }),
    choice("e", "A Honeybee"),
  ];
  expect(rankMentions(rows, "honey").map((c) => c.recipient.pubkey[0])).toEqual(
    ["c", "b", "a", "e", "d"],
  );
  expect(mentionMatch(choice("a", "A Honey"), "oney")).toBe(Infinity);
});
it("ranks resolved label matches before base names and aliases", () => {
  const other = choice("a", "Honey", {
    label: "Wes’s Honey",
    aliases: ["Honey", "Legacy Bee"],
    agent: true,
  });
  const mine = choice("b", "Honey", { agent: true, managed: true });
  expect(rankMentions([other, mine], "Honey")[0]).toBe(mine);
  expect(rankMentions([other, mine], "Wes’s")).toEqual([other]);
  expect(rankMentions([other, mine], "Legacy")).toEqual([other]);
  expect(mentionMatch(other, "Honey")).toBe(2);
  const visible = choice("c", "Another name", { label: "Visible Legacy Bee" });
  expect(rankMentions([other, visible], "Legacy")).toEqual([visible, other]);
  expect(rankMentions([other, visible], "Legacy Bee")).toEqual([other]);
  const qualified = choice("d", "Rizz", {
    label: "tho’s Rizz",
    agent: true,
    owned: true,
  });
  const displayed = choice("e", "Rizz", { agent: true });
  expect(rankMentions([qualified, displayed], "riz")).toEqual([
    displayed,
    qualified,
  ]);
});
it("history only breaks equally matched same-name agent ties, followed by managed and presence", () => {
  const a = choice("a", "Honey", { agent: true }),
    b = choice("b", "Honey", { agent: true, managed: true });
  expect(
    rankMentions([a, b], "Honey", new Map([[a.recipient.pubkey, 1]])),
  ).toEqual([a, b]);
  const prefix = choice("c", "Honey Bee", { agent: true });
  expect(
    rankMentions(
      [a, prefix],
      "Honey",
      new Map([[prefix.recipient.pubkey, 100]]),
    ),
  ).toEqual([a, prefix]);
  expect(
    rankMentions([a, { ...b, managed: false }], "Honey", undefined, (k) =>
      k === b.recipient.pubkey ? "online" : "away",
    )[0]?.recipient.pubkey,
  ).toBe(b.recipient.pubkey);
});
it("Space requires a unique exact full-set match, not a rank winner or short-name prefix", () => {
  const a = choice("a", "Honey"),
    b = choice("b", "Honey", { label: "Wes’s Honey" });
  expect(exactMention([a], "HONEY")).toBe(a.recipient.pubkey);
  expect(exactMention([a], "Hon")).toBeUndefined();
  expect(exactMention([a, b], "Honey")).toBeUndefined();
  expect(exactMention([a, b], "Wes’s Honey")).toBe(b.recipient.pubkey);
  expect(exactMention([a, choice("c", "Honey Bee")], "Honey")).toBeUndefined();
});

it("prefers owned agents on equal matches before history, management and presence, not membership or relevance", () => {
  const other = choice("a", "Rizz", { agent: true, managed: true });
  const mine = choice("b", "Rizz", { agent: true, owned: true });
  const history = new Map([[other.recipient.pubkey, 10]]);
  const presence = (key: string) =>
    key === other.recipient.pubkey ? "online" : "unknown";
  expect(rankMentions([other, mine], "riz", history, presence)).toEqual([
    mine,
    other,
  ]);
  expect(rankMentions([other, { ...mine, member: false }], "riz")[0]).toBe(
    other,
  );
  expect(
    rankMentions(
      [other, choice("c", "Rizz Helper", { agent: true, owned: true })],
      "Rizz",
    )[0],
  ).toBe(other);
  const differentName = choice("c", "Rizz Helper", {
    agent: true,
    owned: true,
  });
  expect(rankMentions([other, differentName], "riz")).toEqual([
    differentName,
    other,
  ]);
  expect(exactMention([other, mine], "Rizz")).toBeUndefined();
});

it("breaks visible match ties by base-name quality, then the full displayed label", () => {
  const rows = [
    choice("3", "Fast Fizz", { agent: true }),
    choice("0", "Fizz", { agent: true, label: "baxen’s Fizz · oncp" }),
    choice("4", "Fizz", { agent: true, label: "baxen’s Fizz · s03j" }),
    choice("5", "Fizz", { agent: true, label: "Kenny Lopez’s Fizz" }),
    choice("b", "Fizz", { agent: true, label: "baxen’s Fizz · 4prr" }),
    choice("c", "Fizz", { agent: true, label: "baxen’s Fizz · 06pl" }),
  ];
  const expected = [rows[5], rows[4], rows[1], rows[2], rows[3], rows[0]];
  expect(rankMentions(rows, "fizz")).toEqual(expected);
  expect(rankMentions([...rows].reverse(), "FIZZ")).toEqual(expected);
  const alias = choice("d", "Another name", {
    label: "Other Fizz",
    aliases: ["Another name", "Fizz"],
  });
  expect(rankMentions([choice("3", "Fast Fizz"), alias], "fizz")[0]).toBe(
    alias,
  );
});
it("sorts equal matches by case-insensitive displayed labels and only then keys", () => {
  const a = choice("a", "Hidden A", { label: "Zoe", aliases: ["common"] });
  const b = choice("b", "Hidden B", { label: "amy", aliases: ["common"] });
  const c = choice("c", "Hidden C", { label: "Amy", aliases: ["common"] });
  expect(rankMentions([c, a, b], "common")).toEqual([b, c, a]);
  expect(rankMentions([c, a, b], "")).toEqual([b, c, a]);
});

it("never matches hex or npub keys, including short substrings", () => {
  const key =
    "150b20bdf6130418df9239dd1bd082c71612c8d653b47c277200365b9be215dc";
  const row = choice("a", "Bad Janet", {
    recipient: { pubkey: key, name: "Bad Janet" },
  });
  const npub = npubEncode(key);
  for (const query of [
    "h",
    key,
    key.slice(0, 12),
    key.slice(-8),
    npub,
    npub.slice(0, 15),
    npub.slice(-6),
  ]) {
    expect(rankMentions([row], query), query).toEqual([]);
    expect(exactMention([row], query), query).toBeUndefined();
  }
  expect(rankMentions([row], "jan")).toEqual([row]);
});

it("does not search unnamed identity fallback labels or commit them with Space", () => {
  const row = choice("a", "aaaaaaaaaaaa", { aliases: [] });
  expect(rankMentions([row], "")).toEqual([row]);
  expect(rankMentions([row], "aaa")).toEqual([]);
  expect(exactMention([row], "aaaaaaaaaaaa")).toBeUndefined();
});

it("ranks outside humans and agents in one relevance group", () => {
  const human = choice("a", "Honey", { member: false });
  const agent = choice("b", "Honey Bee", {
    member: false,
    agent: true,
    owned: true,
  });
  const member = choice("c", "A Honey");
  expect(rankMentions([agent, human, member], "honey")).toEqual([
    member,
    human,
    agent,
  ]);
});
