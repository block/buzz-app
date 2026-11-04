import { pubkeyOf } from "../../features/agents/membership";
// find: candidates this turn's audience may see, best first, at most 32.
//
//   messages = relay full-text search, as the agent (this channel, or every channel it can read)
//   memories = the agent's memory lines, scored here: the relay cannot search ciphertext
//   vectors  = optional local embeddings, audience-checked by their owner; a failure is just no vectors
//   merge    = reciprocal rank fusion, then dedupe
//
// Every message passes the audience rule; memories pass only in an owner-only chat unless the owner opts in.
import type {
  AudienceFacts,
  Candidate,
  Deps,
  Event,
  Memory,
  MemoryListing,
  Settings,
  Turn,
} from "./types.ts";

export const LIMIT = 32;
const SEARCH = 40;
const MESSAGE_KINDS = [9];

export async function find(
  turn: Turn,
  settings: Settings,
  semantic?: Deps["semantic"],
): Promise<readonly Candidate[]> {
  const words = keywords(turn.text);
  if (!words.length) return [];
  const here = turn.reads.channel(turn.channel);
  const [messages, memories, vectors] = await Promise.all([
    searchMessages(turn, settings, words, here),
    here.then(async (facts) =>
      settings.sharedMemories ||
      ownerOnly(facts, turn.owner, pubkeyOf(turn.agent))
        ? scoreMemories(await turn.reads.memories(), words)
        : [],
    ),
    semantic ? semantic.neighbours(turn).catch(() => []) : [],
  ]);
  return merge([messages, memories, vectors])
    .filter((c) => c.id !== turn.event)
    .slice(0, LIMIT);
}

// ── query ────────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    "a about after again all am an and any are as at be because been before being but by can could did do does " +
    "doing for from had has have having he her here hers him his how i if in into is it its just me more most my " +
    "no nor not now of off on once only or other our out over own same she should so some such than that the " +
    "their them then there these they this those through to too under until up very was we were what when where " +
    "which while who whom why will with would you your yours"
  ).split(" "),
);

/** The request's salient words, lowercased and unique, in order. */
export function keywords(text: string): string[] {
  const words =
    text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOP.has(w)))].slice(
    0,
    32,
  );
}

// ── messages ─────────────────────────────────────────────────────────────────────────────────────

async function searchMessages(
  turn: Turn,
  settings: Settings,
  words: readonly string[],
  here: Promise<AudienceFacts | undefined>,
): Promise<Candidate[]> {
  const scoped = settings.scope === "channel";
  const hits = await turn.reads.events({
    kinds: MESSAGE_KINDS,
    search: words.join(" OR "),
    ...(scoped ? { "#h": [turn.channel] } : {}),
    limit: SEARCH,
  });
  const allowed = await audience(turn, hits, await here);
  return hits.filter((e) => allowed(channelOf(e))).map(fromEvent);
}

export const channelOf = (e: Event) => {
  const h = e.tags.filter((t) => t[0] === "h");
  return h.length === 1 ? h[0]?.[1] : undefined;
};

const fromEvent = (e: Event): Candidate => ({
  id: e.id,
  kind: "message",
  text: e.content,
  at: e.created_at,
  author: e.pubkey,
  channel: channelOf(e),
});

/** Who may read what, for the channels these hits came from. Facts are read once each, in this lease. */
async function audience(
  turn: Turn,
  hits: readonly Event[],
  target: AudienceFacts | undefined,
) {
  const sources = [...new Set(hits.map(channelOf))].filter(
    (s): s is string => !!s && s !== turn.channel,
  );
  const facts = new Map(
    await Promise.all(
      sources.map(async (id) => [id, await turn.reads.channel(id)] as const),
    ),
  );
  return (source: string | undefined) =>
    !!source && mayFlow(source, turn.channel, facts.get(source), target);
}

/**
 * May text said in channel S be shown in channel T? Only if everyone who can read T could already read S.
 *
 *   S = T                 → yes: the agent reads T as itself
 *   unknown or incomplete → no
 *   S open                → yes
 *   S private, T open     → no, whatever T's member list says
 *   S private, T private  → members(T) ⊆ members(S)
 */
export function mayFlow(
  s: string,
  t: string,
  source?: AudienceFacts,
  target?: AudienceFacts,
): boolean {
  if (s === t) return true;
  if (!known(source) || !known(target)) return false;
  if (source.visibility === "open") return true;
  if (target.visibility === "open") return false;
  const readers = new Set(source.members);
  return target.members.every((m) => readers.has(m));
}

const known = (f?: AudienceFacts): f is AudienceFacts =>
  !!f && (f.visibility === "open" || f.complete);

// ── memories ─────────────────────────────────────────────────────────────────────────────────────

/** Memories are the owner's: recalled only in a chat that just the owner and agent can read, unless opted in. */
export function ownerOnly(
  facts: AudienceFacts | undefined,
  owner: string,
  agent: string,
): boolean {
  if (!facts || facts.visibility === "open" || !facts.complete || !owner)
    return false;
  return facts.members.every((m) => m === owner || m === agent);
}

/** Memory lines ranked by BM25 against the request's words; lines with no match are dropped. */
export function scoreMemories(
  listing: MemoryListing,
  words: readonly string[],
): Candidate[] {
  const lines = live(listing).flatMap((m) =>
    m.body
      .split("\n")
      .map((text, i) => ({
        text: text.trim(),
        id: `${m.slug}#${i}`,
        at: m.createdAt,
      }))
      .filter((l) => l.text),
  );
  const terms = lines.map((l) => keywords(l.text));
  const avg =
    terms.reduce((n, t) => n + t.length, 0) / Math.max(1, terms.length);
  const df = (w: string) => terms.filter((t) => t.includes(w)).length;
  const idf = new Map(
    words.map((w) => [
      w,
      Math.log(1 + (lines.length - df(w) + 0.5) / (df(w) + 0.5)),
    ]),
  );
  const score = (t: readonly string[]) =>
    words.reduce((sum, w) => {
      const f = t.filter((x) => x === w).length;
      return (
        sum +
        (f
          ? // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
            (idf.get(w)! * f * 2.2) /
            (f + 1.2 * (0.25 + (0.75 * t.length) / avg))
          : 0)
      );
    }, 0);
  return (
    lines
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      .map((l, i) => ({ l, s: score(terms[i]!) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, SEARCH)
      .map(({ l }) => ({
        id: l.id,
        kind: "memory" as const,
        text: l.text,
        at: l.at,
      }))
  );
}

/** Entries no tombstone has overtaken: a deletion at or after an entry's write removes it. */
export function live(listing: MemoryListing): Memory[] {
  const deleted = new Map<string, number>();
  for (const d of listing.deleted ?? [])
    deleted.set(
      d.slug,
      Math.max(d.createdAt, deleted.get(d.slug) ?? -Infinity),
    );
  return listing.entries.filter(
    (m) => !(m.createdAt <= (deleted.get(m.slug) ?? -Infinity)),
  );
}

// ── merge ────────────────────────────────────────────────────────────────────────────────────────

/** Reciprocal rank fusion (k = 60) across ranked lists, dropping repeated ids and repeated text. */
export function merge(lists: readonly (readonly Candidate[])[]): Candidate[] {
  const score = new Map<string, number>();
  const byId = new Map<string, Candidate>();
  for (const list of lists)
    list.forEach((c, rank) => {
      score.set(c.id, (score.get(c.id) ?? 0) + 1 / (60 + rank + 1));
      if (!byId.has(c.id)) byId.set(c.id, c);
    });
  const seen = new Set<string>();
  return (
    [...byId.values()]
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      .sort((a, b) => score.get(b.id)! - score.get(a.id)!)
      .filter((c) => !seen.has(c.text) && !!seen.add(c.text))
  );
}
