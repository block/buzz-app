import type { Agents } from "../../features/agents/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { useAgents, useChannelChoices } from "../../features/agents/react";
import { AttentionPanel } from "../../features/agents/AttentionPanel";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { EyeIcon } from "../../shared/design-system/icons";

export function AttentionPage({
  agents,
  relay,
}: {
  agents: Agents;
  relay: RelayData;
}) {
  const { snapshot } = useAgents(agents);
  const connection = useRelayConnection(relay);
  const channels = useChannelChoices(
    connection.status === "ready" ? connection.session.channels : undefined,
  );
  return (
    <FullPageSurface aria-label="Attention">
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader
          title={
            <PanelHeaderLabel title="Attention" icon={<EyeIcon size={16} />} />
          }
        />
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto grid max-w-3xl gap-6">
            <p className="m-0 text-body-sm text-secondary">
              Interests hold each agent’s task instructions. Subscriptions
              listen for events, schedules or function output, then deliver to a
              conversation or start an independent turn.
            </p>
            {snapshot.running.length === 0 && (
              <EmptyState
                icon={<EyeIcon size={24} />}
                title="No agents"
                description="Create an agent in Agents to manage its attention here."
              />
            )}
            {snapshot.running.map((agent) => (
              <section
                key={agent.pubkey}
                aria-label={agent.name}
                className="grid gap-3"
              >
                <InlineHeader title={agent.name} />
                <AttentionPanel
                  agent={agent}
                  channels={channels}
                  classifier={snapshot.classifier}
                  save={(patch) => agents.save(agent.pubkey, patch)}
                />
              </section>
            ))}
          </div>
        </div>
      </div>
    </FullPageSurface>
  );
}
