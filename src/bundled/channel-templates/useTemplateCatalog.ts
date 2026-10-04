import { avatarMedia } from "../../shared/avatar-source";
import { useEffect, useSyncExternalStore } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { templateAgentChoices } from "../../features/agents/choices";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
export function useTemplateCatalog(session: RelaySession) {
  const kit = useSyncExternalStore(
    session.channelKit.subscribe,
    session.channelKit.snapshot,
  );
  // Keep legacy artwork available just as Agents does; its readiness does not
  // gate native selection or preflight. Archive evidence comes with the choices.
  const library = useAgentChoices(session, true, true);
  const { archives } = library;
  const list = useChannelList(session.channels);
  useEffect(() => {
    session.channelKit.ensure();
  }, [session]);
  const { templates } = library;
  return {
    kit,
    agentsComplete: templates.complete && list.status === "ready",
    agentsPending:
      templates.pending || list.status === "idle" || list.status === "loading",
    agents: templateAgentChoices(library, list).map((agent) => ({
      ...agent,
      avatar: avatarMedia(agent.avatar, session.media),
    })),
    agentsReady: templates.status === "ready" && archives.status === "ready",
    error: templates.error ?? archives.error ?? list.error,
    refresh: () => {
      void session.channelKit.refresh();
      void session.agentChoices.refresh("templates");
      session.channels.refreshList?.();
    },
  };
}
