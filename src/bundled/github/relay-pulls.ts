// The pull requests followed in the channels shown: each channel's current
// `buzz.github.pull` and `buzz.github.hook` artifacts, kept current by NIP-AR
// sync. A card is trusted when the relay signed it, or the publisher of the
// live hook it names did. Only the relay's cards speak for a pull request
// anywhere it is linked; a publisher's shows only on its own announcement.
import type { VerifiedEvent } from "nostr-tools";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ARTIFACT_REVISION_KIND } from "../../features/relay/artifact-sync";
import { HOOK_TYPE, parseHook, type Hook } from "./hooks";
import { keyOf, type PullSource } from "./pull-states";
import {
  PULL_TYPE,
  parseCard,
  pullStateOf,
  trust,
  type PullRecord,
} from "./relay-pull";

/** How long a channel's sync outlives its last reader, so a timeline that
 * scrolls a card away and back does not start it again. */
export const SYNC_LINGER_MS = 60_000;

export type RelayPulls = Readonly<{
  /** Syncs `channel`'s pull requests while watched, and a while after. */
  watch(channel: string): () => void;
  subscribe(listener: () => void): () => void;
  /** The relay's newest record for a canonical URL. */
  byUrl(url: string): PullRecord | undefined;
  /** The newest record rooted on announcement `id` that `author`, the
   * announcement's signer, wrote: the relay or that publisher. */
  byRoot(id: string, author: string): PullRecord | undefined;
  dispose(): void;
}>;

type Synced = {
  view: ReturnType<RelaySession["artifacts"]["sync"]>;
  stop(): void;
  readers: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
};

export function createRelayPulls(session: RelaySession): RelayPulls {
  const listeners = new Set<() => void>();
  const synced = new Map<string, Synced>();
  // Cards are parsed once each; trust is decided again on every rebuild,
  // since it follows the hooks.
  const cards = new WeakMap<VerifiedEvent, PullRecord | null>();
  const trusted = new WeakMap<PullRecord, PullRecord>();
  let urls = new Map<string, PullRecord>();
  let roots = new Map<string, PullRecord>();
  const writerOf = (record: PullRecord) =>
    record.publisher ?? session.relayAuthor ?? "";
  const rootKey = (root: string, author: string) => `${root}\0${author}`;
  const cardOf = (event: VerifiedEvent) => {
    let card = cards.get(event);
    if (card === undefined) {
      card = parseCard(event) ?? null;
      cards.set(event, card);
    }
    return card ?? undefined;
  };
  /** The same object for the same trusted card, so an unchanged rebuild
   * notifies no one. */
  const stable = (card: PullRecord, record: PullRecord) => {
    if (record === card) return card;
    const held = trusted.get(card);
    if (held && held.publisher === record.publisher) return held;
    trusted.set(card, record);
    return record;
  };
  const rebuild = () => {
    const nextUrls = new Map<string, PullRecord>();
    const nextRoots = new Map<string, PullRecord>();
    const hooks = new Map<string, Hook>();
    const events = [...synced.values()].flatMap(
      ({ view }) => view.snapshot().events,
    );
    for (const event of events) {
      const hook = parseHook(event);
      const channel = event.tags.find((entry) => entry[0] === "h")?.[1];
      if (hook && channel) hooks.set(`${channel}\0${hook.d}`, hook);
    }
    const hookOf = (channel: string, d: string) =>
      hooks.get(`${channel}\0${d}`);
    for (const event of events) {
      const card = cardOf(event);
      const vouched =
        card && trust(card, event.pubkey, session.relayAuthor, hookOf);
      if (!card || !vouched) continue;
      const record = stable(card, vouched);
      const key = keyOf(record.pull.url);
      const held = key ? nextUrls.get(key) : undefined;
      if (
        key &&
        !record.publisher &&
        (!held || held.createdAt < record.createdAt)
      )
        nextUrls.set(key, record);
      if (record.root) {
        const at = rootKey(record.root, writerOf(record));
        const rooted = nextRoots.get(at);
        if (!rooted || rooted.createdAt < record.createdAt)
          nextRoots.set(at, record);
      }
    }
    const same = (a: Map<string, PullRecord>, b: Map<string, PullRecord>) =>
      a.size === b.size &&
      [...a].every(([key, record]) => b.get(key) === record);
    if (same(urls, nextUrls) && same(roots, nextRoots)) return;
    urls = nextUrls;
    roots = nextRoots;
    for (const listener of [...listeners]) listener();
  };
  const release = (channel: string) => {
    const entry = synced.get(channel);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.stop();
    entry.view.dispose();
    synced.delete(channel);
    rebuild();
  };
  return {
    watch(channel) {
      let entry = synced.get(channel);
      if (!entry) {
        try {
          const view = session.artifacts.sync({
            artifact: "current",
            kinds: [ARTIFACT_REVISION_KIND],
            "#h": [channel],
            "#type": [PULL_TYPE, HOOK_TYPE],
          });
          entry = { view, stop: view.subscribe(rebuild), readers: 0 };
          synced.set(channel, entry);
        } catch {
          return () => {};
        }
      }
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.readers++;
      let released = false;
      const held = entry;
      return () => {
        if (released) return;
        released = true;
        if (--held.readers) return;
        held.timer = setTimeout(() => release(channel), SYNC_LINGER_MS);
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    byUrl: (url) => urls.get(url),
    byRoot: (id, author) => roots.get(rootKey(id, author)),
    dispose() {
      for (const channel of [...synced.keys()]) release(channel);
      listeners.clear();
    },
  };
}

export type PullSources = PullSource &
  Readonly<{
    /** The selected community's store, or undefined while none is ready. */
    selected(): RelayPulls | undefined;
    dispose(): void;
  }>;

/** The pull requests of whichever community the app has selected: the
 * source the store consults before GitHub, and the cards' own. */
export function createPullSources(relay: RelayData): PullSources {
  const listeners = new Set<() => void>();
  const stores = new Map<RelaySession, { pulls: RelayPulls; stop(): void }>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const selected = () => {
    const snapshot = relay.snapshot();
    if (snapshot.status !== "ready") return undefined;
    let store = stores.get(snapshot.session);
    if (!store) {
      for (const [session, old] of stores) {
        old.stop();
        old.pulls.dispose();
        stores.delete(session);
      }
      const pulls = createRelayPulls(snapshot.session);
      store = { pulls, stop: pulls.subscribe(changed) };
      stores.set(snapshot.session, store);
    }
    return store.pulls;
  };
  return {
    selected,
    get(url, details) {
      const record = selected()?.byUrl(url);
      return record ? pullStateOf(record.pull, details) : undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      const stop = relay.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    dispose() {
      for (const { pulls, stop } of stores.values()) {
        stop();
        pulls.dispose();
      }
      stores.clear();
      listeners.clear();
    },
  };
}
