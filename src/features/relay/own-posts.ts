import { CHANNEL_ACTIVITY_KINDS, channelOf } from "./channel-activity";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";

/** Own messages read at startup. Newest first, so a very busy account may not
 * see its oldest conversations; live sends still add theirs. */
export const OWN_POSTS_LIMIT = 500;

export type OwnPostsState = Readonly<{
  /** `ready` is the only state whose `channels` is complete. */
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  /** Channels the viewer has posted in. */
  channels: ReadonlySet<string>;
}>;

/** The channels the viewer has posted in: one read of their own recent
 * messages, then live additions as the session verifies more of them (an
 * accepted send, its echo, or a post from another device). Memory only. */
export function createOwnPosts({
  viewer,
  reader,
  notify = (listener: () => void) => listener(),
}: {
  viewer: string;
  reader: Pick<RelayReader, "read"> | undefined;
  notify?: (listener: () => void) => void;
}) {
  const unavailable = !reader || !viewer;
  const empty = (): OwnPostsState =>
    Object.freeze({
      status: unavailable ? "unavailable" : "idle",
      channels: new Set<string>(),
    });
  let state = empty();
  /** Additions seen before the read finished, which its result may predate. */
  const seen = new Set<string>();
  let generation = 0;
  let closed = false;
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: OwnPostsState) => {
    state = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  };
  const posted = (events: readonly RelayEvent[]) =>
    events.flatMap((event) => {
      const id = channelOf(event);
      return id &&
        event.pubkey === viewer &&
        CHANNEL_ACTIVITY_KINDS.includes(event.kind as never)
        ? [id]
        : [];
    });
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Verified events from any source; only the viewer's own messages count. */
    accept(events: readonly RelayEvent[]) {
      if (closed || unavailable) return;
      const added = posted(events).filter((id) => !state.channels.has(id));
      for (const id of added) seen.add(id);
      if (added.length && state.status === "ready")
        publish({
          ...state,
          channels: new Set([...state.channels, ...added]),
        });
    },
    /** Starts the one read; a failure can be retried by calling again. */
    ensure(): Promise<void> {
      if (closed || unavailable) return Promise.resolve();
      if (active) return active.done;
      if (state.status === "ready") return Promise.resolve();
      const controller = new AbortController();
      const epoch = ++generation;
      publish({ ...state, status: "loading" });
      const done = reader
        .read(
          [
            {
              kinds: [...CHANNEL_ACTIVITY_KINDS],
              authors: [viewer],
              limit: OWN_POSTS_LIMIT,
            },
          ],
          { signal: controller.signal, priority: "background" },
        )
        .then(
          (events) => {
            if (closed || epoch !== generation) return;
            publish({
              status: "ready",
              channels: new Set([...posted(events), ...seen]),
            });
          },
          () => {
            if (closed || epoch !== generation) return;
            publish({ ...state, status: "error" });
          },
        )
        .finally(() => {
          if (active?.controller === controller) active = undefined;
        });
      active = { controller, done };
      return done;
    },
    /** Access loss or a cache purge: forget everything and read again on demand. */
    clear() {
      if (closed) return;
      generation++;
      active?.controller.abort();
      active = undefined;
      seen.clear();
      publish(empty());
    },
    dispose() {
      closed = true;
      generation++;
      active?.controller.abort();
      active = undefined;
      seen.clear();
      listeners.clear();
    },
  };
}
