import { ToastNotice } from "../shared/design-system/ui/Toast";
import { useState } from "react";
import { Switch } from "../shared/design-system/ui/Switch";
import { Button } from "../shared/design-system/ui/Button";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";

export function MessageSettings({ active = true }: { active?: boolean }) {
  const preference = useRememberAgentsPreference();
  const [error, setError] = useState<string | null>(null);
  const change = (enabled: boolean) =>
    setError(setRememberAgentsPreference(enabled));
  return (
    <section aria-labelledby="message-settings-title">
      <h2 id="message-settings-title" className="mt-0 mb-6 text-label">
        Messages
      </h2>
      <Switch
        label="Remember mentioned agents"
        checked={preference}
        onCheckedChange={change}
        aria-describedby="remember-agents-description"
      />
      <p id="remember-agents-description" className="text-body-sm text-muted">
        Start your next message with the agents you just mentioned in this
        channel or thread. People are not remembered. Saved on this device.
        Turning this off stops prefilling future messages; your current draft is
        unchanged.
      </p>
      {active && error && (
        <ToastNotice
          title="Message preference wasn’t saved"
          description={error}
        >
          <Button type="button" size="sm" onClick={() => change(preference)}>
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
