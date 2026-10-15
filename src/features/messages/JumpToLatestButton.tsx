import { ArrowDownIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelaySession } from "../relay/session";
import styles from "./Messages.module.css";
import { useConversationAgents } from "./TypingIndicator";

/** The conversation whose composer, a following sibling of this history, shows activity. */
export type ActivityLane = Readonly<{
  session: RelaySession;
  channelId: string;
  threadRootId?: string | undefined;
}>;
type Props = {
  visible: boolean;
  newMessageCount: number;
  onClick(): void;
};

export function JumpToLatestButton({
  activityLane,
  ...props
}: Props & { activityLane?: ActivityLane | undefined }) {
  return activityLane ? (
    <ConversationJumpToLatest lane={activityLane} {...props} />
  ) : (
    <JumpToLatest {...props} />
  );
}

// Only this leaf, and only where a lane can apply, subscribes to typing state.
function ConversationJumpToLatest({
  lane,
  ...props
}: Props & { lane: ActivityLane }) {
  const { agents } = useConversationAgents(
    lane.session,
    lane.channelId,
    lane.threadRootId,
  );
  return <JumpToLatest {...props} activityLane={agents.length > 0} />;
}

function JumpToLatest({
  visible,
  newMessageCount,
  onClick,
  activityLane = false,
}: Props & { activityLane?: boolean }) {
  const label =
    newMessageCount > 0
      ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
      : "Jump to latest";
  return (
    <div
      className={styles.jumpToLatest}
      inert={!visible}
      aria-hidden={!visible}
      data-visible={visible}
      data-activity-lane={activityLane || undefined}
    >
      <div className={styles.jumpToLatestSurface}>
        <Button
          data-jump-to-latest=""
          size="xs"
          shape="capsule"
          variant="ghost"
          onClick={onClick}
        >
          <ArrowDownIcon size={16} aria-hidden="true" />
          {label}
        </Button>
      </div>
    </div>
  );
}
