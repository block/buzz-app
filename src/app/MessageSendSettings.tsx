import { useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { formatBinding } from "../features/shortcuts/format";
import {
  MOD_ENTER,
  sendWithModEnterPreference,
} from "../features/messages/send-keystroke";

export function MessageSendSettings({
  apple,
  active,
}: {
  apple: boolean;
  active: boolean;
}) {
  const sendWithModEnter = sendWithModEnterPreference.useEnabled();
  const [saveError, setSaveError] = useState<string | null>(null);
  const change = (enabled: boolean) =>
    setSaveError(sendWithModEnterPreference.setEnabled(enabled));
  const modEnter = formatBinding(MOD_ENTER, apple).text;
  return (
    <section>
      <InlineHeader title="Messages" />
      <SettingsGroup>
        <SwitchPreferenceRow
          label={`Send with ${modEnter}`}
          description="Enter adds a new line instead of sending."
          checked={sendWithModEnter}
          onCheckedChange={change}
        />
      </SettingsGroup>
      {active && saveError && (
        <ToastNotice
          title="Message preference wasn’t saved"
          description={saveError}
        >
          <Button
            type="button"
            size="sm"
            onClick={() => change(sendWithModEnter)}
          >
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
