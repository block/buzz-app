import type { RelaySession } from "../relay/session";
import { formatPublicKey } from "../../shared/identity/public-key";

export type HuddleDiscussion = {
  version: number;
  historyLimited: boolean;
  status: "loading" | "ready" | "error";
  error?: string | undefined;
  writable: boolean;
  sending: boolean;
  sent: number;
  hasMore: boolean;
  rows: {
    id: string;
    author: string;
    picture: string | null;
    text: string;
    time: number;
    failed: boolean;
  }[];
};

/** One visible room reader. Delivery, membership and history remain session-owned. */
export function createHuddleDiscussion(
  session: RelaySession,
  room: string,
  parent: string,
  changed: () => void,
) {
  let disposed = false;
  let version = 0;
  let resolved = false;
  let sending = false;
  let sent = 0;
  let error: string | undefined;
  const controller = new AbortController();
  const notify = () => {
    if (!disposed) {
      version++;
      changed();
    }
  };
  const stop = session.channels.subscribeWindow(room, notify);
  const stopList = session.channels.subscribeList(notify);
  const stopProfiles = session.profiles.subscribe(notify);
  async function load() {
    error = undefined;
    try {
      await session.channels.resolve?.([room], { signal: controller.signal });
      if (disposed) return;
      const metadata =
        session.channels.get?.(room) ??
        session.channels.list().channels.find((c) => c.id === room);
      if (!metadata?.huddle || metadata.parentChannelId !== parent)
        throw new Error("Huddle identity unavailable");
      resolved = true;
      session.channels.ensure(room);
    } catch {
      if (!disposed)
        error =
          "Couldn’t verify this Huddle conversation. Older Huddles may not support this view.";
    }
    notify();
  }
  const channel = () =>
    session.channels.get?.(room) ??
    session.channels.list().channels.find((c) => c.id === room);
  const writable = () => {
    const c = channel();
    return (
      resolved &&
      !!c?.huddle &&
      c.parentChannelId === parent &&
      !c.archived &&
      !c.readOnly &&
      !c.cached
    );
  };
  void load();
  return {
    snapshot(): HuddleDiscussion {
      const window = session.channels.window(room);
      const profiles = session.profiles.snapshot();
      return {
        version,
        historyLimited:
          (window.rows.length >= 200 && window.hasMore) ||
          window.rows.length > 200,
        status:
          error || window.status === "error"
            ? "error"
            : !resolved || window.status !== "ready"
              ? "loading"
              : "ready",
        error: error ?? window.error,
        writable: writable(),
        sending,
        sent,
        hasMore: resolved && window.hasMore && window.rows.length < 200,
        rows: (resolved ? window.rows : [])
          .slice(-200)
          .filter((r) => !r.membership && !r.huddle)
          .map((r) => {
            const profile = profiles.get(r.authorId);
            return {
              id: r.id,
              author: (
                profile?.name ||
                formatPublicKey(r.authorId) ||
                "Participant"
              ).slice(0, 1000),
              picture: profile?.picture
                ? (session.media(profile.picture) ?? null)
                : null,
              text: r.content.slice(0, 16000),
              time: r.createdAt,
              failed: r.delivery === "failed" && r.authorId === session.viewer,
            };
          }),
      };
    },
    async send(text: string) {
      if (disposed || sending || !text.trim() || text.length > 16000) return;
      if (!writable()) {
        error = "This Huddle is read-only.";
        notify();
        return;
      }
      sending = true;
      error = undefined;
      notify();
      try {
        await session.messages.send(room, text);
        if (!disposed) sent++;
      } catch (cause) {
        if (!disposed)
          error =
            cause instanceof Error
              ? cause.message
              : "Couldn’t send. Your draft is still here.";
      } finally {
        sending = false;
        notify();
      }
    },
    recover(id: string, dismiss = false) {
      const item = session.outbox
        ?.snapshot()
        .find(
          (item) =>
            item.event.id === id &&
            item.event.pubkey === session.viewer &&
            item.delivery === "failed" &&
            item.event.tags.some((t) => t[0] === "h" && t[1] === room),
        );
      if (disposed || !resolved || !item) return;
      if (dismiss)
        void session.outbox?.dismiss(id).catch(() => {
          error = "Couldn’t discard this message.";
          notify();
        });
      else if (writable()) session.outbox?.retry(id, writable);
    },
    retry: () => {
      void load();
    },
    older: () => {
      if (resolved && session.channels.window(room).rows.length < 200)
        session.channels.loadOlder(room);
    },
    dispose() {
      disposed = true;
      controller.abort();
      stop();
      stopList();
      stopProfiles();
    },
  };
}
