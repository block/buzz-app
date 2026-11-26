import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  SEARCH_KINDS,
  type SearchMessage,
  searchMessage,
} from "../../app/shell/useSearchMessages";
import type { EventData } from "../relay/events";
import { deletionApplies } from "../relay/fold";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { createCorpus, type FinderDoc } from "./fuzzy/corpus.ts";

/** Device rows ⌘K shows above the relay's (C1). */
export const DEVICE_ROWS = 20;

/** Most messages the device index holds; past it, the oldest leave. */
export const DEVICE_MESSAGES_CAP = 50_000;

/** Whether `channelId`'s messages belong in the device index: a channel you
 * belong to, not a huddle room or a preview of one you haven't joined. */
export function deviceSearchable(session: RelaySession, channelId: string) {
  const found = session.channels.get?.(channelId);
  return (
    !!found &&
    !found.huddle &&
    !found.cached &&
    (!found.readOnly || found.viewerRole === "guest")
  );
}

/** Whether the viewer has lost `channelId`: the channel list is loaded and
 * the channel is gone from it, or is private and no longer theirs. */
function lost(session: RelaySession, channelId: string) {
  const found = session.channels.get?.(channelId);
  if (!found) {
    const list = session.channels.list();
    // A capped roster read's omissions don't prove removal; a revocation does.
    return (
      list.status === "ready" &&
      (list.coverage !== "partial" || !!session.channels.revoked?.(channelId))
    );
  }
  return !deviceSearchable(session, channelId);
}

function placeOf(session: RelaySession, channelId: string) {
  const found = session.channels.get?.(channelId);
  if (!found) return "Conversation";
  if (found.channelType === "dm") return found.name || "Direct message";
  return found.channelType === "stream" || found.channelType === "forum"
    ? `#${found.name}`
    : found.name || "Conversation";
}

function authorOf(session: RelaySession, authorId: string) {
  return authorId === session.viewer
    ? "You"
    : (session.profiles.snapshot().get(authorId)?.name ??
        authorId.slice(0, 10));
}

/** A message as the fuzzy index holds it, named by who wrote it and where,
 * so "maya deploy" finds Maya's message. */
function docOf(session: RelaySession, message: SearchMessage): FinderDoc {
  return {
    id: message.id,
    channelId: message.channelId,
    threadRootId: message.threadRootId,
    authorId: message.authorId,
    createdAt: message.createdAt,
    author: authorOf(session, message.authorId),
    place: placeOf(session, message.channelId),
    text: message.text.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Messages this device already received, searchable on every key. It is fed
 * only by what the session receives anyway: live traffic in channels you're
 * in, and the history of channels and threads you open. It reads nothing
 * from the relay. A dropped connection or a new session empties it, since
 * deletions made meanwhile may never arrive; so do signing out, a refusal,
 * or another account or community.
 */
export function startDeviceIndex(relay: RelayData, cap = DEVICE_MESSAGES_CAP) {
  const corpus = createCorpus();
  const messages = new Map<string, SearchMessage>();
  /** The indexed events without their text, to judge later deletions. */
  const signed = new Map<string, EventData>();
  /** Deletions seen, by the ID they name. */
  const tombstones = new Map<string, EventData[]>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const changed = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const clear = () => {
    corpus.clear();
    messages.clear();
    signed.clear();
    tombstones.clear();
    changed();
  };

  function attach(session: RelaySession) {
    /** The names rows were indexed with, by author and by channel. */
    const authors = new Map<string, string>();
    const places = new Map<string, string>();
    const deleted = (event: EventData) =>
      !!tombstones
        .get(event.id)
        ?.some((deletion) =>
          deletionApplies(deletion, event, session.relayAuthor),
        );
    // Passive: connecting doesn't read the view from the relay.
    const view = session.observe(
      [{ kinds: [...SEARCH_KINDS, 5, 9005], limit: 500 }],
      { passive: true },
    );
    // Deletions are applied before the messages beside them are taken, and
    // kept, so a message that arrives again later stays out.
    const observed = () => {
      const { events } = view.snapshot();
      const gone = new Set<string>();
      for (const event of events) {
        if (event.kind !== 5 && event.kind !== 9005) continue;
        for (const [name, id] of event.tags) {
          if (name !== "e" || !id) continue;
          const known = tombstones.get(id) ?? [];
          if (known.some((deletion) => deletion.id === event.id)) continue;
          tombstones.set(id, [...known, event]);
          const target = signed.get(id);
          if (target && deleted(target)) gone.add(id);
        }
      }
      for (const id of gone) {
        messages.delete(id);
        signed.delete(id);
      }
      if (gone.size) corpus.remove((doc) => gone.has(doc.id));
      const added: FinderDoc[] = [];
      for (const event of events) {
        if (messages.has(event.id) || deleted(event)) continue;
        const message = searchMessage(session, event);
        if (!message || !deviceSearchable(session, message.channelId)) continue;
        messages.set(message.id, message);
        signed.set(message.id, {
          id: event.id,
          kind: event.kind,
          pubkey: event.pubkey,
          created_at: event.created_at,
          content: "",
          tags: event.tags,
        });
        authors.set(message.authorId, authorOf(session, message.authorId));
        places.set(message.channelId, placeOf(session, message.channelId));
        added.push(docOf(session, message));
      }
      if (added.length) corpus.add(added);
      // Past the cap, the oldest leave, down to 90% so a sort runs once per
      // tenth of the cap rather than on every message.
      if (messages.size > cap) {
        const oldest = new Set(
          [...messages.values()]
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, messages.size - Math.floor(cap * 0.9))
            .map((m) => m.id),
        );
        for (const id of oldest) {
          messages.delete(id);
          signed.delete(id);
        }
        corpus.remove((doc) => oldest.has(doc.id));
      }
      if (gone.size || added.length) changed();
    };
    // Lost access drops the channel's messages at once, so nothing from it
    // can be shown or opened.
    const evict = () => {
      if (session.channels.list().status !== "ready") return;
      const channels = new Set([...messages.values()].map((m) => m.channelId));
      const gone = new Set(
        [...channels].filter(
          (id) => !deviceSearchable(session, id) && lost(session, id),
        ),
      );
      if (!gone.size) return;
      for (const [id, message] of messages)
        if (gone.has(message.channelId)) {
          messages.delete(id);
          signed.delete(id);
        }
      corpus.remove((doc) => gone.has(doc.channelId));
      changed();
    };
    // Names arriving relabel rows within a second, for author and place
    // matches. Only rows whose author or place name changed are redone.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const relabel = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        const renamed = (labels: Map<string, string>, of: typeof authorOf) => {
          const ids = new Set<string>();
          for (const [id, label] of labels) {
            const now = of(session, id);
            if (now === label) continue;
            labels.set(id, now);
            ids.add(id);
          }
          return ids;
        };
        const authorIds = renamed(authors, authorOf);
        const channelIds = renamed(places, placeOf);
        if (!authorIds.size && !channelIds.size) return;
        corpus.add(
          [...messages.values()]
            .filter(
              (m) => authorIds.has(m.authorId) || channelIds.has(m.channelId),
            )
            .map((m) => docOf(session, m)),
        );
        changed();
      }, 1000);
    };
    const stopView = view.subscribe(observed);
    const stopList = session.channels.subscribeList(() => {
      evict();
      relabel();
    });
    const stopProfiles = session.profiles.subscribe(relabel);
    // Deletions made while the live connection was down may never arrive,
    // so a drop keeps only what the view still holds, as the session does.
    let connected = session.live.snapshot().status === "connected";
    const stopLive = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (connected && !now) {
        corpus.clear();
        messages.clear();
        signed.clear();
        observed();
        changed();
      }
      connected = now;
    });
    observed();
    return () => {
      clearTimeout(pending);
      stopLive();
      stopView();
      view.dispose();
      stopList();
      stopProfiles();
    };
  }

  let attached: { key: string; dispose(): void } | undefined;
  const sync = () => {
    const snapshot = relay.snapshot();
    const key =
      snapshot.status === "ready" && !snapshot.cached && !snapshot.denied
        ? `${snapshot.scope ?? ""}:${snapshot.generation}`
        : "";
    if (key === attached?.key) return;
    if (attached) {
      attached.dispose();
      attached = undefined;
      clear();
    }
    if (key) attached = { key, dispose: attach(snapshot.session) };
  };
  const stop = relay.subscribe(sync);
  sync();

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    /** The best device matches for `query`, in `channelId` when given. */
    search(query: string, limit: number, channelId?: string) {
      return corpus
        .search(query, limit, channelId)
        .hits.flatMap(({ doc }) => messages.get(doc.id) ?? []);
    },
    /** Still indexed: not deleted, and its channel not lost. */
    has: (id: string) => messages.has(id),
    dispose() {
      stop();
      attached?.dispose();
      attached = undefined;
      clear();
    },
  };
}
export type DeviceIndex = ReturnType<typeof startDeviceIndex>;

/** The device index while `enabled`, for as long as the caller is mounted. */
export function useDeviceIndex(relay: RelayData | undefined, enabled: boolean) {
  const [index, setIndex] = useState<DeviceIndex>();
  useEffect(() => {
    if (!relay || !enabled) return;
    const started = startDeviceIndex(relay);
    setIndex(started);
    return () => {
      started.dispose();
      setIndex(undefined);
    };
  }, [relay, enabled]);
  return index;
}

const noSubscribe = () => () => {};
const noRevision = () => 0;
/** The device's best matches for `text`, again as the index changes. */
export function useDeviceMessages(
  index: DeviceIndex | undefined,
  text: string,
  channelId: string | undefined,
) {
  const revision = useSyncExternalStore(
    index?.subscribe ?? noSubscribe,
    index?.revision ?? noRevision,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision names the index contents.
  return useMemo(
    () => (index && text ? index.search(text, DEVICE_ROWS, channelId) : []),
    [index, text, channelId, revision],
  );
}
