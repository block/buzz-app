import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import {
  type CompanionManagement,
  type CompanionRow,
  projectCompanionRow,
} from "../companion/row";
import type { MainOperation } from "../companion/operations";
import { lastEditableMessage } from "../messages/useMessageEdit";

/** What a pop-out window shows for one thread. Bounded like the native DTO. */
export type PopoutThreadView = {
  title: string;
  /** The owner's persistence scope, for message links the companion copies. */
  scope: string;
  status: "loading" | "ready" | "error";
  error?: string | undefined;
  writable: boolean;
  canLoadMore: boolean;
  limited: boolean;
  loadingOlder: boolean;
  /** Reading bridge token: main publishes reading intent for this window. */
  reading?: string | undefined;
  /** Main's durable read-intent revision when this view was produced. A
   * companion lease request carries the revision its event saw; main grants
   * it only while that is still current, so a manual unread in main cannot
   * be undone by reading intent formed before it. */
  readingRevision: number;
  composer?: string | undefined;
  version: number;
  root?: CompanionRow | undefined;
  replies: CompanionRow[];
  /** Main's outbox operations in this channel (reactions, removals, edits,
   * sent-to-channel copies), every delivery state, so a companion mirrors
   * real delivery and retries the admitted event even after its row is gone. */
  operations: MainOperation[];
  /** The viewer follows this thread. */
  following: boolean;
  /** A DM: no thread following. */
  isDm: boolean;
};
export type { MainOperation };
const MAX_OPERATIONS = 64;
const MAX_REPLIES = 500;
const visible = (rows: readonly ChannelMessage[]) =>
  rows.filter((row) => !row.membership && !row.huddle);

/** One session-owned thread reader for a pop-out. Verified-root loading, access
 * and delivery stay with `session.thread`; this only projects. */
export function createPopoutThread(
  session: RelaySession,
  channelId: string,
  rootId: string,
  changed: () => void,
) {
  let disposed = false;
  let version = 0;
  let error: string | undefined;
  const notify = () => {
    if (!disposed) {
      version++;
      changed();
    }
  };
  let thread: ThreadView | undefined;
  try {
    thread = session.thread(channelId, rootId);
    // A session thread may contain seeded rows while still idle. Start its
    // verified read before subscribing: refresh publishes loading synchronously,
    // while the caller is still constructing this window's owner.
    void thread.refresh().catch(() => {});
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Couldn’t open this thread.";
  }
  const stops = [
    thread?.subscribe(notify),
    session.outbox?.subscribe(notify),
    session.channels.subscribeList(notify),
    session.profiles.subscribe(notify),
    session.unread.subscribe({ kind: "channel", channelId }, notify),
    session.unread.subscribe({ kind: "thread", channelId, rootId }, notify),
    session.unread.subscribeSync(notify),
  ];
  const channel = () =>
    session.channels.get?.(channelId) ??
    session.channels.list().channels.find((c) => c.id === channelId);
  /** The channel is known and readable; says nothing about the root. */
  const available = () => {
    const c = channel();
    return !disposed && !!thread && !!c && !c.cached;
  };
  /** The verified root of this exact thread is loaded in this channel. Replies
   * are offered and admitted only then; a loading root keeps the window open
   * but read-only. */
  const rootVerified = () => {
    const snap = thread?.snapshot();
    return (
      available() &&
      snap?.status === "ready" &&
      !snap.error &&
      snap.root?.id === rootId &&
      snap.root.channelId === channelId
    );
  };
  // As the main thread composer decides: the relay's readOnly/cached flags,
  // not the roster, which the summary may not carry ("absent means unknown").
  const writable = () => {
    const c = channel();
    return (
      rootVerified() && !!c && !c.archived && !c.readOnly && !!session.viewer
    );
  };
  return {
    available,
    rootVerified,
    writable,
    /** A shown message by id, with main's own reaction events, for admission. */
    shown(id: string): ChannelMessage | undefined {
      const snap = thread?.snapshot();
      if (!snap || !available()) return undefined;
      if (snap.root?.id === id) return snap.root;
      return visible(snap.replies)
        .slice(-MAX_REPLIES)
        .find((row) => row.id === id);
    },
    /** Main's outbox operations in this channel: the whole collection, for
     * admission and fences; the view serializes a capped copy. Operations are
     * not dropped when their target row leaves the projection. */
    operations(): MainOperation[] {
      return (session.outbox?.snapshot() ?? []).flatMap((item) => {
        const kind = item.event.kind;
        if (kind !== 7 && kind !== 5 && kind !== 40003 && kind !== 9) return [];
        if (
          !item.event.tags.some(
            ([name, value]) => name === "h" && value === channelId,
          )
        )
          return [];
        const messageId =
          kind === 9
            ? item.event.tags.find(([name]) => name === "buzz:copy-of")?.[1]
            : kind === 40003
              ? item.event.tags.find(([name]) => name === "e")?.[1]
              : session.messages.reactionTarget(item.event);
        // A plain message send is not an operation on another message.
        if (kind === 9 && !messageId) return [];
        return [
          {
            id: item.event.id,
            ...(messageId ? { messageId } : {}),
            kind,
            delivery: item.delivery,
            ...(item.error ? { error: item.error.slice(0, 2048) } : {}),
          },
        ];
      });
    },
    /** An unresolved reaction change is still in flight for this message. */
    reactionBusy(messageId: string) {
      return this.operations().some(
        (op) =>
          op.messageId === messageId &&
          (op.kind === 7 || op.kind === 5) &&
          ["sending", "failed", "unknown"].includes(op.delivery),
      );
    },
    /** Retry main's own event, if it is one of this channel's operations. */
    retryOperation(id: string) {
      if (!this.operations().some((op) => op.id === id)) return false;
      session.outbox?.retry(id, writable);
      return true;
    },
    /** Ids this window presents; the reading owner claims nothing else. */
    known(): ReadonlySet<string> {
      const snap = thread?.snapshot();
      return new Set(
        snap && available()
          ? [snap.root, ...visible(snap.replies).slice(-MAX_REPLIES)]
              .filter((row) => row !== undefined)
              .map((row) => row.id)
          : [],
      );
    },
    readingEnabled: () =>
      available() && session.unread.sync().capability === "frontier-sync",
    snapshot(): PopoutThreadView {
      const snap = thread?.snapshot();
      const profiles = session.profiles.snapshot();
      const replies = snap ? visible(snap.replies) : [];
      const c = channel();
      const joined =
        !!c && !c.cached && (!c.readOnly || c.viewerRole === "guest");
      const channelWritable = !!c && !c.readOnly && !c.cached;
      const archived = !!c?.archived;
      const project = (row: ChannelMessage) => {
        const projected = projectCompanionRow(
          session,
          profiles,
          row,
          channelId,
        );
        const delivered =
          !row.delivery || ["accepted", "seen"].includes(row.delivery);
        if (!joined || row.membership || row.diff || !delivered)
          return projected;
        const own = row.authorId === session.viewer && !archived;
        // The same single-row predicate the main menu uses.
        const canEdit =
          channelWritable && own && !!lastEditableMessage(session, [row]);
        const attention = session.unread.attention(channelId, row.id);
        return {
          ...projected,
          management: {
            unread: attention.unread || attention.forced,
            canEdit,
            canDelete: channelWritable && own && !!session.outbox?.supports(5),
            canSendToChannel:
              channelWritable &&
              own &&
              !!row.threadRootId &&
              !row.agentEnvelope &&
              !row.diff &&
              !!session.outbox?.supports(9),
            canReport: !row.huddle && !!session.messages.report,
          } satisfies CompanionManagement,
          ...(canEdit
            ? {
                editable: {
                  sourceContent: row.sourceContent ?? row.content,
                  attachmentSourceId: row.attachmentSourceId ?? row.id,
                },
                // An edit needs the whole text, not the presentation slice.
                text: row.content,
              }
            : {}),
        };
      };
      return {
        title: (channel()?.name ?? "Conversation").slice(0, 1000),
        scope: session.scope.slice(0, 4096),
        status:
          error || snap?.status === "error"
            ? "error"
            : snap?.status === "ready"
              ? "ready"
              : "loading",
        error: error ?? snap?.error,
        writable: writable(),
        canLoadMore: !!snap?.canLoadMore && !snap.limited,
        limited: !!snap?.limited || replies.length > MAX_REPLIES,
        loadingOlder: snap?.readKind === "older",
        readingRevision: session.unread.revision(),
        version,
        root: snap?.root && available() ? project(snap.root) : undefined,
        replies: available() ? replies.slice(-MAX_REPLIES).map(project) : [],
        operations: this.operations().slice(0, MAX_OPERATIONS),
        following: session.unread.following(channelId, rootId),
        isDm: c?.channelType === "dm",
      };
    },
    retry() {
      if (!thread || disposed) return;
      error = undefined;
      void thread.refresh().catch(() => {});
      notify();
    },
    older() {
      if (!thread || disposed || !available()) return;
      void thread.loadMore().catch(() => {});
    },
    recover(id: string, dismiss = false) {
      const item = session.outbox
        ?.snapshot()
        .find(
          (item) =>
            item.event.id === id &&
            item.event.pubkey === session.viewer &&
            ["failed", "unknown"].includes(item.delivery) &&
            item.event.tags.some((t) => t[0] === "h" && t[1] === channelId),
        );
      if (disposed || !available() || !item) return;
      if (dismiss)
        void session.outbox?.dismiss(id).catch(() => {
          error = "Couldn’t discard this message.";
          notify();
        });
      else if (writable()) session.outbox?.retry(id, writable);
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop?.();
      thread?.dispose();
    },
  };
}
