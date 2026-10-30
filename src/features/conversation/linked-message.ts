import { useEffect, useSyncExternalStore } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import { workflowLabel } from "../relay/workflow-attribution";

/** The linked message in an exact thread view. Only reconciled content is
 * ready: a ready exact target is independent of its thread root, while an
 * idle/loading root seed is still the raw event. A terminal state (read error,
 * denied/interrupted purge, or an exhausted read that never found the target)
 * stops instead of loading forever. */
export function linkedMessage(snapshot: ThreadSnapshot, messageId: string) {
  const target =
    snapshot.target?.id === messageId ? snapshot.target : undefined;
  const message =
    target ??
    [snapshot.root, ...snapshot.replies].find((row) => row?.id === messageId);
  const stopped =
    snapshot.status === "error" ||
    snapshot.targetStatus === "error" ||
    snapshot.targetStatus === "unavailable" ||
    (snapshot.status === "idle" && snapshot.error !== undefined) ||
    (snapshot.status === "ready" && !message && !snapshot.canLoadMore);
  const ready =
    !!message &&
    (target ? snapshot.targetStatus === "ready" : snapshot.status === "ready");
  return { message, ready, stopped };
}

/** Who a message is shown under: its author, or the owner a workflow ran for. */
type Author = Readonly<{ id: string; workflow: boolean }>;

// Link lookups share the session's bounded thread readers with open threads
// and previews, so only a few run at once.
const concurrent = 4;
const authors = new WeakMap<RelaySession, ReturnType<typeof lookups>>();
const noop = () => () => {};

/** One session's linked-message authors. An author never changes, so a found
 * one is kept for the session; a failed lookup is retried only once every
 * link that wanted it has unmounted. */
function lookups(session: RelaySession) {
  const found = new Map<string, Author>();
  const wanted = new Map<
    string,
    { channelId: string; messageId: string; links: number; failed: boolean }
  >();
  const running = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  let scheduled = false;
  // After the commit that mounted or released links, so links that unmount
  // together never start each other's lookups on the way out.
  function pump() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const [key, want] of wanted) {
        if (running.size >= concurrent) break;
        if (!want.failed && !running.has(key)) start(key, want);
      }
    });
  }
  function start(
    key: string,
    want: { channelId: string; messageId: string; failed: boolean },
  ) {
    let view: ThreadView | undefined;
    let unsubscribe = () => {};
    const settle = (author?: Author) => {
      if (!running.delete(key)) return;
      unsubscribe();
      view?.dispose();
      if (author) {
        found.set(key, author);
        wanted.delete(key);
        for (const listener of listeners) listener();
      } else want.failed = true;
      pump();
    };
    running.set(key, settle);
    try {
      view = session.thread(want.channelId, want.messageId, { exact: true });
    } catch {
      settle();
      return;
    }
    const owned = view;
    const check = () => {
      const { message, ready, stopped } = linkedMessage(
        owned.snapshot(),
        want.messageId,
      );
      if (ready && message)
        settle({
          id: message.workflowOwnerId ?? message.authorId,
          workflow: !!message.workflowOwnerId,
        });
      else if (stopped) settle();
    };
    unsubscribe = owned.subscribe(check);
    check();
    if (running.has(key)) void owned.refresh();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: (key: string) => found.get(key),
    /** Held by a mounted link; the last release cancels its lookup. */
    want(channelId: string, messageId: string) {
      const key = `${channelId}:${messageId}`;
      if (found.has(key)) return () => {};
      const want = wanted.get(key) ?? {
        channelId,
        messageId,
        links: 0,
        failed: false,
      };
      want.links++;
      wanted.set(key, want);
      pump();
      return () => {
        if (--want.links || wanted.get(key) !== want) return;
        wanted.delete(key);
        running.get(key)?.();
      };
    },
  };
}

/** "<author> in #<channel>" for a link to a message in a listed channel, once
 * the session has read who wrote it. Undefined while that is unknown, and for
 * DMs and Solo chats, which keep their existing presentation. */
export function useLinkedMessageByline(
  session: RelaySession | undefined,
  channelId: string | undefined,
  messageId: string | undefined,
) {
  const channel = useListedChannel(
    messageId ? session?.channels : undefined,
    channelId,
    (channel) =>
      channel && channel.channelType !== "dm" && channel.channelType !== "solo"
        ? channel.name
        : "",
  );
  const owner = session && channel ? authorsFor(session) : undefined;
  const key = `${channelId}:${messageId}`;
  const author = useSyncExternalStore(
    owner?.subscribe ?? noop,
    () => owner?.get(key),
    () => undefined,
  );
  useEffect(() => {
    if (owner && channelId && messageId && !author)
      return owner.want(channelId, messageId);
  }, [owner, channelId, messageId, author]);
  const resolveName = useChannelIdentityNames(author && session, channelId);
  const profileName = useSyncExternalStore(
    (author && session?.profiles.subscribe) || noop,
    () => {
      const profile = author && session?.profiles.snapshot().get(author.id);
      return profile && !profile.nameIsFallback ? profile.name : "";
    },
    () => "",
  );
  useEffect(() => {
    if (author && session)
      void session.profiles.ensure([author.id], "background").catch(() => {});
  }, [session, author]);
  // An author with no name yet keeps the channel presentation, never a key.
  const name = author ? resolveName(author.id, profileName) : "";
  if (!channel || !name) return undefined;
  return `${author?.workflow ? workflowLabel(name) : name} in #${channel}`;
}

function authorsFor(session: RelaySession) {
  const owner = authors.get(session) ?? lookups(session);
  authors.set(session, owner);
  return owner;
}
