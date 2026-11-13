import { useEffect, useSyncExternalStore } from "react";
import type { Agents } from "../agents/service";
import { prepareSoloMove } from "../channel-navigation/solo-navigation";
import { relayPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import { eligibleSolo } from "./labels";
import { NewWorkspace } from "./NewWorkspace";

/** Why a proposed chat can't be filed here; checked before anything is saved. */
function filingBlocker(
  session: RelaySession,
  chats: readonly string[],
): string | undefined {
  const list = session.channels.list();
  if (list.status !== "ready")
    return "Your chats are still loading. Try again in a moment.";
  for (const id of chats) {
    const chat =
      list.channels.find((channel) => channel.id === id) ??
      session.channels.get?.(id);
    if (!chat || !eligibleSolo(chat, session.viewer))
      return `Chat ${id} isn't one of your Solo chats in this community.`;
    const managed = prepareSoloMove(session, id);
    if (managed) return managed;
  }
}

/** The owner reviews an agent's proposed workspace in New workspace, one
 * request at a time; saving creates it and files the proposed chats. */
export function WorkspaceCreateReview({
  agents,
  session,
}: {
  agents: Agents;
  session: RelaySession | undefined;
}) {
  useEffect(() => session?.channels.ensureList(), [session]);
  const requests = useSyncExternalStore(
    agents.subscribe,
    agents.workspaceCreateRequests,
  );
  const request = session
    ? requests.find(
        (item) => relayPartition(item.community, item.owner) === session.scope,
      )
    : undefined;
  if (!session || !request) return null;
  const dismiss = () => agents.dismissWorkspaceCreate(request.id);
  const chats = request.chats.length;
  return (
    <NewWorkspace
      key={request.id}
      session={session}
      initial={request}
      description={`${request.requesterName} proposed this workspace${chats ? ` and ${chats === 1 ? "1 chat" : `${chats} chats`} to file in it` : ""}. Nothing is created until you save.`}
      create={async (project) => {
        const blocked = filingBlocker(session, request.chats);
        if (blocked) throw new Error(blocked);
        await session.soloPreferences.createSection(project);
        for (const chat of request.chats)
          await session.soloPreferences.assign(chat, project.id);
      }}
      close={dismiss}
      onCreated={dismiss}
    />
  );
}
