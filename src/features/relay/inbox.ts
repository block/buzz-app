import type { PreviewMentions } from "../messages/PreviewText";
import type { ChannelSummary } from "./contracts";
import type { ReadTarget } from "./read-state-model";

/** A listed public stream or forum the viewer reads without joining. Its
 * mentions of the viewer are Activity and notify; nothing else from it is. */
export const outsideChannel = (channel: ChannelSummary, viewer: string) =>
  channel.visibility === "public" &&
  !channel.unlisted &&
  (channel.channelType === "stream" || channel.channelType === "forum") &&
  !channel.hidden &&
  !channel.cached &&
  !channel.metadataCached &&
  !channel.metadataPending &&
  !channel.huddle &&
  !channel.archived &&
  !channel.members?.includes(viewer);

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
export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
