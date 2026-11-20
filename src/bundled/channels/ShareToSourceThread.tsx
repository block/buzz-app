import { ForwardIcon } from "../../shared/design-system/icons";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { mentionDraft } from "../../features/messages/mention-draft";
import { splitPartition } from "../../features/relay/partition";
import {
  linkedSourceKey,
  readLinkedChat,
} from "../../features/solo/linked-chat";
import { readView, writeView } from "../../shared/view-state";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

/** The thread a chat started from a message shares back into. */
export function sourceThread(session: RelaySession, channelId: string) {
  if (!session.scope) return;
  const source = readLinkedChat(session.scope, linkedSourceKey(channelId));
  const link = source && parseBuzzLink(source.link);
  if (link?.format !== "legacy" || !link.messageId) return;
  return {
    channelId: link.channelId,
    messageId: link.messageId,
    rootId: link.threadRootId ?? link.messageId,
  };
}

export function canShareToSourceThread(
  message: ChannelMessage,
  session: RelaySession,
) {
  return (
    !!session.viewer &&
    (!message.delivery || ["accepted", "seen"].includes(message.delivery)) &&
    !!sourceThread(session, message.channelId)
  );
}

/** Attaches the message to the source thread's draft, as a pasted forward
 * would, and opens that thread. The thread's composer reviews and sends it. */
export function ShareToSourceThread({
  session,
  navigation,
  message,
}: {
  session: RelaySession;
  navigation: Navigation;
  message: ChannelMessage;
}) {
  const notify = useToastNotification();
  async function share() {
    const target = sourceThread(session, message.channelId);
    const parts = session.scope ? splitPartition(session.scope) : undefined;
    if (!target || !parts || !session.scope) {
      notify("The original thread is unavailable.", "error");
      return;
    }
    const key = `draft:${target.channelId}:thread:${target.rootId}`;
    const saved = readView<unknown>(session.scope, key, "");
    const attached = mentionDraft(saved).forward;
    if (attached && attached.id !== message.id) {
      notify(
        "That thread’s draft already has a forwarded message. Send or remove it first.",
        "error",
      );
      return;
    }
    const draft =
      saved && typeof saved === "object"
        ? saved
        : { text: typeof saved === "string" ? saved : "", recipients: [] };
    const forward = {
      version: 1,
      origin: parts.communityOrigin,
      channelId: message.channelId,
      id: message.id,
    };
    if (!writeView(session.scope, key, { ...draft, forward })) {
      notify("The thread’s draft couldn’t be saved. Try again.", "error");
      return;
    }
    const result = await navigation.open({
      version: 1,
      kind: "conversation",
      scope: parts,
      channelId: target.channelId,
      messageId: target.messageId,
      threadRootId: target.rootId,
    });
    if (result.status === "failed")
      notify("The original thread couldn’t open. Try again.", "error");
  }
  return (
    <MenuItem onClick={() => void share()}>
      <MenuIcon>
        <ForwardIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Share to original thread
    </MenuItem>
  );
}
