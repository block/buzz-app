import { Header } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import { setShowsOverflow, useShowsOverflow } from "./sidebar-overflow";

/** The sidebar's choices in Settings. */
export function SidebarSettings({ active }: { active(): boolean }) {
  const shows = useShowsOverflow();
  return (
    <section aria-label="Sidebar settings">
      <Header title="Sidebar" />
      <SettingsGroup>
        <PreferenceRow
          title="Show all conversations"
          subtitle="Team, Direct messages and Solo list everything not in a workspace or Favorites. Off, find them with Command K."
          trailing={
            <Switch
              aria-label="Show all conversations"
              checked={shows}
              onCheckedChange={(next) => {
                if (active()) setShowsOverflow(next);
              }}
            />
          }
        />
      </SettingsGroup>
    </section>
  );
}
