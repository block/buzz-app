import type { ChannelMessage } from "../relay/contracts";

export function continuesMessageGroup(
  previous: ChannelMessage | undefined,
  current: ChannelMessage,
  /** Callers that already know both rows' local days can skip the conversion. */
  sameDay?: boolean,
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
    previous.audience === current.audience &&
    current.createdAt >= previous.createdAt &&
    current.createdAt - previous.createdAt <= 5 * 60 &&
    (sameDay ??
      new Date(previous.createdAt * 1000).toDateString() ===
        new Date(current.createdAt * 1000).toDateString())
  );
}
