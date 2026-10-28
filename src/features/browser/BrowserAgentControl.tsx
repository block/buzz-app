import { useMemo, useState } from "react";
import type { Agents } from "../agents/service";
import { useAgentsSnapshot } from "../agents/react";
import { useAgentChoices } from "../agents/use-choices";
import { useChannelList, useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import type { BrowserViewProps } from "./api";
import type { BrowserAccess } from "./control-access";
import type { BrowserStatus } from "./platform";
import { BrowserControlBar } from "./BrowserControlBar";
import { Select } from "../../shared/design-system/ui/Select";

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
}) {
  if (!props.host || !props.conversation)
    return (
      <p className="text-body-sm">
        Open this website from a conversation to share it with an agent.
      </p>
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
}: {
  host: BrowserAgentHost;
  conversation: NonNullable<BrowserViewProps["conversation"]>;
  sessionId: string;
  status: BrowserStatus;
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
  const [selected, setSelected] = useState("");
  const pubkey =
    (candidates.some((item) => item.pubkey === selected) ? selected : "") ||
    (choices.complete && candidates.length === 1
      ? (candidates[0]?.pubkey ?? "")
      : "");
  const candidate = candidates.find((item) => item.pubkey === pubkey);
  const agent = agents?.running.find(
    (item) =>
      item.pubkey === pubkey &&
      item.place === "here" &&
      item.owner === connection.viewer &&
      host.agents.relay(item.key)?.snapshot().scope === connection.scope,
  );
  const root =
    channel?.channelType === "solo" || channel?.channelType === "dm"
      ? undefined
      : conversation.root;
  const scope = connection.scope ?? "";
  const control = useMemo(
    () =>
      host.access.forRecipient({
        agent: agent?.key ?? "",
        scope,
        channel: conversation.channel,
        root,
      }),
    [host.access, agent?.key, scope, conversation.channel, root],
  );
  const name = candidate?.managedName || candidate?.name || pubkey;
  return (
    <BrowserControlBar
      picker={
        candidates.length > 1 || !choices.complete ? (
          <Select
            label="Browser agent"
            value={pubkey}
            onValueChange={setSelected}
            groups={[
              {
                label: "Conversation agents",
                options: candidates.map((item) => ({
                  value: item.pubkey,
                  label: item.managedName || item.name || item.pubkey,
                })),
              },
            ]}
            placeholder="Choose an agent"
          />
        ) : null
      }
      key={`${scope}:${conversation.channel}:${root ?? ""}:${agent?.key ?? pubkey}`}
      control={control}
      sessionId={sessionId}
      status={status}
      agentName={name}
      eligible={
        !!agent &&
        !!candidate &&
        connection.status === "ready" &&
        !connection.cached
      }
      unavailable={
        candidate
          ? `${name} isn’t running in this Buzz instance. Start a local agent here to share this browser.`
          : "Choose an agent from this conversation. Add a local agent here if none are listed."
      }
    />
  );
}
