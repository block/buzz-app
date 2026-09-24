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
  ...extra,
});
it("groups before relevance, then exact/prefix/word/word-prefix/key with deterministic ties", () => {
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
  const row = choice("a", "One");
  expect(mentionMatch(row, "aaaa")).toBe(4);
  expect(mentionMatch(row, npubEncode(row.recipient.pubkey).slice(0, 15))).toBe(
    4,
  );
  expect(mentionMatch(row, npubEncode(row.recipient.pubkey).slice(-6))).toBe(5);
});
it("searches aliases and qualified labels but ranks by base name, not owner label", () => {
  const other = choice("a", "Honey", {
    label: "Wes’s Honey",
    aliases: ["Honey", "Legacy Bee"],
    agent: true,
  });
  const mine = choice("b", "Honey", { agent: true, managed: true });
  expect(rankMentions([other, mine], "Honey")[0]).toBe(mine);
  expect(rankMentions([other, mine], "Wes’s")).toEqual([other]);
  expect(rankMentions([other, mine], "Legacy")).toEqual([other]);
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
