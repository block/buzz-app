import { huddleRoom } from "./lifecycle";
import type { RelaySession } from "../relay/session";
import type { Attachment } from "../relay/contracts";
import type { Delivery } from "../relay/outbox";
import { formatPublicKey } from "../../shared/identity/public-key";

export type HuddleDiscussion = {
  composer?: string | undefined;
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
    authorId: string;
    channelId: string;
    attachments: (Attachment & {
      source: string | null;
      previewSource: string | null;
    })[];
    picture: string | null;
    text: string;
    time: number;
    delivery: Delivery;
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
  let legacyVerified = false;
  let loading = 0;
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
    const attempt = ++loading;
    error = undefined;
    resolved = false;
    try {
      await session.channels.resolve?.([room], { signal: controller.signal });
      if (disposed || attempt !== loading) return;
      const metadata = channel();
      if (metadata?.parentChannelId === undefined && session.relayAuthor) {
        // Legacy rooms have no parent marker. Only the relay's signed audio
        // lifecycle can establish this link; a user-authored card is not proof.
        const events = await session.read(
          [
            {
              kinds: [48101, 48102, 48103],
              authors: [session.relayAuthor],
              "#h": [parent],
              limit: 500,
            },
          ],
          { signal: controller.signal },
        );
        if (disposed || attempt !== loading) return;
        legacyVerified = events.some(
          (event) =>
            event.pubkey === session.relayAuthor &&
            [48101, 48102, 48103].includes(event.kind) &&
            event.tags.some(
              ([key, value]) => key === "h" && value === parent,
            ) &&
            huddleRoom(event) === room,
        );
      }
      resolved = true;
      if (!available()) {
        resolved = false;
        throw new Error("Huddle identity unavailable");
      }
      session.channels.ensure(room);
    } catch {
      if (!disposed && attempt === loading)
        error =
          "Couldn’t load this Huddle conversation. Retry to check its connection and access.";
    }
    notify();
  }
  const channel = () =>
    session.channels.get?.(room) ??
    session.channels.list().channels.find((c) => c.id === room);
  const available = () => {
    const c = channel();
    return (
      resolved &&
      !!c &&
      ((c.huddle === true && c.parentChannelId === parent) ||
        (legacyVerified &&
          c.parentChannelId === undefined &&
          c.visibility === "private" &&
          c.channelType === "stream"))
    );
  };
  const writable = () => {
    const c = channel();
    return available() && !!c && !c.archived && !c.readOnly && !c.cached;
  };
  void load();
  return {
    available,
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
        rows: (available() ? window.rows : [])
          .slice(-200)
          .filter((r) => !r.membership && !r.huddle)
          .map((r) => {
            const profile = profiles.get(r.authorId);
            return {
              id: r.id,
              authorId: r.authorId,
              channelId: room,
              attachments: r.attachments.map((attachment) => ({
                ...attachment,
                source: session.media(attachment.url) ?? null,
                previewSource: attachment.previewUrl
                  ? (session.media(attachment.previewUrl) ?? null)
                  : null,
              })),
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
              delivery:
                r.authorId === session.viewer ? (r.delivery ?? "seen") : "seen",
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
            ["failed", "unknown"].includes(item.delivery) &&
            item.event.tags.some((t) => t[0] === "h" && t[1] === room),
        );
      if (disposed || !available() || !item) return;
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
      if (available() && session.channels.window(room).rows.length < 200)
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
