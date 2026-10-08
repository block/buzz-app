import type { UnreadTarget as ReadTarget } from "./sidebar-journal";

/** A conversation projected from the unread owner's bounded verified evidence. */
export type InboxItem = Readonly<{
  id: string;
  channelId: string;
  target: ReadTarget;
  /** Oldest observed unread message, in the currently admitted subset. */
  messageId: string;
  latestMessageId: string;
  /** Exact verified group members, for pending preview evidence across regrouping. */
  messageIds: readonly string[];
  rootId?: string;
  authorId: string;
  workflowOwnerId?: string | undefined;
  preview: string;
  createdAt: number;
  mentioned: boolean;
  thread: boolean;
  unreadCount: number;
  manual: boolean;
  /** Thread prefixes never acknowledge their top-level root.
   * Empty on a non-DM means no Inbox read action; never substitute a channel cut. */
  readThrough: readonly Readonly<{ target: ReadTarget; messageId: string }>[];
}>;
export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
