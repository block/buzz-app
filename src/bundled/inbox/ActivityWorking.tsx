import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { breathing, localActivity } from "../../features/agents/local-activity";
import { threadWorkingAgents } from "../../features/agents/thread-working";
import { useChannelActivitySubscription } from "../../features/agents/use-channel-agent-activity";
import type { Profile } from "../../features/relay/contracts";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { RelaySession } from "../../features/relay/session";
import { useWorkingAgents } from "../channels/useWorkingAgents";
import { workingAgentDetails } from "../channels/working-agents";

/** Your agents working in a row's conversation, and what the first one is
 * doing now. */
export type ActivityWork = {
  agents: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  waiting: boolean;
  step: string | undefined;
};
type Render = (work: ActivityWork | undefined) => ReactNode;

/** The first agent's current step, as the "Working now" list shows it. */
function useStep(
  session: RelaySession,
  channelId: string,
  agent: string | undefined,
) {
  const subscribe = useChannelActivitySubscription(
    session.agentActivity,
    channelId,
  );
  return useSyncExternalStore(agent ? subscribe : noSubscribe, () =>
    agent
      ? workingAgentDetails(
          session.agentActivity.snapshot(channelId),
          channelId,
          agent,
        )?.label
      : undefined,
  );
}
const noSubscribe = () => () => {};
const none: ReadonlyMap<string, Profile> = new Map();
const noProfiles = () => none;

/** Who is working in a card row's conversation. A thread row has only its thread's work; any other row has its
 * conversation's, threads included. Only the viewer's own agents count. */
export function ActivityWorking({
  session,
  channelId,
  rootId,
  children,
}: {
  session: RelaySession;
  channelId: string;
  rootId: string | undefined;
  children: Render;
}) {
  return rootId ? (
    <ThreadWorking session={session} channelId={channelId} rootId={rootId}>
      {children}
    </ThreadWorking>
  ) : (
    <ConversationWorking session={session} channelId={channelId}>
      {children}
    </ConversationWorking>
  );
}

function ConversationWorking({
  session,
  channelId,
  children,
}: {
  session: RelaySession;
  channelId: string;
  children: Render;
}) {
  const working = useSyncExternalStore(
    session.agentActivity.subscribeWorking,
    () =>
      (
        JSON.parse(session.agentActivity.workingSnapshot()) as string[]
      ).includes(channelId),
  );
  const { agents, agentProfiles, waiting } = useWorkingAgents(
    session,
    channelId,
    working,
  );
  const step = useStep(session, channelId, agents[0]);
  return children(
    agents.length
      ? { agents, profiles: agentProfiles, waiting, step }
      : undefined,
  );
}

function ThreadWorking({
  session,
  channelId,
  rootId,
  children,
}: {
  session: RelaySession;
  channelId: string;
  rootId: string;
  children: Render;
}) {
  const readTyping = () =>
    session.typing
      .snapshot()
      .filter(
        (entry) =>
          entry.channelId === channelId && entry.threadRootId === rootId,
      )
      .map((entry) => entry.pubkey)
      .join(",");
  const typing = useSyncExternalStore(session.typing.subscribe, readTyping);
  const subscribe = useChannelActivitySubscription(
    session.agentActivity,
    channelId,
  );
  const readWork = () => {
    const activity = session.agentActivity.snapshot(channelId);
    const agents = threadWorkingAgents(
      activity,
      typing ? typing.split(",") : [],
      channelId,
      rootId,
    );
    const local = localActivity(activity, channelId, rootId);
    const waiting =
      agents.length > 0 && agents.every((agent) => breathing(local.get(agent)));
    return `${waiting ? "waiting" : "working"}:${agents.join(",")}`;
  };
  const work = useSyncExternalStore(subscribe, readWork);
  const [state, joined = ""] = work.split(/:(.*)/s);
  const working = joined ? joined.split(",") : [];
  const library = useSyncExternalStore(
    working.length ? session.agentChoices.subscribe : noSubscribe,
    working.length ? session.agentChoices.snapshot : () => undefined,
  );
  const agents =
    library?.identities
      .filter(({ pubkey }) => working.includes(pubkey))
      .map(({ pubkey }) => pubkey) ?? [];
  const ids = agents.join(",");
  const selection = useMemo(
    () => (ids ? selectProfiles(session.profiles, ids.split(",")) : undefined),
    [session, ids],
  );
  const profiles = new Map(
    useSyncExternalStore(
      selection?.subscribe ?? noSubscribe,
      selection?.snapshot ?? noProfiles,
    ),
  );
  for (const agent of library?.identities ?? [])
    if (agents.includes(agent.pubkey) && !profiles.get(agent.pubkey)?.name)
      profiles.set(agent.pubkey, {
        ...profiles.get(agent.pubkey),
        name: agent.name,
      });
  const step = useStep(session, channelId, agents[0]);
  return children(
    agents.length
      ? { agents, profiles, waiting: state === "waiting", step }
      : undefined,
  );
}
