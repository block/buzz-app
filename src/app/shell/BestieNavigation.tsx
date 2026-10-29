import { useContext, useSyncExternalStore, type ReactNode } from "react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { bestieChat } from "../../bundled/bestie/chat";
import {
  UnreadBadge,
  useUnreadState,
} from "../../bundled/channels/UnreadBadge";
import channelStyles from "../../bundled/channels/Channels.module.css";
import type { RelaySession } from "../../features/relay/session";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { RegisteredPage } from "../../features/pages/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { useSavedAgent } from "../../features/solo/default-agent";
import { pagePresentation } from "./presentation";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import styles from "./BestieNavigation.module.css";
import {
  BESTIE_PAGE,
  BestieNavigationContext,
  BestieConversationContext,
  type BestieMark,
} from "./bestie-context";

/** Shell projection of the account-saved Bestie and its existing exact DM. */
export function BestieNavigationProvider({
  pages,
  relay,
  children,
}: {
  pages: readonly RegisteredPage[];
  relay: RelayData;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope, session } = connection;
  const active =
    pages.some((page) => page.key === BESTIE_PAGE) &&
    connection.status === "ready" &&
    !!viewer &&
    !!scope?.endsWith(`:${viewer}`);
  const saved = useSavedAgent(session, scope ?? "");
  const choices = useAgentChoices(session, active, active);
  const agent = active
    ? choices.selectable.find((item) => item.pubkey === saved)
    : undefined;
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = bestieChat(channels.channels, viewer, agent?.pubkey);
  const pack = agentAvatars.find((item) => item.url === agent?.avatar);
  const preview = useAvatarPreview(
    pack ? "" : (agent?.avatar ?? ""),
    connection.origin,
    "small",
    session.media,
  );
  const avatar = pack?.preview ?? preview;
  const mark: BestieMark | undefined = agent
    ? {
        label: agent.managedName ?? agent.name,
        searchLabel: "Bestie",
        avatar: { src: avatar, shape: "squircle" },
      }
    : undefined;
  return (
    <BestieNavigationContext value={mark}>
      <BestieConversationContext
        value={channel ? { session, channelId: channel.id } : undefined}
      >
        {children}
      </BestieConversationContext>
    </BestieNavigationContext>
  );
}

export function BestieUnreadLabel({ label }: { label: string }) {
  const conversation = useContext(BestieConversationContext);
  return conversation ? <UnreadLabel {...conversation} label={label} /> : label;
}
function UnreadLabel({
  session,
  channelId,
  label,
}: {
  session: RelaySession;
  channelId: string;
  label: string;
}) {
  const { ordinary } = useUnreadState(session, channelId, true);
  return (
    <span className={styles.label} data-bestie-unread={ordinary || undefined}>
      {label}
    </span>
  );
}

export function BestieUnreadBadge({ pageKey }: { pageKey: string }) {
  const conversation = useContext(BestieConversationContext);
  if (pageKey !== BESTIE_PAGE || !conversation) return null;
  return (
    <span className={channelStyles.indicatorStack} data-channel-indicators="">
      <span className={channelStyles.indicatorLayer}>
        <UnreadBadge
          session={conversation.session}
          channelId={conversation.channelId}
          dm
        />
      </span>
    </span>
  );
}

/** One presentation for sidebar and page search, without mutating registration. */
export function usePagePresentation() {
  const bestie = useContext(BestieNavigationContext);
  return (page: RegisteredPage) => ({
    ...pagePresentation(page),
    ...(page.key === BESTIE_PAGE ? bestie : undefined),
  });
}
