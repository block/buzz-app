import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { currentActivity } from "../agents/current-activity";
import { useActivityTypingReplacement } from "../conversation/typing-presentation";
const noSubscribe = () => () => {};
const noActivity = () => undefined;
const empty: ReturnType<RelaySession["typing"]["snapshot"]> = [];
const noTyping = () => empty;

/** A current, rendered activity row owns the live signal for its exact scope. */
export function useActivityIndicator(
  session: RelaySession | undefined,
  row: ChannelMessage,
  eligible: boolean,
  participants?: readonly string[],
) {
  const typing = useSyncExternalStore(
    session?.typing?.subscribe ?? noSubscribe,
    session?.typing?.snapshot ?? noTyping,
  );
  const activity = useSyncExternalStore(
    session?.agentActivity?.subscribe ?? noSubscribe,
    session?.agentActivity?.snapshot ?? noActivity,
  );
  const represented = new Set(participants ?? [row.authorId]);
  const detail = eligible
    ? currentActivity(
        activity,
        typing,
        represented,
        row.channelId,
        row.threadRootId,
      )
    : undefined;
  const liveAgents = [...(detail ?? [])]
    .filter(
      ([agent, value]) =>
        represented.has(agent) &&
        value.roots.includes(row.threadRootId ?? null),
    )
    .map(([agent]) => agent);
  const live = liveAgents.length > 0;
  useActivityTypingReplacement(
    session
      ? {
          session,
          channelId: row.channelId,
          threadRootId: row.threadRootId,
          pubkey: row.authorId,
        }
      : undefined,
    live,
    liveAgents,
  );
  return live;
}
