import { useSyncExternalStore } from "react";
import { UNLISTED_LABEL } from "../relay/channel-labels";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { messageCopyLink } from "../messages/message-copy";

/** NIP-CL label of a temporary chat: a Solo chat started from one message,
 * read in a sheet over that message and reopened from it. It is also
 * unlisted (`UNLISTED_LABEL`), so no list shows it. */
export const TEMPORARY_LABEL = "buzz.solo.temporary";
/** A temporary chat archives after a day without messages. */
export const TEMPORARY_TTL_SECONDS = 24 * 60 * 60;
export const TEMPORARY_LABELS = [UNLISTED_LABEL, TEMPORARY_LABEL] as const;

const ABOUT_PREFIX = "Temporary chat about ";
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The message a temporary chat came from, and the thread it is in. */
export type TemporarySource = Readonly<{
  channelId: string;
  messageId: string;
  /** The source's thread root, which a post back replies in. */
  rootId: string;
  link: string;
}>;

/** The chat's `about`: readable by its agent as the source of the chat. */
export function temporaryAbout(message: ChannelMessage, scope: string) {
  const link = messageCopyLink(message, scope);
  if (!link) throw new Error("This message can’t start a temporary chat yet.");
  return `${ABOUT_PREFIX}${link}. Post back there only when asked.`;
}

/** The source a temporary chat's `about` names; anything else names none. */
export function temporarySource(
  about: string | undefined,
): TemporarySource | undefined {
  if (!about?.startsWith(ABOUT_PREFIX)) return;
  const link = about
    .slice(ABOUT_PREFIX.length)
    .split(/\s/)[0]
    ?.replace(/\.$/, "");
  if (!link?.startsWith("buzz://message?")) return;
  const params = new URLSearchParams(link.slice("buzz://message?".length));
  const channelId = params.get("channel") ?? "";
  const messageId = params.get("id") ?? "";
  const thread = params.get("thread") ?? "";
  if (!UUID.test(channelId) || !HEX.test(messageId)) return;
  return {
    channelId,
    messageId,
    rootId: HEX.test(thread) ? thread : messageId,
    link,
  };
}

/** Whether `channel` is one of the viewer's own temporary chats. */
export function ownTemporaryChat(
  channel: ChannelSummary | undefined,
  viewer: string | undefined,
): channel is ChannelSummary {
  return (
    !!channel &&
    !!viewer &&
    channel.channelType === "solo" &&
    channel.creator === viewer &&
    !!channel.labels?.includes(TEMPORARY_LABEL)
  );
}

/** The viewer's newest open temporary chat started from `messageId`. */
export function findTemporaryChat(
  channels: readonly ChannelSummary[],
  viewer: string | undefined,
  messageId: string,
): ChannelSummary | undefined {
  let found: ChannelSummary | undefined;
  for (const channel of channels) {
    if (
      !ownTemporaryChat(channel, viewer) ||
      channel.archived ||
      temporarySource(channel.description)?.messageId !== messageId
    )
      continue;
    if ((channel.createdAt ?? 0) >= (found?.createdAt ?? 0)) found = channel;
  }
  return found;
}

/** The temporary chat started from `messageId`, as the channel list changes. */
export function useTemporaryChat(session: RelaySession, messageId: string) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  return findTemporaryChat(list.channels, session.viewer, messageId);
}

/** The temporary chat open in a sheet over its source's conversation. One
 * per session: opening another replaces it. This device only; reopening
 * goes through the source message. */
export type OpenTemporaryChat = Readonly<{
  chatId: string;
  source: TemporarySource;
}>;

type Sheet = {
  open: OpenTemporaryChat | undefined;
  listeners: Set<() => void>;
};
const sheets = new WeakMap<object, Sheet>();
function sheet(session: RelaySession): Sheet {
  let found = sheets.get(session.channels);
  if (!found) {
    found = { open: undefined, listeners: new Set() };
    sheets.set(session.channels, found);
  }
  return found;
}

export function showTemporaryChat(
  session: RelaySession,
  open: OpenTemporaryChat | undefined,
) {
  const state = sheet(session);
  state.open = open;
  for (const listener of state.listeners) listener();
}

export function useOpenTemporaryChat(session: RelaySession) {
  const state = sheet(session);
  return useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => void state.listeners.delete(listener);
    },
    () => state.open,
  );
}

/** Starts a temporary chat from `message` with `agent`: a private, unlisted
 * Solo chat whose first message forwards the source, so the agent reads it
 * as history once asked. Settles with the chat's id once it exists. */
export async function startTemporaryChat(
  session: RelaySession,
  message: ChannelMessage,
  agent: string,
  authorName: string,
): Promise<OpenTemporaryChat> {
  const description = temporaryAbout(message, session.scope ?? "");
  const source = temporarySource(description);
  if (!source) throw new Error("This message can’t start a temporary chat.");
  const id = crypto.randomUUID();
  const excerpt = message.content.replace(/\s+/g, " ").trim();
  const title = `About: ${[...excerpt].slice(0, 60).join("") || "a message"}`;
  const { ready } = session.channelWrites.start(
    id,
    title,
    [agent],
    TEMPORARY_TTL_SECONDS,
    false,
    undefined,
    { labels: TEMPORARY_LABELS, description },
  );
  await ready;
  session.messages.forward(id, message, authorName, "");
  return { chatId: id, source };
}
