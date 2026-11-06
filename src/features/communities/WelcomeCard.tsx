import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ConversationExtensions } from "../conversation/contracts";
import { MessageMarkdown } from "../messages/MessageMarkdown";
import { useReferenceDirectory } from "../messages/ReferenceText";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import { communityPresentation } from "./community-icon";
import { communityDestination } from "./destination";
import type { CommunityReader } from "./service";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./WelcomeCard.module.css";

/** Shown when the community has not set its own welcome message. */
export const DEFAULT_WELCOME_MESSAGE =
  "This is a place to connect with the community and keep up with what’s happening. Explore the channels to find conversations that interest you.";

/** Shown when the community has not set its own welcome title. */
export function defaultWelcomeTitle(communityName?: string | undefined) {
  return communityName ? `Welcome to ${communityName}` : "Welcome";
}

const noCommunities = () => () => {};
const noSnapshot = () => undefined;

/** The default title for the community of the relay session `scope`. Only a
 * configured name counts, this viewer's own or the relay's published one; a
 * community known only by its address is welcomed without a name. */
export function useDefaultWelcomeTitle(
  communities: CommunityReader | undefined,
  scope: string,
) {
  const snapshot = useSyncExternalStore(
    communities?.subscribe ?? noCommunities,
    communities?.snapshot ?? noSnapshot,
  );
  const origin = splitPartition(scope)?.communityOrigin;
  let name: string | undefined;
  if (origin && origin !== "offline")
    try {
      const presented = communityPresentation(origin, snapshot?.memberships);
      // Without a configured name, the presentation falls back to the host.
      if (presented.name !== communityDestination(origin).name)
        name = presented.name;
    } catch {
      // An unscoped reader has no community presentation to show.
    }
  return defaultWelcomeTitle(name);
}

/** The welcome channel's introduction, never a message. A long message
 * scrolls within the card, which is then reachable by keyboard. */
export function WelcomeCard({
  title,
  children,
  level = 2,
  onDismiss,
}: {
  title: string;
  /** The rendered message, usually a `WelcomeMessage`. */
  children: ReactNode;
  level?: 2 | 3 | 4;
  /** Offers Dismiss; `focused` says whether focus was in the card. */
  onDismiss?: ((focused: boolean) => void) | undefined;
}) {
  const id = useId();
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  const card = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const scroller = body.current;
    if (!scroller || !content.current) return;
    const measure = () =>
      setScrolls(scroller.scrollHeight > scroller.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return (
    <section ref={card} aria-labelledby={id} className={styles.card}>
      <div className={styles.header}>
        <Heading id={id} className={`${styles.title} text-label`}>
          {title}
        </Heading>
        {onDismiss && (
          <Button
            size="sm"
            onClick={() =>
              onDismiss(!!card.current?.contains(document.activeElement))
            }
          >
            Dismiss
          </Button>
        )}
      </div>
      <div
        ref={body}
        className={styles.body}
        tabIndex={scrolls ? 0 : undefined}
      >
        <div ref={content}>{children}</div>
      </div>
    </section>
  );
}

/**
 * The welcome message: Markdown source rendered as a message body is, with
 * its `buzz://` channel and message links and `nostr:npub` identity links.
 * Identity links name people without notifying them. A non-interactive
 * render, such as the editor's link chips, shows the same references without
 * their actions.
 */
export function WelcomeMessage({
  message,
  session,
  scope,
  channelId,
  extensions,
  onOpenLink,
  canOpenLink,
  interactive = true,
}: {
  /** Markdown source; `undefined` shows the default. */
  message?: string | undefined;
  session: RelaySession;
  scope: string;
  /** Scopes identity names to this channel's members. */
  channelId: string;
  extensions?: ConversationExtensions | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  interactive?: boolean;
}) {
  const directory = useReferenceDirectory(session);
  return (
    <MessageMarkdown
      row={{
        id: "community-welcome",
        authorId: "",
        createdAt: 0,
        channelId,
        content: message ?? DEFAULT_WELCOME_MESSAGE,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      directory={directory}
      session={session}
      scope={scope}
      extensions={extensions}
      media={session.media}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      interactive={interactive}
      inertProfileChips={!interactive}
    />
  );
}

/** The welcome card, titled by default with the community's configured
 * name (see {@link useDefaultWelcomeTitle}). */
export function CommunityWelcomeCard({
  communities,
  scope,
  title,
  children,
  onDismiss,
}: {
  communities?: CommunityReader | undefined;
  /** The relay session's partition. */
  scope: string;
  /** Custom title; absent shows the default. */
  title?: string | undefined;
  children: ReactNode;
  onDismiss?: ((focused: boolean) => void) | undefined;
}) {
  const defaultTitle = useDefaultWelcomeTitle(communities, scope);
  return (
    <WelcomeCard title={title ?? defaultTitle} onDismiss={onDismiss}>
      {children}
    </WelcomeCard>
  );
}

/** The welcome card pinned over the end of the welcome channel's history,
 * above the composer, as a channel's join notice is. It reports its height so
 * the history can leave the last messages clear of it, and never takes focus. */
export function PinnedWelcome({
  onHeightChange,
  ...card
}: Parameters<typeof CommunityWelcomeCard>[0] & {
  onDismiss(focused: boolean): void;
  onHeightChange(height: number): void;
}) {
  const pinned = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = pinned.current;
    if (!element) return;
    const measure = () =>
      onHeightChange(Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);
  return (
    <div ref={pinned} className={styles.pinned}>
      <CommunityWelcomeCard {...card} />
    </div>
  );
}
