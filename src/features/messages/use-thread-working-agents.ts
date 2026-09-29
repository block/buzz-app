import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { requestActivity } from "../../bundled/agent-activity/request-activity";
import { selectProfiles } from "../relay/profile-selection";
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

const noSubscribe = () => () => {};
const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
const noProfiles = () => emptyProfiles;

/** Exact thread evidence only; never fetches message history or starts an agent. */
export function useThreadWorkingAgents(
  session: RelaySession | undefined,
  channelId: string,
  rootId: string,
) {
  const activity = session?.agentActivity;
  const read = useCallback(() => {
    const snapshot = activity?.snapshot();
    if (snapshot?.status !== "listening") return "";
    const candidates = new Set([
      ...snapshot.typing
        .filter(
          (entry) =>
            entry.channelId === channelId && entry.threadRootId === rootId,
        )
        .map((entry) => entry.agent),
      ...snapshot.turns
        .filter(
          (turn) => turn.channelId === channelId && turn.state === "working",
        )
        .map((turn) => turn.agent),
    ]);
    return [...candidates]
      .filter((agent) => {
        const selected = requestActivity(
          snapshot.records,
          agent,
          channelId,
          rootId,
        );
        const linked = snapshot.turns.filter(
          (turn) =>
            turn.agent === agent &&
            turn.channelId === channelId &&
            selected.turnIds.has(turn.turnId),
        );
        if (linked.some((turn) => turn.state === "working")) return true;
        const ended = Math.max(
          -Infinity,
          ...linked
            .filter((turn) => turn.state === "ended")
            .map((turn) => turn.timestamp),
        );
        return snapshot.typing.some(
          (entry) =>
            entry.agent === agent &&
            entry.channelId === channelId &&
            entry.threadRootId === rootId &&
            entry.timestamp > ended,
        );
      })
      .sort()
      .join(":");
  }, [activity, channelId, rootId]);
  // Primitive projection: unrelated turns and heartbeat refreshes do not rerender rows.
  const keys = useSyncExternalStore(
    activity?.subscribe ?? noSubscribe,
    read,
    read,
  );
  const agents = useMemo(() => (keys ? keys.split(":") : []), [keys]);
  const selection = useMemo(
    () => session?.profiles && selectProfiles(session.profiles, agents),
    [session?.profiles, agents],
  );
  const profiles = useSyncExternalStore(
    selection?.subscribe ?? noSubscribe,
    selection?.snapshot ?? noProfiles,
    selection?.snapshot ?? noProfiles,
  );
  useEffect(() => {
    if (agents.length)
      void session?.profiles.ensure(agents, "background").catch(() => {});
  }, [session?.profiles, agents]);
  return { agents, profiles };
}
