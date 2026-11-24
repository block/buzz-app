import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  BuzzLinkPreview,
  LinkedMessage,
  type InlineMessageCard,
} from "../conversation/BuzzLinkPreview";
import { useChannelReference } from "../conversation/channel-reference";
import { parseBuzzLink } from "../navigation/buzz-links";
import type { ChannelMessage } from "../relay/contracts";
import { projectMarkdownAttachments } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import styles from "./LinkPreviews.module.css";
import { MessageCard } from "./MessageCard";
import { messageViewKey } from "./view-key";
import { FOLD_AFTER } from "./LinkPreviews";
import {
  cachedLinkedMessage,
  linkedMessageKey,
  prefetchLinkedMessages,
  rememberLinkedMessage,
  subscribeLinkedMessages,
} from "./linked-messages";
/** Live readers all inline cards may hold at once, out of the session's 64,
 * so a channel full of message links never stops a thread from opening. */
export const CARD_READERS = 16;

const pools = new WeakMap<RelaySession, ReturnType<typeof pool>>();

function pool() {
  let held = 0;
  const waiting = new Set<() => void>();
  return {
    /** Calls `granted` once a reader is free; the returned release frees it,
     * or stops waiting. */
    hold(granted: () => void) {
      let holding = false;
      const take = () => {
        if (holding || held >= CARD_READERS) return;
        held++;
        holding = true;
        waiting.delete(take);
        granted();
      };
      waiting.add(take);
      take();
      return () => {
        waiting.delete(take);
        if (!holding) return;
        holding = false;
        held--;
        for (const next of [...waiting]) next();
      };
    },
  };
}

function readers(session: RelaySession) {
  const owner = pools.get(session) ?? pool();
  pools.set(session, owner);
  return owner;
}

/** Cards below a message for the Buzz messages it links to, framed as a
 * forward is, over the message as its conversation renders it. A card
 * opens its link as clicking the link does. Past `FOLD_AFTER`, the rest fold
 * behind one button, as web previews do. */
export function MessageLinkCards({
  urls,
  session,
  scope,
  onOpenLink,
  renderMessage,
}: {
  urls: readonly string[];
  session: RelaySession;
  scope: string | undefined;
  onOpenLink(url: string): boolean;
  /** The linked message's body, formatted as a message row formats it. */
  renderMessage(message: ChannelMessage): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Links spelled differently can name one message; it gets one card.
  const seen = new Set<string>();
  const cards = urls.flatMap((url) => {
    const link = parseBuzzLink(url);
    if (link?.format !== "legacy" || !link.messageId) return [];
    const key = `${link.channelId}:${link.messageId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ url, channelId: link.channelId, messageId: link.messageId }];
  });
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const hidden = cards.length - shown.length;
  // The cards about to be seen read their messages together, ahead of each
  // card's own read, which then only follows edits and deletions.
  const wanted = shown.map((card) => card.url).join(" ");
  useLayoutEffect(() => {
    if (wanted)
      prefetchLinkedMessages(session, wanted.split(" "), "foreground");
  }, [session, wanted]);
  if (!cards.length) return null;
  return (
    <div className={styles.previews} data-message-link-cards>
      {shown.map((card) => (
        <MessageLinkCard
          key={messageViewKey(session, scope, card.url)}
          session={session}
          onOpenLink={onOpenLink}
          renderMessage={renderMessage}
          {...card}
        />
      ))}
      {cards.length > FOLD_AFTER && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? "Show fewer linked messages"
            : `Show ${hidden} more linked ${hidden === 1 ? "message" : "messages"}`}
        </Button>
      )}
    </div>
  );
}

/** A click on the card's own surface opens it; one on a link, button or
 * other control inside the body, or one that ends a text selection, does
 * not. */
function opensCard(event: MouseEvent<HTMLElement>) {
  const target = event.target as Element;
  if (
    target.closest(
      "a, button, input, select, textarea, summary, [role='button'], [role='link'], [tabindex]",
    )
  )
    return false;
  const selection = event.currentTarget.ownerDocument.getSelection();
  return !(
    selection &&
    !selection.isCollapsed &&
    event.currentTarget.contains(selection.anchorNode)
  );
}

function MessageLinkCard({
  url,
  channelId,
  messageId,
  session,
  onOpenLink,
  renderMessage,
}: {
  url: string;
  channelId: string;
  messageId: string;
  session: RelaySession;
  onOpenLink(url: string): boolean;
  renderMessage(message: ChannelMessage): ReactNode;
}) {
  // A card into a channel the reader can't see explains why and opens
  // nothing, as its link does.
  const withheld =
    useChannelReference(session.channels, channelId).state === "withheld";
  const [reading, setReading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // Before paint, so a free reader never shows the row without its card.
  useLayoutEffect(() => {
    const release = readers(session).hold(() => setReading(true));
    return () => {
      release();
      setReading(false);
    };
  }, [session]);
  const openCard = useCallback(
    () => setUnavailable(!onOpenLink(url)),
    [onOpenLink, url],
  );
  const key = linkedMessageKey(channelId, messageId);
  // A prefetch, or an earlier mount's read, may already hold the message.
  const cached = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeLinkedMessages(session, listener),
      [session],
    ),
    () => cachedLinkedMessage(session, key),
    () => cachedLinkedMessage(session, key),
  );
  const remember = useCallback(
    (message: ChannelMessage | undefined) =>
      rememberLinkedMessage(session, key, message),
    [session, key],
  );
  const inline = useMemo<InlineMessageCard>(
    () => ({
      // Attachments aren't shown, so their links leave the text, as a
      // forward's do; a message with no other text names its attachment.
      body: (message) => {
        const content = projectMarkdownAttachments(
          message.content,
          new Set(message.attachments.map((item) => item.url)),
        ).content;
        if (!content.trim()) return null;
        return renderMessage({ ...message, content, attachmentSeams: [] });
      },
      cached,
      remember,
      link: (children) => (
        <a
          className={styles.messageLink}
          href={url}
          onClick={(event) => {
            event.preventDefault();
            openCard();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            openCard();
          }}
        >
          {children}
        </a>
      ),
    }),
    [url, openCard, renderMessage, cached, remember],
  );
  return (
    <>
      <MessageCard
        opens={!withheld}
        aria-label="Linked message"
        data-message-link-card=""
        onClick={(event) => {
          if (!withheld && opensCard(event)) openCard();
        }}
        onAuxClick={(event) => {
          if (withheld || event.button !== 1 || !opensCard(event)) return;
          event.preventDefault();
          openCard();
        }}
      >
        {reading ? (
          <BuzzLinkPreview
            session={session}
            channelId={channelId}
            messageId={messageId}
            inline={inline}
          />
        ) : cached ? (
          <LinkedMessage message={cached} session={session} inline={inline} />
        ) : (
          // Waiting for a free reader, as a hover card waits for its read.
          <span role="status" className="text-body-sm text-subtle">
            Loading message…
          </span>
        )}
      </MessageCard>
      {unavailable && (
        <span role="status">This Buzz link couldn’t be opened here.</span>
      )}
    </>
  );
}
