import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { ContributionConversationRow as RowProps } from "../../features/channel-navigation/SidebarContributionSection";
import { rowUnread } from "../../features/relay/unread";
import type { RelaySession } from "../../features/relay/session";
import { ConversationMenu } from "./ConversationMenu";
import { ConversationWork } from "./ConversationWork";
import { useConfirmedMute } from "../../features/relay/useNeedsYou";
import { WorkingAgentsBadge } from "./WorkingAgentsBadge";
import styles from "./Channels.module.css";

type Props = ComponentProps<RowProps>;

/** A plugin card's conversation row, with the sidebar's own evidence: bold when
 * unread, the Solo rows' working dots, and its conversation's or message's menu. */
export function contributionConversationRow(session: RelaySession): RowProps {
  return function ContributionConversationRow(props: Props) {
    return <Row {...props} session={session} />;
  };
}

function Row({
  channelId,
  rootId,
  label,
  onOpen,
  children,
  session,
}: Props & { session: RelaySession }) {
  const target = useMemo(
    () =>
      rootId
        ? ({ kind: "thread", channelId, rootId } as const)
        : ({ kind: "channel", channelId } as const),
    [channelId, rootId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const channel = useSyncExternalStore(session.channels.subscribeList, () =>
    session.channels.list().channels.find(({ id }) => id === channelId),
  );
  const muted = useConfirmedMute(session, channelId);
  // A thread you're in notifies like a DM: every reply counts.
  const unread = rowUnread(
    snapshot,
    !!rootId || channel?.channelType === "dm",
    muted,
  );
  return (
    <ConversationWork session={session} channelId={channelId} rootId={rootId}>
      {(work) => (
        <ConversationMenu
          channel={channel}
          message={
            rootId
              ? {
                  channelId,
                  messageId: rootId,
                  threadRootId: rootId,
                  text: label,
                }
              : undefined
          }
          onOpen={onOpen}
          onRead={undefined}
        >
          {children({
            unread,
            working: work && (
              <span className={styles.indicatorStack}>
                <WorkingAgentsBadge
                  agents={work.agents}
                  profiles={work.profiles}
                  channelName={channel?.name ?? label}
                  waiting={work.waiting}
                />
              </span>
            ),
          })}
        </ConversationMenu>
      )}
    </ConversationWork>
  );
}
