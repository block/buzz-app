import type { Agents } from "../features/agents/service";
import { AgentDefaults } from "../bundled/agents/AgentDefaults";
import { Header } from "../shared/design-system/ui/Header";

export function AgentSettings({
  agents,
  active = true,
}: {
  agents?: Agents | undefined;
  active?: boolean;
}) {
  return (
    <section aria-labelledby="agent-settings-title">
      <Header id="agent-settings-title" title="AI providers" />
      {agents && active && <AgentDefaults agents={agents} />}
    </section>
  );
}
