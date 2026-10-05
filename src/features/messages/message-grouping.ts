import { calendarDay } from "../../shared/date-environment";
import type { ChannelMessage } from "../relay/contracts";

export function continuesMessageGroup(
  previous: ChannelMessage | undefined,
  current: ChannelMessage,
): boolean {
  return (
    !!previous &&
    !previous.membership &&
    !current.membership &&
    // Legacy output has no workflow ID: one relay signer is not one workflow.
    !previous.workflowOwnerId &&
    !current.workflowOwnerId &&
    !current.sentFromThread &&
    !previous.sentFromThread &&
    previous.channelId === current.channelId &&
    previous.authorId === current.authorId &&
    current.createdAt >= previous.createdAt &&
    current.createdAt - previous.createdAt <= 5 * 60 &&
    calendarDay(previous.createdAt * 1000).key ===
      calendarDay(current.createdAt * 1000).key
  );
}
