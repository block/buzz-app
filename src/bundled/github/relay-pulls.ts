// The pull requests the relay follows for the channels shown: each channel's
// current `buzz.github.pull` artifacts, kept current by NIP-AR sync and
// trusted only when the relay itself signed them.
import type { VerifiedEvent } from "nostr-tools";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ARTIFACT_REVISION_KIND } from "../../features/relay/artifact-sync";
import { keyOf, type PullSource } from "./pull-states";
import {
  PULL_TYPE,
  parseRecord,
  pullStateOf,
  type PullRecord,
} from "./relay-pull";

/** How long a channel's sync outlives its last reader, so a timeline that
 * scrolls a card away and back does not start it again. */
export const SYNC_LINGER_MS = 60_000;

export type RelayPulls = Readonly<{
  /** Syncs `channel`'s pull requests while watched, and a while after. */
  watch(channel: string): () => void;
  subscribe(listener: () => void): () => void;
  /** The newest pull request record for a canonical URL. */
  byUrl(url: string): PullRecord | undefined;
  /** The record rooted on the relay's announcement `id`. */
  byRoot(id: string): PullRecord | undefined;
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
  const parsed = new WeakMap<VerifiedEvent, PullRecord | null>();
  let urls = new Map<string, PullRecord>();
  let roots = new Map<string, PullRecord>();
  const recordOf = (event: VerifiedEvent) => {
    let record = parsed.get(event);
    if (record === undefined) {
      record = parseRecord(event, session.relayAuthor) ?? null;
      parsed.set(event, record);
    }
    return record ?? undefined;
  };
  const rebuild = () => {
    const nextUrls = new Map<string, PullRecord>();
    const nextRoots = new Map<string, PullRecord>();
    for (const { view } of synced.values())
      for (const event of view.snapshot().events) {
        const record = recordOf(event);
        if (!record) continue;
        const key = keyOf(record.pull.url);
        const held = key ? nextUrls.get(key) : undefined;
        if (key && (!held || held.createdAt < record.createdAt))
          nextUrls.set(key, record);
        if (record.root) nextRoots.set(record.root, record);
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
            "#type": [PULL_TYPE],
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
    byRoot: (id) => roots.get(id),
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
