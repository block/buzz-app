import { ToastNotice } from "../shared/design-system/ui/Toast";
import { useState } from "react";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Button } from "../shared/design-system/ui/Button";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";

export function AgentSettings({ active = true }: { active?: boolean }) {
  const preference = useRememberAgentsPreference();
  const [error, setError] = useState<string | null>(null);
  const change = (enabled: boolean) =>
    setError(setRememberAgentsPreference(enabled));
  return (
    <section aria-labelledby="agent-settings-title">
      <h2 id="agent-settings-title" className="mt-0 mb-6 text-label">
        Agents
      </h2>
      <PreferenceRow
        label="Remember mentioned agents"
        description="Start your next message with the agents from your last one in the same channel or thread."
        checked={preference}
        onCheckedChange={change}
      />
      {active && error && (
        <ToastNotice title="Agent preference wasn’t saved" description={error}>
          <Button type="button" size="sm" onClick={() => change(preference)}>
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
