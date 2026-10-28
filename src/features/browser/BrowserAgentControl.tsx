import type { Agents } from "../agents/service";
import { useAgentsSnapshot } from "../agents/react";
import { useAgentChoices } from "../agents/use-choices";
import { useChannelList, useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import type { BrowserViewProps } from "./api";
import type { BrowserAccess } from "./control-access";
import type { BrowserStatus } from "./platform";
import { BrowserControlBar } from "./BrowserControlBar";

export type BrowserAgentHost = {
  access: BrowserAccess;
  agents: Agents;
  relay: RelayData;
};

export function BrowserAgentControl(props: {
  host?: BrowserAgentHost | undefined;
  conversation: BrowserViewProps["conversation"];
  sessionId: string;
  status: BrowserStatus;
  prepare(): Promise<void>;
  onError(error: string | undefined): void;
}) {
  if (!props.host || !props.conversation)
    return (
      <BrowserControlBar
        recipients={[]}
        sessionId={props.sessionId}
        status={props.status}
        prepare={props.prepare}
        onError={props.onError}
      />
    );
  return (
    <ConversationControl
      {...props}
      host={props.host}
      conversation={props.conversation}
    />
  );
}

function ConversationControl({
  host,
  conversation,
  sessionId,
  status,
  prepare,
  onError,
}: {
  host: BrowserAgentHost;
  conversation: NonNullable<BrowserViewProps["conversation"]>;
  sessionId: string;
  status: BrowserStatus;
  prepare(): Promise<void>;
  onError(error: string | undefined): void;
}) {
  const connection = useRelayConnection(host.relay);
  const choices = useAgentChoices(connection.session, true, true);
  const channels = useChannelList(connection.session.channels);
  const agents = useAgentsSnapshot(host.agents);
  const channel = channels.channels.find(
    (item) => item.id === conversation.channel,
  );
  const candidates = choices.selectable.filter((item) =>
    channel?.members?.includes(item.pubkey),
  );
  const root =
    channel?.channelType === "solo" || channel?.channelType === "dm"
      ? undefined
      : conversation.root;
  const scope = connection.scope ?? "";
  const recipients = candidates.map((candidate) => {
    const agent = agents?.running.find(
      (item) =>
        item.pubkey === candidate.pubkey &&
        item.place === "here" &&
        item.owner === connection.viewer &&
        host.agents.relay(item.key)?.snapshot().scope === scope,
    );
    const name = candidate.managedName || candidate.name || candidate.pubkey;
    return {
      id: candidate.pubkey,
      name,
      eligible: !!agent && connection.status === "ready" && !connection.cached,
      unavailable: `${name} isn’t running in this Buzz instance. Start a local agent here to share this browser.`,
      control: host.access.forRecipient({
        agent: agent?.key ?? "",
        scope,
        channel: conversation.channel,
        root,
      }),
    };
  });
  return (
    <BrowserControlBar
      key={`${scope}:${conversation.channel}:${root ?? ""}`}
      recipients={recipients}
      complete={choices.complete}
      sessionId={sessionId}
      status={status}
      prepare={prepare}
      onError={onError}
    />
  );
}
