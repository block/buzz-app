import { searchText } from "../../app/shell/useSearchMessages";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { threadReference } from "../../features/relay/thread-reference";
import type { FinderCorpus, FinderDoc } from "./corpus.ts";

const KINDS = [9, 40002];
const DAYS = 90;
const PAGE = 500;
/** Pause between pages, so a first fill never floods the relay. */
const PACE_MS = 300;
const BACKOFF_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
/** After the first fill, the newest page of each channel you visit and
 * search most: at most 16 background reads per session. Many channels one
 * page deep find more than a few channels read deeper, since most searches
 * are for recent messages (src/bundled/finder/readahead-bench.ts). */
const WARM_CHANNELS = 16;
const WARM_PAGES = 1;

export type FinderSyncStatus = Readonly<{
  phase: "waiting" | "filling" | "ready" | "error";
  indexed: number;
  error?: string | undefined;
}>;

export type ChannelSearchStatus = Readonly<{
  oldest?: number | undefined;
  complete: boolean;
  capped: boolean;
  loading: boolean;
  error: boolean;
  available: boolean;
}>;

type ChannelCursor = { until: number; before_id: string };
type ChannelProgress = {
  cursor?: ChannelCursor;
  complete: boolean;
  opening?: object;
  pages: number;
  budget: number;
  /** The page read under way; the next waits for it, so readers share one
   * cursor without skipping or repeating a page. */
  reading?: Promise<unknown>;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

const chunks = <T>(items: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
    items.slice(n * size, n * size + size),
  );

/** Fills `corpus` with the viewer's own conversations from the last 90
 * days, then keeps it current from what the session already receives. */
export function startFinderSync({
  session,
  corpus,
  changed,
  warm = () => [],
}: {
  session: RelaySession;
  corpus: FinderCorpus;
  /** The corpus or the status changed. */
  changed: () => void;
  /** Channel ids worth reading ahead, most wanted first. */
  warm?: () => readonly string[];
}) {
  // A session always has its viewer; the type allows none before sign-in.
  const viewer = session.viewer ?? "";
  const controller = new AbortController();
  const { signal } = controller;
  const since = Math.floor(Date.now() / 1000) - DAYS * 86_400;
  const docs = new Map<string, FinderDoc>();
  const cursors = new Map<string, ChannelProgress>();
  const progressOf = (channelId: string) => {
    let progress = cursors.get(channelId);
    if (!progress) {
      progress = { complete: false, pages: 0, budget: 10 };
      cursors.set(channelId, progress);
    }
    return progress;
  };
  // Threads the viewer took part in, by root id.
  const roots = new Set<string>();
  let status: FinderSyncStatus = { phase: "waiting", indexed: 0 };
  const publish = (patch: Partial<FinderSyncStatus>) => {
    status = { ...status, ...patch, indexed: corpus.size };
    changed();
  };

  const channel = (id: string): ChannelSummary | undefined =>
    session.channels.get?.(id);
  const placeOf = (id: string) => {
    const found = channel(id);
    if (!found) return "Conversation";
    if (found.channelType === "dm") return found.name || "Direct message";
    return found.channelType === "stream" || found.channelType === "forum"
      ? `#${found.name}`
      : found.name || "Conversation";
  };
  const nameOf = (pubkey: string) =>
    session.profiles.snapshot().get(pubkey)?.name ?? pubkey.slice(0, 10);
  const docOf = (event: RelayEvent): FinderDoc => ({
    id: event.id,
    channelId: event.tags.find(([name]) => name === "h")?.[1] ?? "",
    threadRootId: threadReference(event)?.rootId,
    authorId: event.pubkey,
    createdAt: event.created_at,
    author: event.pubkey === viewer ? "You" : nameOf(event.pubkey),
    place: placeOf(event.tags.find(([name]) => name === "h")?.[1] ?? ""),
    text: searchText(event).replace(/\s+/g, " ").trim(),
  });

  /** Anything the app receives from a conversation you belong to: live
   * traffic and what you scroll past, at no extra relay cost. Previews of
   * channels you haven't joined and huddle rooms stay out. */
  const relevant = (channelId: string) => {
    const found = channel(channelId);
    return (
      !!found &&
      !found.huddle &&
      !found.cached &&
      (!found.readOnly || found.viewerRole === "guest")
    );
  };
  const remember = (added: readonly FinderDoc[]) => {
    if (signal.aborted || !added.length) return;
    // The search hook has no thread root. Keep fuller observed documents.
    const joined = added.filter(
      (doc) => relevant(doc.channelId) && !docs.has(doc.id),
    );
    if (!joined.length) return;
    for (const doc of joined) docs.set(doc.id, doc);
    corpus.add(joined);
    void session.profiles
      .ensure([...new Set(joined.map((doc) => doc.authorId))], "background")
      .catch(() => {});
    publish({});
  };
  const take = (events: readonly RelayEvent[], older = false) => {
    const added: FinderDoc[] = [];
    for (const event of events) {
      if (!KINDS.includes(event.kind) || (!older && event.created_at < since))
        continue;
      if (docs.has(event.id)) continue;
      const doc = docOf(event);
      if (event.pubkey === viewer && doc.threadRootId)
        roots.add(doc.threadRootId);
      added.push(doc);
    }
    remember(added);
  };

  /** The next older page of one channel, into the index. */
  const readOlder = (
    channelId: string,
    progress: ChannelProgress,
    bound: AbortSignal,
  ) => {
    const read = (progress.reading ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (progress.complete) return;
        const page = await session.readRemote(
          [
            {
              kinds: KINDS,
              "#h": [channelId],
              limit: PAGE,
              ...progress.cursor,
            },
          ],
          { signal: bound, priority: "background" },
        );
        bound.throwIfAborted();
        // Resolve ties in the relay's newest-first ID order.
        const oldest = [...page].sort(
          (a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id),
        )[0];
        if (oldest)
          progress.cursor = { until: oldest.created_at, before_id: oldest.id };
        progress.complete = page.length < PAGE;
        take(page, true);
      });
    progress.reading = read;
    return read;
  };

  /** One opening owns its budget and cancellation; only cursors outlive it.
   * Query edits wake the same reader instead of resetting its cursor or cap. */
  const searchChannel = (
    channelId: string,
    needsMore: () => boolean,
    report: (status: ChannelSearchStatus) => void,
    opening: object = {},
  ) => {
    const progress = progressOf(channelId);
    if (progress.opening !== opening) {
      progress.opening = opening;
      progress.pages = 0;
      progress.budget = 10;
    }
    const lifetime = new AbortController();
    const bound = AbortSignal.any([signal, lifetime.signal]);
    let running = false;
    let error = false;
    let delay = Math.random() * PACE_MS;
    const snapshot = (): ChannelSearchStatus => ({
      oldest: progress.cursor?.until,
      complete: progress.complete,
      capped: progress.pages >= progress.budget,
      loading: running,
      error,
      available: relevant(channelId),
    });
    const notify = () => {
      if (!bound.aborted) report(snapshot());
    };
    const wake = () => {
      if (running || bound.aborted) return;
      const needed = () =>
        relevant(channelId) &&
        !progress.complete &&
        progress.pages < progress.budget &&
        needsMore();
      if (!needed()) return notify();
      running = true;
      notify();
      void (async () => {
        let backoff = BACKOFF_MS;
        while (!bound.aborted && needed()) {
          await sleep(delay, bound);
          if (!needed()) break;
          try {
            await readOlder(channelId, progress, bound);
          } catch (failure) {
            if (bound.aborted) throw failure;
            error = true;
            notify();
            delay = backoff + Math.random() * 1000;
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          error = false;
          backoff = BACKOFF_MS;
          delay = PACE_MS;
          progress.pages++;
          notify();
        }
      })()
        .catch(() => {
          // Cancellation retires this opening, including a pending backoff.
        })
        .finally(() => {
          running = false;
          notify();
        });
    };
    wake();
    return {
      wake,
      keepGoing() {
        progress.budget += 10;
        wake();
      },
      dispose() {
        lifetime.abort();
      },
    };
  };

  /** Every page of `filter` back to the horizon, newest first. */
  async function readAll(filter: Omit<ReadFilter, "limit">) {
    let cursor: { until: number; before_id: string } | undefined;
    let delay = BACKOFF_MS;
    for (;;) {
      let page: readonly RelayEvent[];
      try {
        page = await session.readRemote(
          [{ ...filter, since, limit: PAGE, ...cursor }],
          { signal, priority: "background" },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        await sleep(delay + Math.random() * 1000, signal);
        delay = Math.min(delay * 2, BACKOFF_CAP_MS);
        continue;
      }
      delay = BACKOFF_MS;
      take(page);
      const oldest = [...page].sort(
        (a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id),
      )[0];
      if (!oldest || page.length < PAGE) return;
      cursor = { until: oldest.created_at, before_id: oldest.id };
      await sleep(PACE_MS, signal);
    }
  }

  async function fill() {
    // Start at a random moment, so a fleet reconnecting at once spreads out.
    await sleep(Math.random() * 3000, signal);
    await session.channels.ensureList?.();
    // What the app already loaded before the finder started.
    take(live.snapshot().events as readonly RelayEvent[]);
    publish({ phase: "filling" });
    await readAll({ kinds: KINDS, authors: [viewer] });
    await readAll({ kinds: KINDS, "#p": [viewer] });
    const dms = session.channels
      .list()
      .channels.filter((c) => c.channelType === "dm")
      .map((c) => c.id);
    for (const ids of chunks(dms, 50))
      await readAll({ kinds: KINDS, "#h": ids });
    // Replies in threads you replied in, and the roots themselves.
    for (const ids of chunks([...roots], 100)) {
      await readAll({ kinds: KINDS, "#e": ids });
      await readAll({ kinds: KINDS, ids });
    }
    publish({ phase: "ready" });
    // ponytail: a failed read ends the read-ahead; it is a head start, and
    // "This channel" reads the rest on demand.
    // Direct messages were read in full above.
    const wanted = warm().filter(
      (id) => relevant(id) && channel(id)?.channelType !== "dm",
    );
    for (const id of wanted.slice(0, WARM_CHANNELS)) {
      const progress = progressOf(id);
      for (let n = 0; n < WARM_PAGES && !progress.complete; n++) {
        await sleep(PACE_MS + Math.random() * PACE_MS, signal);
        try {
          await readOlder(id, progress, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return;
        }
      }
    }
  }

  // New messages the session receives anyway: live traffic and other reads.
  const live = session.observe([{ kinds: [...KINDS, 5], limit: PAGE }]);
  const stopLive = live.subscribe(() => {
    const events = live.snapshot().events as readonly RelayEvent[];
    const deleted = new Set(
      events
        .filter((event) => event.kind === 5)
        .flatMap((event) =>
          event.tags.flatMap(([name, value]) =>
            name === "e" && value && docs.get(value)?.authorId === event.pubkey
              ? [value]
              : [],
          ),
        ),
    );
    if (deleted.size) {
      for (const id of deleted) docs.delete(id);
      corpus.remove((doc) => deleted.has(doc.id));
      publish({});
    }
    take(events);
  });

  // Lost access drops the channel's messages; names arriving relabel rows.
  const relabel = () => {
    const list = session.channels.list();
    if (list.status === "ready") {
      const gone = new Set(
        [...docs.values()]
          .filter((doc) => !relevant(doc.channelId))
          .map((doc) => doc.channelId),
      );
      if (gone.size) {
        for (const [id, doc] of docs)
          if (gone.has(doc.channelId)) docs.delete(id);
        corpus.remove((doc) => gone.has(doc.channelId));
        for (const id of gone) cursors.delete(id);
      }
    }
    const relabeled = [...docs.values()].map((doc) => ({
      ...doc,
      author: doc.authorId === viewer ? "You" : nameOf(doc.authorId),
      place: placeOf(doc.channelId),
    }));
    for (const doc of relabeled) docs.set(doc.id, doc);
    corpus.add(relabeled);
    publish({});
  };
  let pending: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(pending);
    pending = setTimeout(relabel, 1000);
  };
  const stopList = session.channels.subscribeList(soon);
  const stopProfiles = session.profiles.subscribe(soon);

  fill().catch((error) => {
    if (!signal.aborted)
      publish({
        phase: "error",
        error: error instanceof Error ? error.message : "Indexing failed",
      });
  });

  return {
    status: () => status,
    searchChannel,
    remember,
    dispose() {
      controller.abort();
      clearTimeout(pending);
      stopLive();
      live.dispose();
      stopList();
      stopProfiles();
      corpus.clear();
    },
  };
}

export type FinderSync = ReturnType<typeof startFinderSync>;
