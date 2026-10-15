import { matchPerson, normalizeName } from "./person-match";
import { searchOrder, type SearchUsage } from "./usage";

export type PersonCandidate = {
  pubkey: string;
  /** The name shown, after namesake qualification. */
  label: string;
  /** The kind-0 handle, shown beside the label, when it differs from it. */
  username?: string | undefined;
  /** A managed agent's own name, matched but not shown, as in mentions. */
  agentName?: string | undefined;
  agent: boolean;
  /** One of the viewer's own agents. */
  owned: boolean;
  /** peopleRelationships rank: lower is closer. */
  relationship: number;
  /** Search usage keys that lift this person: their own and their DM's. */
  usageKeys: readonly string[];
};

export const personKey = (pubkey: string) => `person:${pubkey}`;

/**
 * How well a person matches the typed text, or undefined. The shown label and
 * username use the shared name rule (person-match). A hidden agent name ranks
 * after every shown name, as `mentionMatch` ranks hidden aliases.
 */
export function personMatch(person: PersonCandidate, needle: string) {
  const tier = (name: string | undefined) =>
    name === undefined ? undefined : matchPerson(name, needle)?.tier;
  const shown = [tier(person.label), tier(person.username)].filter(
    (value) => value !== undefined,
  );
  if (shown.length) return Math.min(...shown);
  const hidden = tier(person.agentName);
  return hidden === undefined ? undefined : 4 + hidden;
}

/**
 * Command-K order for people and agents, the mention chooser's order adapted
 * to destinations. The shared search order leads (an exact name, then the
 * earlier choice for this text, then relationship bands lifted by usage, as
 * New message recipients order). Ties then follow the mention chooser:
 * the viewer's own agents, presence, then name and key.
 */
export function rankPeople<T extends PersonCandidate>(
  people: readonly T[],
  needle: string,
  usage: SearchUsage,
  picked: string | undefined,
  presence: (pubkey: string) => string = () => "unknown",
) {
  return people
    .flatMap((person) => {
      const rank = personMatch(person, needle);
      if (rank === undefined) return [];
      const order = searchOrder(usage, picked, {
        key: personKey(person.pubkey),
        rank,
        band: person.relationship,
        usageKeys: person.usageKeys,
      });
      return [{ person, order }];
    })
    .sort(
      (a, b) =>
        a.order - b.order ||
        Number(b.person.agent && b.person.owned) -
          Number(a.person.agent && a.person.owned) ||
        online(presence(a.person.pubkey)) - online(presence(b.person.pubkey)) ||
        compare(normalizeName(a.person.label), normalizeName(b.person.label)) ||
        compare(a.person.pubkey, b.person.pubkey),
    );
}

const online = (status: string) =>
  ({ online: 0, away: 1 })[status as "online" | "away"] ?? 2;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
