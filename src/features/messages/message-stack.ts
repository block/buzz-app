import type { ChannelMessage } from "../relay/contracts";
import { continuesMessageGroup } from "./message-grouping";

/** Bubble stacks use the same author/time boundaries as ordinary message groups. */
export function messagesStack(
  previous: ChannelMessage | undefined,
  next: ChannelMessage | undefined,
): boolean {
  return !!next && continuesMessageGroup(previous, next);
}
