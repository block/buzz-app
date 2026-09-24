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
  const library = useAgentChoices(session);
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
  );
  const list = useChannelList(session.channels);
  useEffect(() => {
    session.channelKit.ensure();
  }, [session]);
  useEffect(() => {
    // Channel discovery/access changes can invalidate a completed archive read.
    if (archives.status === "idle") void session.archives.ensure();
  }, [session, archives.status]);
  return {
    kit,
    agentsComplete: library.complete && list.status === "ready",
    agentsPending:
      library.pending || list.status === "idle" || list.status === "loading",
    agents: templateAgentChoices(library, list).filter(
      (a) => !archives.archived.includes(a.pubkey),
    ),
    agentsReady: library.status === "ready" && archives.status === "ready",
    error: library.error ?? archives.error ?? list.error,
    refresh: () => {
      void session.channelKit.refresh();
      void session.agentChoices.refresh();
      void session.archives.refresh();
      session.channels.refreshList?.();
    },
  };
}
