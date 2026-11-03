import { ChatCircleIcon } from "../../shared/design-system/icons";
import { useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { messageCopyLink } from "../../features/messages/message-copy";
import {
  copiedCanvasLead,
  linkedDraftId,
  linkedDraftKey,
  type LinkedChat,
} from "../../features/solo/linked-chat";
import { workspaceDirectories } from "../../features/solo/workspace";
import { readView, writeView } from "../../shared/view-state";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { soloDraftTarget } from "../../features/channel-navigation/routes";

export function canStartLinkedChat(session: RelaySession, channelId: string) {
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  return !!(
    session.viewer &&
    channel &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    ["stream", "forum"].includes(channel.channelType ?? "") &&
    channel.members?.includes(session.viewer) &&
    session.channelWrites.available
  );
}

const workspaceEnd = "\n<!-- /buzz-session-workspace -->\n\n";

/** A channel's Canvas, copied into a chat started from it so that chat's own
 * agents read it. Once saved it counts as the owner's, so it opens with where
 * it came from, and a workspace block is dropped: its folders would otherwise
 * become ones the owner's agents may work in. */
async function sourceCanvas(session: RelaySession, channelId: string) {
  if (!session.canvas.available) return undefined;
  const head = await session.canvas.read(channelId).catch(() => {
    throw new Error(
      "This channel’s Canvas couldn’t be read, so no chat was started. Try again.",
    );
  });
  let content = head?.content ?? "";
  if (workspaceDirectories(content).length)
    content = content.slice(
      content.indexOf(workspaceEnd) + workspaceEnd.length,
    );
  if (!content.trim()) return undefined;
  const name = session.channels
    .list()
    .channels.find(({ id }) => id === channelId)?.name;
  const link = `buzz://channel/${encodeURIComponent(channelId)}`;
  return `${copiedCanvasLead}${name ? `#${name} (${link})` : link}, written by that channel’s members.\n\n${content}`;
}

/** Existing menu tree owns anchoring/dismissal. Nothing is published until first send. */
export function StartLinkedChat({
  session,
  navigation,
  channelId,
  message,
}: {
  session: RelaySession;
  navigation: Navigation;
  channelId: string;
  message?: ChannelMessage;
}) {
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  async function start() {
    if (busy || !canStartLinkedChat(session, channelId)) return;
    setBusy(true);
    // The digest is async. If another navigation wins meanwhile, this visit is
    // over: don't save its draft, open it, or report its errors.
    let owned = navigation.snapshot().attempt.id;
    const current = () => navigation.snapshot().attempt.id === owned;
    try {
      const link = message
        ? messageCopyLink(message, session.scope)
        : `buzz://channel/${encodeURIComponent(channelId)}`;
      if (!link || (message && message.channelId !== channelId))
        throw new Error("This source is unavailable. Reopen it and try again.");
      const source: LinkedChat = { channelId, link };
      const id = await linkedDraftId(source);
      if (!current()) {
        setBusy(false);
        return;
      }
      const settingsKey = `${linkedDraftKey(id)}:settings`;
      const settings = () =>
        readView<Record<string, unknown> | null>(
          session.scope,
          settingsKey,
          null,
        );
      // A draft returned to keeps the Canvas it was given or edited.
      const canvas =
        message || settings()?.canvas !== undefined
          ? undefined
          : await sourceCanvas(session, channelId);
      if (!current()) {
        setBusy(false);
        return;
      }
      if (
        !writeView(session.scope, linkedDraftKey(id), source) ||
        (canvas &&
          !writeView(session.scope, settingsKey, { ...settings(), canvas }))
      )
        throw new Error(
          "Your new chat draft couldn’t be saved. Nothing was created.",
        );
      const opening = navigation.open(
        soloDraftTarget(session.scope, { linked: id }),
      );
      owned = navigation.snapshot().attempt.id;
      const result = await opening;
      if (result.status === "failed")
        throw new Error("The Solo chat couldn’t open. Try again.");
    } catch (error) {
      if (current())
        notify(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  }
  return (
    <MenuItem
      disabled={busy || !canStartLinkedChat(session, channelId)}
      onClick={() => void start()}
    >
      <MenuIcon>
        <ChatCircleIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Start Solo chat
    </MenuItem>
  );
}
