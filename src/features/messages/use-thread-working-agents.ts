import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { threadActivity } from "../../bundled/agent-activity/thread-activity";
import { useLoadedThread } from "./thread-views";
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
  const loaded = useLoadedThread(session, channelId, rootId);
  const read = useCallback(() => {
    const snapshot = activity?.snapshot();
    return snapshot
      ? threadActivity(snapshot, channelId, rootId, loaded?.replies)
          .filter((entry) => entry.working)
          .map((entry) => entry.agent)
          .join(":")
      : "";
  }, [activity, channelId, rootId, loaded]);
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
