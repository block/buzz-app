import { useSyncExternalStore } from "react";
import { Header } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  type ActivityDisplay,
  activityDisplays,
  type Display,
} from "./display";

/** Activity's choices in Settings → Plugins. */
export function ActivitySettings({
  display,
  active,
}: {
  display: Display;
  active(): boolean;
}) {
  const current = useSyncExternalStore(display.subscribe, display.snapshot);
  const error = useSyncExternalStore(display.subscribe, display.error);
  return (
    <section aria-label="Activity settings">
      <Header title="Activity" />
      <SettingsGroup>
        <PreferenceRow
          title="Show Activity as"
          subtitle="The full Activity page, a card in the sidebar, or both."
          trailing={
            <Select
              label="Show Activity as"
              variant="compact"
              value={current}
              groups={[
                {
                  label: "",
                  options: activityDisplays.map(([value, label]) => ({
                    value,
                    label,
                  })),
                },
              ]}
              onValueChange={(next) => {
                if (active()) display.set(next as ActivityDisplay);
              }}
            />
          }
        />
      </SettingsGroup>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
