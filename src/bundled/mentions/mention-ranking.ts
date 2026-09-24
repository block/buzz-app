import { npubEncode } from "nostr-tools/nip19";
import type { mentionCandidates } from "../../features/messages/mention-candidates";
export type MentionChoice = ReturnType<typeof mentionCandidates>[number] & {
  label: string;
};
const normalized = (text: string) => text.trim().toLowerCase();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function mentionMatch(choice: MentionChoice, query: string) {
  const needle = normalized(query);
  if (!needle) return 0;
  let best = Infinity;
  for (const name of [...choice.aliases, choice.label].map(normalized)) {
    const words = name.split(/\s+/u);
    best = Math.min(
      best,
      name === needle
        ? 0
        : name.startsWith(needle)
          ? 1
          : words.includes(needle)
            ? 2
            : words.some((word) => word.startsWith(needle))
              ? 3
              : Infinity,
    );
  }
  for (const key of [
    choice.recipient.pubkey,
    npubEncode(choice.recipient.pubkey),
  ])
    best = Math.min(
      best,
      key.startsWith(needle) ? 4 : key.includes(needle) ? 5 : Infinity,
    );
  return best;
}
export function rankMentions(
  choices: readonly MentionChoice[],
  query: string,
  history?: ReadonlyMap<string, number>,
  presence: (key: string) => string = () => "unknown",
) {
  const group = (c: MentionChoice) => (c.member ? 0 : c.agent ? 1 : 2);
  const online = (c: MentionChoice) =>
    ({ online: 0, away: 1 })[presence(c.recipient.pubkey)] ?? 2;
  return choices
    .filter((c) => Number.isFinite(mentionMatch(c, query)))
    .sort((a, b) => {
      const nameA = normalized(a.recipient.name),
        nameB = normalized(b.recipient.name);
      return (
        group(a) - group(b) ||
        mentionMatch(a, query) - mentionMatch(b, query) ||
        (a.agent && b.agent && nameA === nameB
          ? (history?.get(b.recipient.pubkey) ?? 0) -
              (history?.get(a.recipient.pubkey) ?? 0) ||
            Number(b.managed) - Number(a.managed) ||
            online(a) - online(b)
          : 0) ||
        compare(nameA, nameB) ||
        compare(a.recipient.pubkey, b.recipient.pubkey)
      );
    });
}
/** Space is intent only for one exact key across the full, uncapped choice set. */
export function exactMention(choices: readonly MentionChoice[], query: string) {
  const needle = normalized(query);
  if (!needle) return;
  const matches = choices.filter((c) =>
    [...c.aliases, c.label].some((name) => normalized(name) === needle),
  );
  if (
    matches.length !== 1 ||
    choices.some((c) =>
      [...c.aliases, c.label].some((name) =>
        normalized(name).startsWith(`${needle} `),
      ),
    )
  )
    return;
  return matches[0]?.recipient.pubkey;
}
