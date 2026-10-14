import { useState, type ReactNode } from "react";
import type { ChannelChoice } from "../../features/agents/attention";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import { agentSections } from "../../features/agents/tabs";
import { Tabs } from "../../shared/design-system/ui/Tabs";

/** An agent's sections as tabs, opening on the first. */
export function AgentTabs(props: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  settingsHost: AgentSettingsHost;
  memories: AgentMemories | undefined;
  settingsContent: ReactNode;
  conversation?: AgentConversation | undefined;
}) {
  const split = props.type?.tabs?.some(
    (section) => section.role === "settings" && section.splitSettings,
  );
  const supplied = agentSections({
    ...props,
    ...(split ? { settingsSection: "identity" as const } : {}),
  });
  const runtime = split
    ? agentSections({ ...props, settingsSection: "runtime" }).find(
        (section) => section.value === "agent:settings",
      )
    : undefined;
  const identity = supplied.find(
    (section) => section.value === "agent:settings",
  );
  const sections = [
    ...(identity ? [{ ...identity, label: "Identity" }] : []),
    ...supplied.filter((section) => section.value.startsWith("agent:type:")),
    ...supplied.filter((section) => section.value === "agent:memory"),
    ...supplied.filter((section) => section.value === "agent:attention"),
    {
      value: "agent:management",
      label: "Settings",
      render: () => <>{runtime ? runtime.render() : props.settingsContent}</>,
    },
  ];
  const [tab, setTab] = useState<string>(sections[0]?.value ?? "");
  const selected =
    sections.find((section) => section.value === tab) ?? sections.at(-1);
  return (
    <Tabs
      value={selected?.value ?? ""}
      onValueChange={setTab}
      items={sections.map(({ value, label }) => ({ value, label }))}
      label={`${props.agent.name} sections`}
      variant="panel"
      renderPanel={(value) => (
        <div className="grid gap-6 pt-4">
          {sections.find((section) => section.value === value)?.render()}
        </div>
      )}
    />
  );
}
