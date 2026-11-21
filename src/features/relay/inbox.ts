import type { PreviewMentions } from "../messages/PreviewText";
import type { ReadTarget } from "./read-state-model";

/** A conversation projected from the unread owner's bounded verified evidence. */
export type InboxItem = Readonly<{
  id: string;
  channelId: string;
  target: ReadTarget;
  /** Oldest observed unread message, otherwise newest relevant message. */
  messageId: string;
  latestMessageId: string;
  /** Exact verified group members, for pending preview evidence across regrouping. */
  messageIds: readonly string[];
  rootId?: string;
  /** A DM row whose every unread message, or with none the representative,
   * is a reply in `rootId`'s thread, so that thread alone shows them. */
  threadOnly?: true;
  authorId: string;
  workflowOwnerId?: string | undefined;
  preview: string;
  /** The message the preview shows, which may be outside `messageIds`. */
  previewMessageId?: string;
  /** The preview message's body and signed mentions, which its chips bind. */
  previewMentions: PreviewMentions;
  createdAt: number;
  mentioned: boolean;
  /** Verified group members with time and viewer-mention classification. */
  messages: readonly Readonly<{
    id: string;
    createdAt: number;
    mentioned: boolean;
  }>[];
  /** The same conversation projected from explicit mention evidence only. */
  mention?: InboxItem | undefined;
  thread: boolean;
  unreadCount: number;
  manual: boolean;
  /** A session's top-level timeline row: its explicit read is one
   * `markTimelineRead` over `messageIds`, and `readThrough` is empty. */
  timeline?: true;
  /** Explicit prefixes; a thread prefix never acknowledges its top-level root. */
  readThrough: readonly Readonly<{ target: ReadTarget; messageId: string }>[];
}>;
/** Whether a conversation counts as unread in Activity. */
export const hasUnread = (item: InboxItem) =>
  item.unreadCount > 0 || item.manual;

/**
 * Whether a conversation needs you, and how much: the one rule every unread
 * cue in the sidebar reads. Only Activity's unread counts: a DM, a mention of
 * you, or a reply in a thread you follow. Ordinary channel backlog never
 * does; it only makes a row bold.
 */
export type NeedsYou = Readonly<{ waiting: boolean; count: number }>;

export const nothingNeedsYou: NeedsYou = Object.freeze({
  waiting: false,
  count: 0,
});

const needsYouCache = new WeakMap<
  InboxSnapshot,
  ReadonlyMap<string, NeedsYou>
>();

/** Each conversation that needs you, keyed by channel. */
function needsYouByChannel(inbox: InboxSnapshot) {
  let channels = needsYouCache.get(inbox);
  if (!channels) {
    const counts = new Map<string, number>();
    for (const item of inbox.items)
      if (hasUnread(item))
        counts.set(
          item.channelId,
          // Marked unread with nothing counted still counts the one marked.
          (counts.get(item.channelId) ?? 0) + Math.max(item.unreadCount, 1),
        );
    channels = new Map(
      [...counts].map(([channelId, count]) => [
        channelId,
        Object.freeze({ waiting: true, count }),
      ]),
    );
    needsYouCache.set(inbox, channels);
  }
  return channels;
}

/** Whether one conversation needs you, and its count. Don't recount. */
export function needsYou(inbox: InboxSnapshot, channelId: string): NeedsYou {
  return needsYouByChannel(inbox).get(channelId) ?? nothingNeedsYou;
}

const needsYouChannelCache = new WeakMap<InboxSnapshot, ReadonlySet<string>>();
/** The conversations that need you, for ordering. */
export function needsYouChannels(inbox: InboxSnapshot) {
  let channels = needsYouChannelCache.get(inbox);
  if (!channels) {
    channels = new Set(needsYouByChannel(inbox).keys());
    needsYouChannelCache.set(inbox, channels);
  }
  return channels;
}

export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
