import { useState } from "react";
import {
  AttentionPanel,
  type ChannelChoice,
} from "../../features/agents2/AttentionPanel";
import type {
  Agent,
  Agents2,
  RegisteredAgentType,
} from "../../features/agents2/service";
import { Tabs } from "../../shared/design-system/ui/Tabs";

// Plugin tab ids are prefixed so none can collide with the host's.
const ATTENTION = "host:attention";
const tabValue = (id: string) => `plugin:${id}`;

/** The type's own tabs for one agent, then the app's Attention tab, which every
 * type shares because the app is what wakes the agent. */
export function AgentTabs({
  agents2,
  agent,
  type,
  channels,
}: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
}) {
  const tabs = type?.tabs ?? [];
  const [tab, setTab] = useState(tabs[0] ? tabValue(tabs[0].id) : ATTENTION);
  const save = (change: Parameters<Agents2["save"]>[1]) =>
    agents2.save(agent.pubkey, change);
  const items = [
    ...tabs.map((item) => ({ value: tabValue(item.id), label: item.title })),
    { value: ATTENTION, label: "Attention" },
  ];
  return (
    <Tabs
      value={items.some((item) => item.value === tab) ? tab : ATTENTION}
      onValueChange={setTab}
      items={items}
      label={`${agent.name} sections`}
      variant="panel"
      renderPanel={(value) => {
        if (value === ATTENTION)
          return (
            <div className="pt-4">
              <AttentionPanel agent={agent} save={save} channels={channels} />
            </div>
          );
        const Component = tabs.find(
          (item) => tabValue(item.id) === value,
        )?.component;
        return Component ? <Component agent={agent} save={save} /> : null;
      }}
    />
  );
}
