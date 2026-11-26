import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import type { ForwardReference } from "../../features/messages/forward-clipboard";
import { mentionDraft } from "../../features/messages/mention-draft";
import type { Navigation } from "../../features/navigation/controller";
import { ChannelLifecycleUnconfirmed } from "../../features/relay/channel-lifecycle";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import { splitPartition } from "../../features/relay/partition";
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
import { Button } from "../../shared/design-system/ui/Button";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import referenceStyles from "../../shared/InlineReference.module.css";
import { readView, writeView } from "../../shared/view-state";
import { ChannelBody } from "./ChannelBody";
import { useLifecycleOffer } from "./useLifecycleOffer";
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
      const started = await startTemporaryChat(
        session,
        message,
        agent.pubkey,
        authorName(session, message.authorId),
      );
      showTemporaryChat(session, {
        chatId: started.chatId,
        source: started.source,
      });
      if (started.forwardError) notify(started.forwardError, "error");
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
  const target = useMemo(
    () =>
      chat ? ({ kind: "channel", channelId: chat.id } as const) : undefined,
    [chat],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      target ? session.unread.subscribe(target, listener) : () => {},
    [session.unread, target],
  );
  const get = useCallback(
    () => (target ? session.unread.snapshot(target) : undefined),
    [session.unread, target],
  );
  const unread = useSyncExternalStore(subscribe, get, get);
  if (!chat || !source) return null;
  const count = unread?.row?.observedCount ?? unread?.observedCount ?? 0;
  const label =
    count > 0
      ? `Your temporary chat · ${count} new`
      : chat.archived
        ? "Your temporary chat · Archived"
        : "Your temporary chat";
  return (
    <span className="text-caption">
      <button
        type="button"
        className={`${referenceStyles.link} ${styles.marker}`}
        data-temporary-chat-marker=""
        data-temporary-chat-unread={count > 0 ? "" : undefined}
        data-temporary-chat-archived={chat.archived ? "" : undefined}
        onClick={() => showTemporaryChat(session, { chatId: chat.id, source })}
      >
        <ChatCircleIcon size={14} aria-hidden="true" />
        {label}
      </button>
    </span>
  );
}

/** In a temporary chat, an agent's message can be staged as a forwarded card
 * in the source's thread composer so the viewer can review it, add an optional
 * note, and send with clear agent attribution. */
export function canPostBack(message: ChannelMessage, session: RelaySession) {
  const chat = session.channels.get?.(message.channelId);
  return (
    !!session.scope &&
    ownTemporaryChat(chat, session.viewer) &&
    message.authorId !== session.viewer &&
    !message.threadRootId &&
    (!!message.content.trim() || message.attachments.length > 0) &&
    !!temporarySource(chat.description) &&
    (!message.delivery || ["accepted", "seen"].includes(message.delivery))
  );
}

/** Stages the message as an attributed forward card in the source thread's
 * draft, closes the temporary chat and opens that thread. Nothing is sent
 * until the person sends it there. */
export function PostBackMenuItem({
  message,
  session,
  navigation,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  navigation: Navigation;
  close(): void;
}) {
  const notify = useToastNotification();
  const source = temporarySource(
    session.channels.get?.(message.channelId)?.description,
  );
  async function post() {
    const scope = session.scope;
    const parts = scope ? splitPartition(scope) : undefined;
    if (!scope || !parts || !source) {
      notify("The thread is unavailable.", "error");
      return;
    }
    const problem = session.messages.forwardProblem?.(
      source.channelId,
      message,
      authorName(session, message.authorId),
      "",
    );
    if (problem) {
      notify(problem, "error");
      return;
    }
    const key = `draft:${source.channelId}:thread:${source.rootId}`;
    const { document: _, ...saved } = mentionDraft(
      readView<unknown>(scope, key, ""),
    );
    const forward: ForwardReference = {
      version: 1,
      origin: parts.communityOrigin,
      channelId: message.channelId,
      id: message.id,
    };
    if (!writeView(scope, key, { ...saved, forward })) {
      notify("The thread’s draft couldn’t be saved. Try again.", "error");
      return;
    }
    showTemporaryChat(session, undefined);
    close();
    const current = navigation.snapshot().entry.target;
    if (
      current.kind === "conversation" &&
      current.channelId === source.channelId &&
      current.inline === source.rootId
    )
      return;
    const result = await navigation.open({
      version: 1,
      kind: "conversation",
      scope: parts,
      channelId: source.channelId,
      messageId: source.messageId,
      threadRootId: source.rootId,
    });
    if (result.status === "failed")
      notify("The thread couldn’t open. Your draft is saved there.", "error");
  }
  return (
    <MenuItem disabled={!source} onClick={() => void post()}>
      <MenuIcon>
        <ArrowUpIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Post to thread
    </MenuItem>
  );
}

function TemporaryChatArchivedFooter({
  chat,
  session,
}: {
  chat: ChannelSummary;
  session: RelaySession;
}) {
  const offer = useLifecycleOffer(session, chat);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const canUnarchive =
    !!offer?.canUnarchive && session.channelLifecycle.available;
  const unarchive = () => {
    if (!canUnarchive || pending) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError(undefined);
    session.channelLifecycle.run("unarchive", chat.id, current.signal).then(
      () => {
        if (!current.signal.aborted) setPending(false);
      },
      (reason: unknown) => {
        if (current.signal.aborted) return;
        setPending(false);
        setError(
          reason instanceof ChannelLifecycleUnconfirmed
            ? "Unarchive may have taken effect, but it is not confirmed yet. Try again to check."
            : reason instanceof Error
              ? reason.message
              : "Couldn’t unarchive this temporary chat.",
        );
      },
    );
  };
  return (
    <section
      aria-label="Archived temporary chat"
      className={styles.archivedFooter}
    >
      <p className="text-body-sm text-subtle">
        This temporary chat is archived and read-only.
      </p>
      {canUnarchive && (
        <Button
          type="button"
          size="sm"
          variant="prominent"
          loading={pending}
          onClick={unarchive}
        >
          Unarchive
        </Button>
      )}
      {error && (
        <p
          role="alert"
          className={`${styles.archivedError} text-body-sm text-danger`}
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** The open temporary chat, as a sheet over the composer of the view it
 * covers (the conversation, or its open inline thread) with its own
 * composer in that one's place. Closing it leaves the chat; its source
 * reopens it even after it archives (read-only, with Unarchive). */
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
      description={
        chat.archived
          ? "Archived · Only you can see this"
          : "Only you can see this"
      }
      containsComposer
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
          allowArchived
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
                {chat.archived ? (
                  <TemporaryChatArchivedFooter chat={chat} session={session} />
                ) : (
                  <ConversationComposer autoFocus />
                )}
              </div>
            </ComposerScopeProvider>
          )}
        </ConfirmedChannel>
      </ConversationChannel>
    </ComposerSheet>
  );
}
