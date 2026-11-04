// What a turn-context contributor may read, and the facts it may trust.
//
// Facts come from the admitted request, never from prompt text. Reads run as
// the agent, so a contributor sees only what the agent itself could see, and
// only while the turn's lease is live: each read checks the lease before it
// starts and again before it resolves, and rejects once it is revoked.
import type { RelayEvent, EventData, ReadFilter } from "../relay/events";
import { channelVisibility } from "../relay/channel-details-protocol";
import { threadReference } from "../relay/thread-reference";
import type { MemoryListing } from "./reads";
import type { AgentKey } from "./membership";
import type { AgentHandle, Trigger } from "./service";

/** A contributor's read authority: live until its run settles, the deadline
 * passes, the turn stops, the plugin unloads or the account changes. */
export type ReadLease = Readonly<{ signal: AbortSignal; live(): boolean }>;

/** Who may read a channel, as the agent sees it. `complete` only when
 * `members` comes from the relay-signed roster for exactly this channel. */
export type AudienceFacts = Readonly<{
  visibility: "open" | "private" | "dm";
  members: readonly string[];
  complete: boolean;
}>;

export type TurnReads = Readonly<{
  /** Messages (kinds 9, 40002, 40008) as the agent. Only `kinds`, `search`,
   * `ids`, `#h`, `since`, `until` and `limit` (≤ 500); a filter with neither
   * `search`, `ids` nor `#h` rejects, so no read dumps every channel. */
  events(filter: ReadFilter): Promise<readonly EventData[]>;
  /** Channel `id`'s audience, read once per lease; undefined when unknown. */
  channel(id: string): Promise<AudienceFacts | undefined>;
  /** The agent's memory listing, as its owner reads it. */
  memories(): Promise<MemoryListing>;
}>;

/** The turn's routing facts, from the admitted request alone. */
export type TurnFacts = Readonly<{
  agent: AgentKey;
  /** The community's relay URL. */
  community: string;
  owner: string;
  channel: string;
  root?: string;
  event: string;
  /** The request's text: untrusted user content, verbatim. */
  text: string;
}>;

export type TurnReadDeps = Readonly<{
  /** Reads as the agent: `AgentHandle.query`. */
  query(filters: readonly object[]): Promise<readonly RelayEvent[]>;
  /** The owner's read of the agent's memory. */
  memories(signal: AbortSignal): Promise<MemoryListing>;
  /** The key the relay signs channel metadata with, when known. */
  relayAuthor: string | undefined;
}>;

const MESSAGE_KINDS: readonly number[] = [9, 40002, 40008];
const MAX = 500;
const FILTER_KEYS = new Set([
  "kinds",
  "search",
  "ids",
  "#h",
  "since",
  "until",
  "limit",
]);
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const revoked = () => new Error("This turn's reads have ended");

export function createTurnReads(
  deps: TurnReadDeps,
  lease: ReadLease,
): TurnReads {
  const leased = <T>(read: () => Promise<T>): Promise<T> => {
    if (!lease.live()) return Promise.reject(revoked());
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(revoked());
      lease.signal.addEventListener("abort", stop, { once: true });
      read()
        .then((value) => (lease.live() ? resolve(value) : stop()), reject)
        .finally(() => lease.signal.removeEventListener("abort", stop));
    });
  };
  const channels = new Map<string, Promise<AudienceFacts | undefined>>();
  return Object.freeze({
    events: (filter: ReadFilter) => {
      let checked: object;
      try {
        checked = messageFilter(filter);
      } catch (error) {
        return Promise.reject(error);
      }
      return leased(async () =>
        (await deps.query([checked])).filter((event) =>
          MESSAGE_KINDS.includes(event.kind),
        ),
      );
    },
    channel: (id: string) => {
      if (!lease.live()) return Promise.reject(revoked());
      if (!CHANNEL.test(id)) return Promise.resolve(undefined);
      let facts = channels.get(id);
      if (!facts) {
        facts = leased(() => audience(deps, id)).catch((error) => {
          if (!lease.live()) throw error;
          return undefined; // A failed read is unknown, never permission.
        });
        channels.set(id, facts);
      }
      const cached = facts;
      return leased(() => cached);
    },
    memories: () => leased(() => deps.memories(lease.signal)),
  });
}

/** The filter a message read sends, or an error naming what it may not ask. */
function messageFilter(filter: ReadFilter): object {
  for (const key of Object.keys(filter))
    if (!FILTER_KEYS.has(key))
      throw new Error(`Turn reads cannot filter ${key}`);
  const { kinds = MESSAGE_KINDS, search, ids, since, until, limit } = filter;
  const h = filter["#h"];
  if (!kinds.length || kinds.some((kind) => !MESSAGE_KINDS.includes(kind)))
    throw new Error("Turn reads return messages only");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX)
    throw new Error(`A turn read's limit is 1 to ${MAX}`);
  if (search !== undefined && (typeof search !== "string" || !search.trim()))
    throw new Error("A turn read's search is text");
  if (
    ids &&
    (!ids.length || ids.length > MAX || !ids.every((id) => HEX64.test(id)))
  )
    throw new Error("A turn read's ids are event ids");
  if (
    h &&
    (!h.length ||
      h.length > MAX ||
      !h.every((id) => typeof id === "string" && id))
  )
    throw new Error("A turn read's #h names channels");
  for (const time of [since, until])
    if (time !== undefined && !(Number.isInteger(time) && time >= 0))
      throw new Error("A turn read's times are Unix seconds");
  if (search === undefined && !ids && !h)
    throw new Error("A turn read needs search, ids or #h");
  return {
    kinds: [...kinds],
    limit,
    ...(search !== undefined ? { search } : {}),
    ...(ids ? { ids: [...ids] } : {}),
    ...(h ? { "#h": [...h] } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

/** Channel `id`'s relay-signed metadata (39000) and roster (39002), read as
 * the agent from the writer. Unknown visibility is no facts at all; a roster
 * that is missing, foreign or not exactly this channel's is incomplete. */
async function audience(
  { query, relayAuthor }: TurnReadDeps,
  id: string,
): Promise<AudienceFacts | undefined> {
  if (!relayAuthor) return undefined;
  const read = (kind: number) => ({
    kinds: [kind],
    authors: [relayAuthor],
    "#d": [id],
    limit: 1,
    consistency: "strong",
  });
  const events = await query([read(39000), read(39002)]);
  const signed = (kind: number) => {
    const found = events.filter((event) => event.kind === kind);
    const event = found.length === 1 ? found[0] : undefined;
    const d = event?.tags.filter(([name]) => name === "d") ?? [];
    const [only] = d;
    return event?.pubkey === relayAuthor &&
      d.length === 1 &&
      only?.length === 2 &&
      only[1] === id
      ? event
      : undefined;
  };
  const metadata = signed(39000);
  const flag = metadata && channelVisibility(metadata);
  if (!flag) return undefined;
  const dm = metadata.tags.some(
    ([name, value]) => name === "t" && value === "dm",
  );
  const visibility = flag === "public" ? "open" : dm ? "dm" : "private";
  const roster = signed(39002);
  if (!roster) return { visibility, members: [], complete: false };
  const members = [
    ...new Set(
      roster.tags.flatMap(([name, key]) =>
        name === "p" && key && HEX64.test(key) ? [key] : [],
      ),
    ),
  ];
  return { visibility, members, complete: true };
}

/** The turn's facts from the delivery's admitted mention, or undefined when
 * it is no mention or its routing is not certain: exactly one `h`, equal
 * to the live route's channel. Agent and owner come from the handle; nothing from the text. */
export function turnFacts(
  delivery: Readonly<{
    agent: AgentHandle;
    trigger: Trigger;
    channelId?: string;
  }>,
  community: string,
): TurnFacts | undefined {
  const { agent, trigger, channelId } = delivery;
  if (trigger.type !== "mention") return undefined;
  const { event } = trigger;
  const h = event.tags.filter(([name]) => name === "h");
  const channel = h.length === 1 ? h[0]?.[1] : undefined;
  if (!channel || channelId !== channel) return undefined;
  const root = threadReference(event)?.rootId;
  return Object.freeze({
    agent: agent.key,
    community,
    owner: agent.owner,
    channel,
    ...(root ? { root } : {}),
    event: event.id,
    text: event.content,
  });
}
