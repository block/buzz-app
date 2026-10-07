import { useState } from "react";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type {
  Agent,
  Agents2,
  RegisteredAgentType,
} from "../../features/agents2/service";

/** The type's own tabs for one agent. Shared by the Agents2 page and the profile panel. */
export function AgentTabs({
  agents2,
  agent,
  type,
}: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType;
}) {
  const tabs = type.tabs ?? [];
  const [tab, setTab] = useState(tabs[0]?.id ?? "");
  const selected = tabs.find((item) => item.id === tab) ?? tabs[0];
  if (!selected)
    return (
      <p className="text-body-sm text-secondary">
        {type.title} has no settings.
      </p>
    );
  return (
    <Tabs
      value={selected.id}
      onValueChange={setTab}
      items={tabs.map((item) => ({ value: item.id, label: item.title }))}
      label={`${agent.name} sections`}
      variant="panel"
      renderPanel={(value) => {
        const Component = tabs.find((item) => item.id === value)?.component;
        return Component ? (
          <Component
            agent={agent}
            save={(change) => agents2.save(agent.pubkey, change)}
          />
        ) : null;
      }}
    />
  );
}
