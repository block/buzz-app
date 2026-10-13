// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's own tabs, then the app's Attention tab, which every
// agent here shares because the app is what wakes it. Hosted agents' tabs are
// their type's alone; an agent on another device has none here.
import type { ReactNode } from "react";
import type { ChannelChoice } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import { AgentSettingsDisclosure } from "./AgentSettingsDisclosure";
import type {
  Agent,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "./service";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>` or `agent:attention`; never collides with a host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents,
  agent,
  type,
  channels,
  settingsHost,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  settingsHost?: AgentSettingsHost;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const typeTabs = type?.tabs ?? [];
  const settingsTab = settingsHost
    ? typeTabs.find((tab) => tab.role === "settings")
    : undefined;
  const orderedTabs = settingsTab
    ? [settingsTab, ...typeTabs.filter((tab) => tab !== settingsTab)]
    : typeTabs;
  const tabs = orderedTabs.map(({ id, title, role, component: Component }) => ({
    value: (role === "settings"
      ? "agent:settings"
      : `agent:type:${id}`) as `agent:${string}`,
    label: title,
    render: () => (
      <Component
        agent={agent}
        save={(config) => agents.save(agent.pubkey, { config })}
        {...(role === "settings" && settingsHost ? { settingsHost } : {})}
      />
    ),
  }));
  if (settingsHost && !settingsTab)
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => <AgentSettingsDisclosure host={settingsHost} />,
    });
  if (agent.place === "hosted") return tabs;
  return [
    ...tabs,
    {
      value: "agent:attention",
      label: "Attention",
      render: () => (
        <AttentionPanel
          agent={agent}
          save={(change) => agents.save(agent.pubkey, change)}
          channels={channels}
        />
      ),
    },
  ];
}
