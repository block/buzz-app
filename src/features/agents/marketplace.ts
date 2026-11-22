// The Marketplace's stars and import counts, and its search.
//
// A star is a NIP-25 reaction (kind 7, content "⭐") carrying the agent's
// current head as `e`, which the relay scopes the reaction by, its NIP-33
// address as `a`, and `k` = 30175. An import is the same reaction with content
// "📥", published once a copy is made here. Counts are read by `#a`, so they
// carry across edits. Unstarring deletes your reactions (kind 5), one per
// event; imports are never undone. Counts are self-reported: anyone can
// publish a reaction, so they show who said they starred or imported, at
// most once per person.
import type { Outbox } from "../relay/outbox";
import type { EventData, ReadFilter } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { AGENT_CATALOG_KIND } from "./catalog-envelope";
import type { SharedAgent } from "./shared-agents";

export const STAR = "⭐";
export const IMPORT = "📥";
const REACTION_KIND = 7;
const DELETION_KIND = 5;
const ADDRESS_CHUNK = 150;
const READ_LIMIT = 500;
/** Up to 10,000 reactions per chunk of agents; past that, counts are a floor. */
const REACTION_PAGES = 20;

export const address = (agent: Pick<SharedAgent, "owner" | "d">) =>
  `${AGENT_CATALOG_KIND}:${agent.owner}:${agent.d}`;

type Reader = Pick<RelaySession, "readRemote">;

/** Every event matching `filter`, newest first. A page over the read budget
 * is retried at half the size, as the catalog read is. */
export async function readAll(
  read: (
    filters: readonly ReadFilter[],
    settings: { signal: AbortSignal },
  ) => Promise<readonly EventData[]>,
  filter: Omit<ReadFilter, "limit">,
  signal: AbortSignal,
  { limit: initial, maxPages = Infinity }: { limit: number; maxPages?: number },
): Promise<EventData[]> {
  const events: EventData[] = [];
  let cursor: { until: number; before_id: string } | undefined;
  let limit = initial;
  for (let pages = 0; pages < maxPages; ) {
    signal.throwIfAborted();
    let page: readonly EventData[];
    try {
      page = await read([{ ...filter, limit, ...cursor }], { signal });
    } catch (problem) {
      if (
        limit > 1 &&
        problem instanceof Error &&
        /read budget/i.test(problem.message)
      ) {
        limit = Math.floor(limit / 2);
        continue;
      }
      throw problem;
    }
    pages++;
    events.push(...page);
    const last = [...page]
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .at(-1);
    if (page.length < limit || !last) break;
    cursor = { until: last.created_at, before_id: last.id };
  }
  return events;
}

export type Reactions = Readonly<{
  /** Address → (pubkey → that person's star reaction ids). */
  stars: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Address → people who imported it here. */
  imports: ReadonlyMap<string, ReadonlySet<string>>;
}>;

/** Stars and imports on these agents as the relay has them, not this
 * device's unsent writes. The relay withholds deleted reactions. Everyone's
 * reactions are capped, so the viewer's own are read apart: whatever else is
 * published on an agent, your star shows and unstarring finds it. */
export async function readReactions(
  session: Reader,
  agents: readonly SharedAgent[],
  signal: AbortSignal,
  viewer?: string,
): Promise<Reactions> {
  const stars = new Map<string, Map<string, string[]>>();
  const imports = new Map<string, Set<string>>();
  const addresses = [...new Set(agents.map(address))];
  const wanted = new Set(addresses);
  const read = (filter: Omit<ReadFilter, "limit">) =>
    readAll(
      (filters, settings) => session.readRemote(filters, settings),
      filter,
      signal,
      { limit: READ_LIMIT, maxPages: REACTION_PAGES },
    );
  for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
    const filter = {
      kinds: [REACTION_KIND],
      "#a": addresses.slice(i, i + ADDRESS_CHUNK),
    };
    const page = await read(filter);
    if (viewer) page.push(...(await read({ ...filter, authors: [viewer] })));
    for (const event of page) {
      if (event.kind !== REACTION_KIND) continue;
      const target = event.tags.find(
        (tag) => tag[0] === "a" && wanted.has(tag[1] ?? ""),
      )?.[1];
      if (!target) continue;
      if (event.content === IMPORT) {
        const people = imports.get(target) ?? new Set();
        imports.set(target, people.add(event.pubkey));
      } else if (event.content === STAR) {
        const byPerson = stars.get(target) ?? new Map<string, string[]>();
        stars.set(target, byPerson);
        const mine = byPerson.get(event.pubkey) ?? [];
        if (!mine.includes(event.id))
          byPerson.set(event.pubkey, [...mine, event.id]);
      }
    }
  }
  return { stars, imports };
}

/** People other than its owner who imported this agent here. */
export function importCount(reactions: Reactions, agent: SharedAgent) {
  const people = reactions.imports.get(address(agent));
  return (people?.size ?? 0) - (people?.has(agent.owner) ? 1 : 0);
}

export const starCount = (reactions: Reactions, agent: SharedAgent) =>
  reactions.stars.get(address(agent))?.size ?? 0;

// No `p` tag for the owner, though NIP-25 suggests one: it would notify them
// of every star and import.
const reaction = (agent: SharedAgent, content: string) => ({
  kind: REACTION_KIND,
  content,
  tags: [
    ["e", agent.event],
    ["a", address(agent)],
    ["k", String(AGENT_CATALOG_KIND)],
  ],
});

/** Settles once the outbox knows how `id` went, then retires it: accepted, or
 * refused (which throws, and is never retried). An unanswered write may still
 * land, so it stays for the outbox to reconcile and counts as delivered. */
export function settle(outbox: Outbox, id: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    let done = false;
    const inspect = () => {
      if (done) return;
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      const delivery = item?.delivery;
      if (delivery === "sending") return;
      done = true;
      queueMicrotask(() => stop());
      if (delivery !== "unknown") void outbox.dismiss(id).catch(() => {});
      if (delivery === "failed")
        reject(new Error(item?.error || "The relay refused it."));
      else resolve();
    };
    stop = outbox.subscribe(inspect);
    inspect();
  });
}

export type MarketplaceState = Reactions &
  Readonly<{
    status: "loading" | "ready" | "error";
    error?: string | undefined;
    /** Addresses whose star is being written. */
    pending: ReadonlySet<string>;
    /** Address → why its last star or unstar didn't go through. */
    failures: ReadonlyMap<string, string>;
  }>;

/** One community session's stars and imports, shared by the Marketplace grid
 * and the agent opened beside it. */
export function createMarketplace(
  session: Reader & Pick<RelaySession, "outbox">,
  viewer: string | undefined,
) {
  let state: MarketplaceState = {
    status: "loading",
    stars: new Map(),
    imports: new Map(),
    pending: new Set(),
    failures: new Map(),
  };
  const listeners = new Set<() => void>();
  const update = (change: Partial<MarketplaceState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const changed = <K, V>(map: ReadonlyMap<K, V>, key: K, value?: V) => {
    const next = new Map(map);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    return next;
  };
  const setMine = (key: string, ids?: readonly string[]) => {
    if (!viewer) return;
    update({
      stars: changed(
        state.stars,
        key,
        changed(state.stars.get(key) ?? new Map(), viewer, ids),
      ),
    });
  };
  const outbox = session.outbox;
  const loaded = new Set<string>();
  /** Whether importing `agent` now would publish an import record. */
  const recordable = (
    agent: SharedAgent,
    current: MarketplaceState = state,
  ): boolean =>
    !!outbox &&
    !!viewer &&
    viewer !== agent.owner &&
    current.status === "ready" &&
    !current.imports.get(address(agent))?.has(viewer) &&
    outbox.supports(REACTION_KIND);
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
    /** Reads counts for agents not read yet this session, so returning to the
     * Marketplace reads only what's new. A star being written keeps what it
     * shows. */
    async load(agents: readonly SharedAgent[], signal: AbortSignal) {
      const missing = agents.filter((agent) => !loaded.has(address(agent)));
      if (!missing.length) {
        if (state.status !== "ready") update({ status: "ready" });
        return;
      }
      if (state.status === "error")
        update({ status: "loading", error: undefined });
      try {
        const reactions = await readReactions(session, missing, signal, viewer);
        if (signal.aborted) return;
        const stars = new Map(state.stars);
        const imports = new Map(state.imports);
        for (const agent of missing) {
          const key = address(agent);
          loaded.add(key);
          if (state.pending.has(key)) continue;
          const starred = reactions.stars.get(key);
          const imported = reactions.imports.get(key);
          if (starred) stars.set(key, starred);
          else stars.delete(key);
          if (imported) imports.set(key, imported);
          else imports.delete(key);
        }
        update({ status: "ready", stars, imports });
      } catch (problem) {
        if (signal.aborted) return;
        update({
          status: "error",
          error: problem instanceof Error ? problem.message : String(problem),
        });
      }
    },
    /** Why starring isn't possible here, or undefined when it is. */
    unavailable(current: MarketplaceState): string | undefined {
      if (
        !viewer ||
        !outbox?.supports(REACTION_KIND) ||
        !outbox.supports(DELETION_KIND)
      )
        return "Starring isn’t available in this community.";
      if (current.status === "error")
        return `Stars couldn’t load. ${current.error ?? ""}`.trim();
      if (current.status === "loading") return "Loading stars…";
      return undefined;
    },
    /** Shows the change at once and rolls it back if the relay refuses it. */
    async toggleStar(agent: SharedAgent) {
      const key = address(agent);
      if (!outbox || !viewer || state.pending.has(key)) return;
      const mine = state.stars.get(key)?.get(viewer) ?? [];
      const starring = !mine.length;
      const deleted: string[] = [];
      update({
        pending: new Set(state.pending).add(key),
        failures: changed(state.failures, key),
      });
      try {
        await outbox.ready();
        if (starring) {
          const id = outbox.send(reaction(agent, STAR));
          setMine(key, [id]);
          await settle(outbox, id);
        } else {
          setMine(key);
          // The relay takes one target per deletion; a failure keeps only the
          // reactions still standing.
          for (const id of mine) {
            await settle(
              outbox,
              outbox.send({
                kind: DELETION_KIND,
                content: "",
                tags: [
                  ["e", id],
                  ["k", String(REACTION_KIND)],
                ],
              }),
            );
            deleted.push(id);
          }
        }
      } catch (problem) {
        setMine(
          key,
          starring ? undefined : mine.filter((id) => !deleted.includes(id)),
        );
        const reason =
          problem instanceof Error ? problem.message : String(problem);
        update({
          failures: changed(
            state.failures,
            key,
            `Couldn’t ${starring ? "star" : "unstar"}: ${reason}`,
          ),
        });
      } finally {
        const pending = new Set(state.pending);
        pending.delete(key);
        update({ pending });
      }
    },
    recordable,
    /** Counts a copy made here, once per person and never its owner's own.
     * The copy already stands, so a refusal only loses the count. */
    async recordImport(agent: SharedAgent) {
      const key = address(agent);
      if (!outbox || !viewer || !recordable(agent)) return;
      const people = state.imports.get(key);
      update({
        imports: changed(state.imports, key, new Set(people).add(viewer)),
      });
      try {
        await outbox.ready();
        await settle(outbox, outbox.send(reaction(agent, IMPORT)));
      } catch {
        update({ imports: changed(state.imports, key, people) });
      }
    },
  };
}
export type Marketplace = ReturnType<typeof createMarketplace>;

const bySession = new WeakMap<object, Map<string, Marketplace>>();
/** The session's one Marketplace for this viewer, so the grid and the agent
 * opened beside it show the same stars. */
export function marketplaceFor(
  session: Reader & Pick<RelaySession, "outbox">,
  viewer: string | undefined,
): Marketplace {
  const byViewer = bySession.get(session) ?? new Map<string, Marketplace>();
  bySession.set(session, byViewer);
  let marketplace = byViewer.get(viewer ?? "");
  if (!marketplace) {
    marketplace = createMarketplace(session, viewer);
    byViewer.set(viewer ?? "", marketplace);
  }
  return marketplace;
}

// ---------- search ----------

export const terms = (query: string) =>
  query.toLowerCase().split(/\s+/).filter(Boolean);

/** Every term must appear somewhere; name matches outrank the rest. 0 means
 * no match. */
export function score(
  agent: SharedAgent,
  words: readonly string[],
  creator: string,
): number {
  if (!words.length) return 1;
  const name = agent.name.toLowerCase();
  const instructions = agent.instructions.toLowerCase();
  const facts =
    `${agent.model} ${agent.runtime ?? ""} ${agent.provider ?? ""} ${creator}`.toLowerCase();
  let total = 0;
  for (const word of words) {
    let hit = 0;
    if (name.includes(word)) hit += name.startsWith(word) ? 12 : 8;
    if (instructions.includes(word))
      hit += 1 + Math.min(instructions.split(word).length - 2, 4) * 0.25;
    if (facts.includes(word)) hit += 2;
    if (!hit) return 0;
    total += hit;
  }
  return total;
}

/** About `length` characters of `text`, starting near its first matching
 * term once that lies past the opening. */
export function excerpt(
  text: string,
  words: readonly string[],
  length = 240,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const found = words
    .map((word) => lower.indexOf(word))
    .filter((index) => index !== -1);
  const at = found.length ? Math.min(...found) : -1;
  if (at < length / 2)
    return flat.length > length ? `${flat.slice(0, length).trimEnd()}…` : flat;
  const start = Math.max(0, at - length / 3);
  const end = Math.min(flat.length, start + length);
  return `…${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}
