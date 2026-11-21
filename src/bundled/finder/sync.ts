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

export type FinderSyncStatus = Readonly<{
  phase: "waiting" | "filling" | "ready" | "error";
  indexed: number;
  error?: string | undefined;
}>;

type Raw = { event: RelayEvent; rootId?: string | undefined };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
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
}: {
  session: RelaySession;
  corpus: FinderCorpus;
  /** The corpus or the status changed. */
  changed: () => void;
}) {
  // A session always has its viewer; the type allows none before sign-in.
  const viewer = session.viewer ?? "";
  const controller = new AbortController();
  const { signal } = controller;
  const since = Math.floor(Date.now() / 1000) - DAYS * 86_400;
  const raw = new Map<string, Raw>();
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
  const docOf = ({ event, rootId }: Raw): FinderDoc => ({
    id: event.id,
    channelId: event.tags.find(([name]) => name === "h")?.[1] ?? "",
    threadRootId: rootId,
    authorId: event.pubkey,
    createdAt: event.created_at,
    author: event.pubkey === viewer ? "You" : nameOf(event.pubkey),
    place: placeOf(event.tags.find(([name]) => name === "h")?.[1] ?? ""),
    text: searchText(event).replace(/\s+/g, " ").trim(),
  });

  /** Anything the app receives from a conversation you belong to: live
   * traffic and what you scroll past, at no extra relay cost. Previews of
   * channels you haven't joined and huddle rooms stay out. */
  const relevant = (event: RelayEvent) => {
    const found = channel(event.tags.find(([name]) => name === "h")?.[1] ?? "");
    return !!found && !found.readOnly && !found.huddle;
  };
  const take = (events: readonly RelayEvent[], force = false) => {
    const added: FinderDoc[] = [];
    for (const event of events) {
      if (!KINDS.includes(event.kind) || event.created_at < since) continue;
      if (raw.has(event.id)) continue;
      const rootId = threadReference(event)?.rootId;
      if (event.pubkey === viewer && rootId) roots.add(rootId);
      if (!force && !relevant(event)) continue;
      const entry = { event, rootId };
      raw.set(event.id, entry);
      added.push(docOf(entry));
    }
    if (added.length) {
      corpus.add(added);
      void session.profiles
        .ensure([...new Set(added.map((doc) => doc.authorId))], "background")
        .catch(() => {});
      publish({});
    }
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
      take(page, true);
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
            name === "e" &&
            value &&
            raw.get(value)?.event.pubkey === event.pubkey
              ? [value]
              : [],
          ),
        ),
    );
    if (deleted.size) {
      for (const id of deleted) raw.delete(id);
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
        [...raw.values()]
          .map(({ event }) => event.tags.find(([n]) => n === "h")?.[1] ?? "")
          .filter((id) => !channel(id)),
      );
      if (gone.size) {
        for (const [id, entry] of raw)
          if (gone.has(entry.event.tags.find(([n]) => n === "h")?.[1] ?? ""))
            raw.delete(id);
        corpus.remove((doc) => gone.has(doc.channelId));
      }
    }
    corpus.add([...raw.values()].map(docOf));
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
