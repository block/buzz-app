import { useState } from "react";
import type { AgentView } from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { useChannelList } from "../../features/relay/react";
import { relayOrigin } from "../../features/communities/destination";
import { Button } from "../../shared/design-system/ui/Button";
import { prepareAgentDraft } from "./agent-channel-draft";

export function AgentChannelPicker({
  agent,
  connection,
  relay,
  navigator,
}: {
  agent: AgentView;
  connection: RelaySnapshot;
  relay: RelayData;
  navigator: Navigation;
}) {
  const list = useChannelList(connection.session.channels);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const channels = list.channels.filter(
    (channel) =>
      !channel.archived &&
      channel.channelType !== "dm" &&
      channel.members?.includes(agent.pubkey) &&
      !!connection.viewer &&
      channel.members.includes(connection.viewer),
  );
  const choose = async (channelId: string) => {
    if (opening) return;
    setError(undefined);
    const current = relay.snapshot();
    const currentList = current.session.channels.list();
    const channel = currentList.channels.find(
      (entry) => entry.id === channelId,
    );
    if (
      current !== connection ||
      currentList.status !== "ready" ||
      current.status !== "ready" ||
      !current.viewer ||
      current.scope !== `${relayOrigin(agent.relayUrl)}:${current.viewer}` ||
      !channel ||
      channel.archived ||
      channel.channelType === "dm" ||
      !channel.members?.includes(agent.pubkey) ||
      !channel.members.includes(current.viewer)
    ) {
      setError(
        "Channel membership or community changed. Refresh and choose again.",
      );
      return;
    }
    try {
      prepareAgentDraft(current.scope, channelId, {
        pubkey: agent.pubkey,
        name: agent.name,
      });
      setOpening(true);
      const result = await navigator.open({
        version: 1,
        kind: "conversation",
        channelId,
        scope: {
          viewer: current.viewer,
          communityOrigin: relayOrigin(agent.relayUrl),
        },
      });
      if (result.status !== "opened")
        setError(
          "The channel did not open. Your mention is saved in its draft; retry or open it from Channels. Nothing was sent.",
        );
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not open the channel. Nothing was sent.",
      );
    } finally {
      setOpening(false);
    }
  };
  return (
    <section
      aria-label={`Choose a channel for ${agent.name}`}
      className="space-y-2 border-t border-primary pt-3"
    >
      <p className="text-body-sm">
        Choose an existing channel. Your draft is preserved and a mention is
        added. Nothing is sent.
      </p>
      {!agent.enabled && (
        <p className="text-body-sm">
          This agent is stopped. You can prepare a draft, but it will not wake
          until started.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {list.status !== "ready" && (
        <p role="status">
          {list.status === "error" || list.status === "unavailable"
            ? "Channels are unavailable. Refresh or reconnect to retry."
            : "Loading channels…"}
        </p>
      )}
      {list.status === "ready" && !channels.length && (
        <p>
          No known shared channels in this community. Import does not add
          channel membership.
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        {channels.map((channel) => (
          <Button
            key={channel.id}
            disabled={opening || list.status !== "ready"}
            onClick={() => void choose(channel.id)}
          >
            #{channel.name}
          </Button>
        ))}
      </div>
      <Button
        disabled={opening || !connection.session.channels.refreshList}
        onClick={() => void connection.session.channels.refreshList?.()}
      >
        Refresh channels
      </Button>
    </section>
  );
}
