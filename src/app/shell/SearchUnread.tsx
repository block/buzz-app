import type { ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  UnreadBadge,
  useUnreadState,
} from "../../bundled/channels/UnreadBadge";
import channelStyles from "../../bundled/channels/Channels.module.css";

type Conversation = {
  session: RelaySession;
  channelId: string;
  kind: "channel" | "dm" | "chat";
};

/** A conversation's name, bold while it has unread messages as its sidebar
 * row is: a chat for any of them, others for backlog the dots don't show. */
export function UnreadName({
  session,
  channelId,
  kind,
  children,
}: Conversation & { children: ReactNode }) {
  const { ordinary, manual, count } = useUnreadState(
    session,
    channelId,
    kind === "dm",
  );
  const bold = kind === "chat" ? manual || (count ?? 0) > 0 : ordinary;
  return <span data-search-unread={bold || undefined}>{children}</span>;
}

/** The dots a conversation's sidebar row shows, for a DM, a mention or a
 * thread reply. */
export function UnreadDots({ session, channelId, kind }: Conversation) {
  return (
    <span className={channelStyles.indicatorLayer}>
      <UnreadBadge
        session={session}
        channelId={channelId}
        dm={kind === "dm"}
        labelUnread={kind === "chat" ? "all" : "ordinary"}
      />
    </span>
  );
}
