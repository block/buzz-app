import type { Agents } from "../../../../src/features/agents/service";
import type { RelayData } from "../../../../src/features/relay/service";
import type { BrowserToolbarProps } from "../../../../src/features/browser/api";
import type { BrowserAccess } from "../../../../src/features/browser/control-access";
import type { BrowserStatus } from "../../../../src/features/browser/platform";
import type { BrowserInitialShare, BrowserConversation } from "./types";
import { createControlBar } from "./ControlBar";
export type BrowserAgentHost = {
  access: Pick<BrowserAccess, "forRecipient">;
  agents: Agents;
  relay: RelayData;
};

export function createAgentControl(
  React: typeof import("react"),
  ui: BrowserToolbarProps["ui"],
) {
  const BrowserControlBar = createControlBar(React, ui);
  const { useSyncExternalStore, useEffect } = React;
  function useRelayConnection(relay: RelayData) {
    return useSyncExternalStore(
      relay.subscribe,
      relay.snapshot,
      relay.snapshot,
    );
  }
  function useAgentsSnapshot(agents: Agents) {
    return useSyncExternalStore(
      agents.subscribe,
      agents.snapshot,
      agents.snapshot,
    );
  }
  function useAgentChoices(
    session: ReturnType<RelayData["snapshot"]>["session"],
  ) {
    const source = session.agentChoices;
    const choices = useSyncExternalStore(
      source.subscribe,
      source.snapshot,
      source.snapshot,
    );
    useEffect(() => source.retain(), [source]);
    useEffect(() => {
      if (choices.pending || choices.archives.status === "idle")
        source.ensure(true, true);
    }, [source, choices]);
    return choices;
  }
  function useChannelList(
    queries: ReturnType<RelayData["snapshot"]>["session"]["channels"],
  ) {
    useEffect(() => queries.ensureList(), [queries]);
    return useSyncExternalStore(
      queries.subscribeList,
      queries.list,
      queries.list,
    );
  }
  function BrowserAgentControl(props: {
    initialShare?: BrowserInitialShare | undefined;
    host?: BrowserAgentHost | undefined;
    conversation: BrowserConversation | undefined;
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
    initialShare,
  }: {
    initialShare?: BrowserInitialShare | undefined;
    host: BrowserAgentHost;
    conversation: BrowserConversation;
    sessionId: string;
    status: BrowserStatus;
    prepare(): Promise<void>;
    onError(error: string | undefined): void;
  }) {
    const connection = useRelayConnection(host.relay);
    const choices = useAgentChoices(connection.session);
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
        eligible:
          !!agent && connection.status === "ready" && !connection.cached,
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
        initialShare={initialShare}
        recipients={recipients}
        complete={choices.complete}
        sessionId={sessionId}
        status={status}
        prepare={prepare}
        onError={onError}
      />
    );
  }

  return BrowserAgentControl;
}
