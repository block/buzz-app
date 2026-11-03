import { useState } from "react";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { opensInBrowser, saveOpensInBrowser } from "./links";

/** Where github.com links in messages open. */
export function LinkSettings() {
  const [browser, setBrowser] = useState(opensInBrowser);
  const [failed, setFailed] = useState(false);
  return (
    <section aria-label="GitHub links settings">
      <Header title="GitHub links" />
      <SettingsGroup>
        <SwitchPreferenceRow
          label="Open GitHub links in browser"
          description="Links in messages open in your browser instead of the side panel. Pull request links keep their state icon."
          checked={browser}
          onCheckedChange={(on) => {
            try {
              saveOpensInBrowser(on);
              setBrowser(on);
              setFailed(false);
            } catch {
              setFailed(true);
            }
          }}
        />
        {failed && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            Couldn’t save this setting on this device.
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
