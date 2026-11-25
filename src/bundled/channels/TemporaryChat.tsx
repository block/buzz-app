import { useState, useSyncExternalStore } from "react";
import { ConfirmedChannel } from "../../features/conversation/ConfirmedChannel";
import {
  ConversationChannel,
  ConversationComposer,
} from "../../features/conversation/Conversation";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationInteractions } from "../../features/conversation/ConversationHost";
import { useAgentChoices } from "../../features/agents/use-choices";
import {
  ComposerScopeProvider,
  composerHost,
  useComposerDock,
  useComposerScope,
} from "../../features/messages/composer-overlay";
import { ComposerSheet } from "../../features/messages/ComposerSheet";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useDefaultAgent } from "../../features/solo/default-agent";
import {
  ownTemporaryChat,
  showTemporaryChat,
  startTemporaryChat,
  temporarySource,
  useTemporaryChat,
  type OpenTemporaryChat,
} from "../../features/solo/temporary-chat";
import { ArrowUpIcon, ChatCircleIcon } from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import referenceStyles from "../../shared/InlineReference.module.css";
import { ChannelBody } from "./ChannelBody";
import styles from "./TemporaryChat.module.css";

const authorName = (session: RelaySession, pubkey: string) =>
  session.profiles.snapshot().get(pubkey)?.name ?? pubkey.slice(0, 10);

/** Any accepted message outside a temporary chat can start one. */
export function canStartTemporaryChat(
  message: ChannelMessage,
  session: RelaySession,
) {
  return (
    !!session.viewer &&
    session.channelWrites.available &&
    (!message.delivery || ["accepted", "seen"].includes(message.delivery)) &&
    !ownTemporaryChat(session.channels.get?.(message.channelId), session.viewer)
  );
}

/** Message menu: opens the message's temporary chat, starting one with the
 * message's agent, or the default agent, the first time. */
export function TemporaryChatMenuItem({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const existing = useTemporaryChat(session, message.id);
  const choices = useAgentChoices(session, true, true);
  const byAgent = choices.selectable.some(
    (choice) => choice.pubkey === message.authorId,
  );
  const agent = useDefaultAgent(
    session,
    session.scope,
    byAgent ? message.authorId : undefined,
  );
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  const open = async () => {
    if (busy) return;
    const source = existing && temporarySource(existing.description);
    if (existing && source) {
      showTemporaryChat(session, { chatId: existing.id, source });
      close();
      return;
    }
    if (!agent) {
      notify("Choose a default agent in Agents first.", "error");
      return;
    }
    setBusy(true);
    try {
      showTemporaryChat(
        session,
        await startTemporaryChat(
          session,
          message,
          agent.pubkey,
          authorName(session, message.authorId),
        ),
      );
      close();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  };
  return (
    <MenuItem disabled={busy} onClick={() => void open()}>
      <MenuIcon>
        <ChatCircleIcon size={16} aria-hidden="true" />
      </MenuIcon>
      {existing ? "Open temporary chat" : "Temporary chat"}
    </MenuItem>
  );
}

/** Beside the timestamp of a message with a temporary chat: reopens it. Only
 * its owner is in that chat, so only they see this. */
export function TemporaryChatMarker({
  message,
  session,
}: {
  message: ChannelMessage;
  session: RelaySession;
}) {
  const chat = useTemporaryChat(session, message.id);
  const source = chat && temporarySource(chat.description);
  if (!chat || !source) return null;
  return (
    <span className="text-caption">
      <button
        type="button"
        className={`${referenceStyles.link} ${styles.marker}`}
        data-temporary-chat-marker=""
        onClick={() => showTemporaryChat(session, { chatId: chat.id, source })}
      >
        <ChatCircleIcon size={14} aria-hidden="true" />
        Your temporary chat
      </button>
    </span>
  );
}

/** In a temporary chat, an agent's message can be posted back to the source's
 * thread, as the viewer, quoting the agent. */
export function canPostBack(message: ChannelMessage, session: RelaySession) {
  const chat = session.channels.get?.(message.channelId);
  return (
    ownTemporaryChat(chat, session.viewer) &&
    message.authorId !== session.viewer &&
    !message.threadRootId &&
    !!temporarySource(chat.description) &&
    (!message.delivery || ["accepted", "seen"].includes(message.delivery))
  );
}

export function PostBackMenuItem({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const notify = useToastNotification();
  const source = temporarySource(
    session.channels.get?.(message.channelId)?.description,
  );
  return (
    <MenuItem
      disabled={!source}
      onClick={() => {
        if (!source) return;
        try {
          session.messages.forward(
            source.channelId,
            message,
            authorName(session, message.authorId),
            "",
            undefined,
            { rootId: source.rootId },
          );
          notify("Posted to the thread", "success");
          close();
        } catch (error) {
          notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      }}
    >
      <MenuIcon>
        <ArrowUpIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Post to thread
    </MenuItem>
  );
}

/** The open temporary chat, as a sheet over the composer of the view it
 * covers (the conversation, or its open inline thread) with its own
 * composer in that one's place. Closing it leaves
 * the chat; its source reopens it until it archives. */
export function TemporaryChatSheet({
  session,
  scope,
  extensions,
  interactions,
  open,
}: {
  session: RelaySession;
  scope: string;
  extensions: ConversationExtensions | undefined;
  interactions: ConversationInteractions;
  open: OpenTemporaryChat;
}) {
  const view = useComposerScope();
  const dock = useComposerDock(view?.handle);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const chat = list.channels.find((channel) => channel.id === open.chatId);
  const host = dock ? composerHost(view?.handle) : null;
  if (!host || !chat) return null;
  return (
    <ComposerSheet
      open
      onOpenChange={(next) => {
        if (!next) showTemporaryChat(session, undefined);
      }}
      host={host}
      title="Temporary chat"
      description="Only you can see this"
      containsComposer
      tall
    >
      <ConversationChannel
        session={session}
        scope={scope}
        extensions={extensions}
        channel={chat}
        interactions={interactions}
      >
        <ConfirmedChannel
          session={session}
          view="conversation"
          channelId={chat.id}
          channel={chat}
        >
          {() => (
            // Its own view, which the address never names: its composer
            // docks here, not in the view it covers, and its details
            // messages open in place.
            <ComposerScopeProvider local>
              <div className={styles.chat} data-temporary-chat={chat.id}>
                <div className={styles.history}>
                  <ChannelBody cached={false} viewer={session.viewer} />
                </div>
                <ConversationComposer autoFocus />
              </div>
            </ComposerScopeProvider>
          )}
        </ConfirmedChannel>
      </ConversationChannel>
    </ComposerSheet>
  );
}
