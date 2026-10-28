import {
  exactName,
  matchPerson,
  nameStarts,
  normalizeName,
} from "../../features/search/person-match";
import type { mentionCandidates } from "./mention-candidates";
export type MentionChoice = ReturnType<typeof mentionCandidates>[number] & {
  label: string;
  /** The generated key suffix that ends `label` (`Honey · 4prr`), if any. */
  qualifier?: string | undefined;
};
const normalized = normalizeName;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const nameMatch = (text: string, query: string) =>
  query ? (matchPerson(text, query)?.tier ?? Infinity) : 0;
function baseMatch(choice: MentionChoice, query: string) {
  return Math.min(
    ...choice.aliases.map((name) => nameMatch(name, normalized(query))),
  );
}
export function mentionMatch(choice: MentionChoice, query: string) {
  const needle = normalized(query);
  if (!needle) return 0;
  // No known name means the displayed label is only an identity fallback.
  if (!choice.aliases.length) return Infinity;
  // Rank what the user sees before other real names for the same identity.
  const visible = nameMatch(choice.label, needle);
  if (Number.isFinite(visible)) return visible;
  return 4 + baseMatch(choice, query);
}
// One sorted index of name starts per immutable choice list.
const indexes = new WeakMap<
  readonly MentionChoice[],
  { starts: string[]; owners: number[] }
>();
/**
 * The choices, in their given order, with a label or alias that the query can
 * match: a superset of every choice that `rankMentions` or `exactMention` keeps
 * for this query. A binary search of the list's name index finds them, so a
 * keystroke costs O(log n + matches) instead of a scan of every choice.
 */
export function matchingMentions(
  choices: readonly MentionChoice[],
  query: string,
): readonly MentionChoice[] {
  const needle = normalized(query);
  if (!needle) return choices;
  let index = indexes.get(choices);
  if (!index) {
    const entries = choices.flatMap((choice, owner) =>
      [...new Set([choice.label, ...choice.aliases])].flatMap((name) =>
        nameStarts(name).map((start) => ({ start, owner })),
      ),
    );
    entries.sort((a, b) => compare(a.start, b.start));
    index = {
      starts: entries.map((entry) => entry.start),
      owners: entries.map((entry) => entry.owner),
    };
    indexes.set(choices, index);
  }
  let low = 0;
  let high = index.starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((index.starts[middle] ?? "") < needle) low = middle + 1;
    else high = middle;
  }
  const found = new Set<number>();
  for (let i = low; index.starts[i]?.startsWith(needle); i += 1)
    found.add(index.owners[i] ?? 0);
  return [...found]
    .sort((a, b) => a - b)
    .flatMap((owner) => choices[owner] ?? []);
}
/**
 * Sorts by per-choice keys, so the order is transitive for any mix of people
 * and agents. Another community's agents follow everyone here. After match quality, your own agents come first. Agents that
 * share a name form one block at its first visible label; recency, managed,
 * and presence order only that block.
 */
export function rankMentions(
  choices: readonly MentionChoice[],
  query: string,
  history?: ReadonlyMap<string, number>,
  presence: (key: string) => string = () => "unknown",
) {
  const keyed = choices
    .filter((c) => Number.isFinite(mentionMatch(c, query)))
    .map((c) => {
      const tier = [
        c.member ? 0 : 1,
        c.elsewhere ? 1 : 0,
        mentionMatch(c, query),
        baseMatch(c, query),
        c.agent && c.owned ? 0 : 1,
      ];
      return {
        c,
        tier,
        label: normalized(c.label),
        // People never join a block. On an equal label they sort first.
        block: c.agent
          ? `1${JSON.stringify([tier, normalized(c.recipient.name)])}`
          : `0${c.recipient.pubkey}`,
        recent: history?.get(c.recipient.pubkey) ?? 0,
        online: { online: 0, away: 1 }[presence(c.recipient.pubkey)] ?? 2,
      };
    });
  const first = new Map<string, string>();
  for (const k of keyed) {
    const label = first.get(k.block);
    if (label === undefined || k.label < label) first.set(k.block, k.label);
  }
  const blockLabel = (k: (typeof keyed)[number]) => first.get(k.block) ?? "";
  return keyed
    .sort(
      (a, b) =>
        a.tier.reduce((d, value, i) => d || value - (b.tier[i] ?? 0), 0) ||
        compare(blockLabel(a), blockLabel(b)) ||
        compare(a.block, b.block) ||
        b.recent - a.recent ||
        Number(b.c.managed) - Number(a.c.managed) ||
        a.online - b.online ||
        compare(a.label, b.label) ||
        compare(a.c.recipient.pubkey, b.c.recipient.pubkey),
    )
    .map((k) => k.c);
}
/**
 * Space is intent only for one exact key across the full, uncapped choice set.
 * Every choice can continue the name; only choices `among` can equal it. A key
 * qualifier or generated `(agent)` suffix only tells namesakes apart, so it
 * never continues the name.
 */
export const exactMention = (
  choices: readonly MentionChoice[],
  query: string,
  among: (choice: MentionChoice) => boolean = () => true,
) =>
  exactName(
    choices,
    (c) => [...c.aliases, c.label],
    query,
    (c) => c.aliases.length > 0 && among(c),
    (c) => {
      const label =
        c.qualifier && c.label.endsWith(` · ${c.qualifier}`)
          ? c.label.slice(0, -(c.qualifier.length + 3))
          : c.label;
      // Literal names still block through aliases; generated suffixes do not.
      return c.agent &&
        c.aliases.some((name) => `${name.trim()} (agent)` === label)
        ? c.aliases
        : [...c.aliases, label];
    },
  )?.recipient.pubkey;
