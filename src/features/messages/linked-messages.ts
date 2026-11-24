import { parseBuzzLink } from "../navigation/buzz-links";
import type { ChannelMessage } from "../relay/contracts";
import { foldMessages } from "../relay/fold";
import type { Priority } from "../relay/reader";
import type { RelaySession } from "../relay/session";
import { previewMessageLinks } from "./preview-links";

/** Linked messages each session last read, so a card shows its message at
 * once: on a remount, as every row does on a channel switch, or when a
 * prefetch already read it. Only the newest `CACHED_MESSAGES` stay. */
export const CACHED_MESSAGES = 500;
/** Message ids one prefetch read asks for. */
export const PREFETCH_BATCH = 50;
// Links a read answered without a message, or failed to read, so a prefetch
// never asks again; the card's own read still decides what it shows.
const MISSED = 2000;

type Want = { channelId: string; messageId: string; priority: Priority };
type Store = {
  messages: Map<string, ChannelMessage>;
  listeners: Set<() => void>;
  pending: Map<string, Want>;
  loading: Map<string, Priority>;
  missed: Set<string>;
  scheduled: boolean;
  watching: boolean;
};

const stores = new WeakMap<RelaySession, Store>();

function store(session: RelaySession) {
  let owned = stores.get(session);
  if (!owned) {
    owned = {
      messages: new Map(),
      listeners: new Set(),
      pending: new Map(),
      loading: new Map(),
      missed: new Set(),
      scheduled: false,
      watching: false,
    };
    stores.set(session, owned);
  }
  return owned;
}

export const linkedMessageKey = (channelId: string, messageId: string) =>
  `${channelId}:${messageId}`;

export function cachedLinkedMessage(session: RelaySession, key: string) {
  return stores.get(session)?.messages.get(key);
}

export function subscribeLinkedMessages(
  session: RelaySession,
  listener: () => void,
) {
  const { listeners } = store(session);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keeps a read's message for the next card that shows it, or forgets it
 * once a read finds it gone. */
export function rememberLinkedMessage(
  session: RelaySession,
  key: string,
  message: ChannelMessage | undefined,
) {
  const owned = store(session);
  const previous = owned.messages.get(key);
  owned.messages.delete(key);
  if (message) {
    owned.messages.set(key, message);
    for (const oldest of owned.messages.keys()) {
      if (owned.messages.size <= CACHED_MESSAGES) break;
      owned.messages.delete(oldest);
    }
  }
  if (previous !== message) for (const listener of owned.listeners) listener();
}

/** Reads the messages `urls` link to, many in one relay read, so their cards
 * have them before they show. `foreground` is for cards about to be seen;
 * everything speculative waits behind the reader's other work. */
export function prefetchLinkedMessages(
  session: RelaySession,
  urls: readonly string[],
  priority: Priority,
) {
  if (!urls.length) return;
  const owned = store(session);
  for (const url of urls) {
    const link = parseBuzzLink(url);
    if (link?.format !== "legacy" || !link.messageId) continue;
    const key = linkedMessageKey(link.channelId, link.messageId);
    if (owned.messages.has(key) || owned.missed.has(key)) continue;
    const loading = owned.loading.get(key);
    if (loading === "foreground" || loading === priority) continue;
    const pending = owned.pending.get(key);
    if (pending?.priority === "foreground") continue;
    owned.pending.set(key, {
      channelId: link.channelId,
      messageId: link.messageId,
      priority,
    });
  }
  if (owned.scheduled || !owned.pending.size) return;
  owned.scheduled = true;
  // Links that rows, the timeline and the composer name in one render share
  // one read.
  queueMicrotask(() => flush(session, owned));
}

/** Prefetches every message link in `contents`, as their cards would show
 * them. */
export function prefetchLinkedMessagesIn(
  session: RelaySession,
  contents: Iterable<string>,
  priority: Priority,
) {
  const urls: string[] = [];
  for (const content of contents) urls.push(...previewMessageLinks(content));
  prefetchLinkedMessages(session, urls, priority);
}

/** Prefetches the links in messages as they arrive in any channel, so a
 * channel opened later already has its cards. Once per session. */
export function watchLinkedMessages(session: RelaySession) {
  const owned = store(session);
  if (owned.watching || !session.subscribeLive) return;
  owned.watching = true;
  session.subscribeLive(({ events }) => {
    prefetchLinkedMessagesIn(
      session,
      events.flatMap((event) => (event.kind === 9 ? [event.content] : [])),
      "background",
    );
  });
}

function flush(session: RelaySession, owned: Store) {
  owned.scheduled = false;
  const wants = [...owned.pending.values()];
  owned.pending.clear();
  for (const priority of ["foreground", "background"] as const) {
    const chosen = wants.filter((want) => want.priority === priority);
    for (let at = 0; at < chosen.length; at += PREFETCH_BATCH)
      void read(
        session,
        owned,
        chosen.slice(at, at + PREFETCH_BATCH),
        priority,
      );
  }
}

async function read(
  session: RelaySession,
  owned: Store,
  wants: readonly Want[],
  priority: Priority,
) {
  const keys = wants.map((want) =>
    linkedMessageKey(want.channelId, want.messageId),
  );
  for (const key of keys) owned.loading.set(key, priority);
  const ids = [...new Set(wants.map((want) => want.messageId))];
  try {
    // The messages and what changes them, as a card's own read folds them:
    // deletions and edits. The session's access checks drop any channel the
    // reader can't see.
    const events = await session.read(
      [
        { ids, limit: ids.length },
        { kinds: [5, 9005, 40003], "#e": ids, limit: 500 },
      ],
      { priority },
    );
    const authors = new Set<string>();
    for (const want of wants) {
      const key = linkedMessageKey(want.channelId, want.messageId);
      if (owned.messages.has(key)) continue;
      const message = foldMessages(
        want.channelId,
        session.relayAuthor ?? "",
        events,
        {
          includeReplies: true,
          signingAuthority: session.workflowAuthority,
          agentOwner: session.profiles.owner,
        },
      ).find((row) => row.id === want.messageId);
      if (!message) {
        miss(owned, key);
        continue;
      }
      authors.add(message.workflowOwnerId ?? message.authorId);
      rememberLinkedMessage(session, key, message);
    }
    // A card names its author; read who that is alongside.
    if (authors.size)
      void session.profiles.ensure([...authors], priority).catch(() => {});
  } catch {
    for (const key of keys) miss(owned, key);
  } finally {
    for (const key of keys)
      if (owned.loading.get(key) === priority) owned.loading.delete(key);
  }
}

function miss(owned: Store, key: string) {
  owned.missed.add(key);
  for (const oldest of owned.missed) {
    if (owned.missed.size <= MISSED) break;
    owned.missed.delete(oldest);
  }
}
