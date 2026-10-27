// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's tabs, settings, and Memory.
// Memory is relay-backed for both local and hosted agents. Agents classified
// as `elsewhere` expose no sections in these views.
import { useId, useState, type ReactNode } from "react";
import { AttentionPanel } from "./AttentionPanel";
import { MemoryPanel, type AgentMemories } from "./MemoryPanel";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "./service";
import { AgentSaveButton } from "./AgentSaveButton";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>`, `agent:settings`, `agent:activity`
   * or `agent:memory`; never collides with a host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents,
  agent,
  type,
  conversation,
  settingsHost,
  memories,
  settingsSection,
  settingsContent,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  conversation?: AgentConversation | undefined;
  settingsHost?: AgentSettingsHost;
  settingsSection?: "identity" | "runtime";
  settingsContent?: ReactNode;
  /** Memory reads through the owner's session; absent while it connects. */
  memories: AgentMemories | undefined;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const attention =
    settingsContent === undefined && agent.place === "here" ? (
      <AttentionSection agents={agents} agent={agent} />
    ) : null;
  const content = attention || settingsContent;
  const typeTabs = type?.tabs ?? [];
  const settingsTab = typeTabs.find((tab) => tab.role === "settings");
  const orderedTabs =
    settingsHost && settingsTab
      ? [settingsTab, ...typeTabs.filter((tab) => tab !== settingsTab)]
      : typeTabs;
  const tabs = orderedTabs.map(({ id, title, role, component: Component }) => ({
    value: (role ? `agent:${role}` : `agent:type:${id}`) as `agent:${string}`,
    label: title,
    render: () => (
      <Component
        agent={agent}
        {...(role === "settings" && settingsSection ? { settingsSection } : {})}
        {...(role === "settings" && content
          ? { settingsContent: content }
          : {})}
        {...(conversation && { conversation })}
        save={(config) =>
          settingsHost?.pendingSave
            ? settingsHost.pendingSave(config)
            : agents.save(agent.key, { config })
        }
        {...(role === "settings" && settingsHost ? { settingsHost } : {})}
      />
    ),
  }));
  if (!settingsTab && (settingsHost || attention))
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => (
        <>
          {settingsHost && <HostSettings host={settingsHost} />}
          {attention}
        </>
      ),
    });
  return [
    ...tabs,
    {
      value: "agent:memory",
      label: "Memory",
      render: () => <MemoryPanel agent={agent} memories={memories} />,
    },
  ];
}

function HostSettings({ host }: { host: AgentSettingsHost }) {
  const form = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!host.pendingSave) return;
    setSaving(true);
    setError("");
    try {
      await host.pendingSave();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      id={form}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {host.typeControl?.(false)}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <AgentSaveButton
        form={form}
        saving={saving}
        disabled={!host.pendingSave}
      />
    </form>
  );
}

/** The one device-local Attention control, beside the agent’s settings. */
function AttentionSection({
  agents,
  agent,
}: {
  agents: Pick<Agents, "save">;
  agent: Agent;
}) {
  return (
    <AttentionPanel
      agent={agent}
      save={(change) => agents.save(agent.key, change)}
    />
  );
}
