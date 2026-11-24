import { SettingsSearchNavigation } from "./SettingsSearchNavigation";
import type { SettingSearchEntry } from "./settings-search";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { CommunityAddress } from "./CommunityAddress";
import { useMemo, useSyncExternalStore } from "react";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { ChatCircleIcon } from "../shared/design-system/icons";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import { RecommendationCount } from "./RecommendationCount";
import { settingsSections, type SettingsSection } from "./settings-sections";

export function SettingsSidebar({
  cards,
  communities,
  selected,
  recommendations = 0,
  onSection,
  onSetting,
  shortcutBindings,
}: {
  cards: SettingsCards;
  communities: Communities;
  selected?: string;
  /** Managed plugin recommendations awaiting review. */
  recommendations?: number;
  onSection: (section: string) => void;
  onSetting?: (setting: SettingSearchEntry) => void;
  shortcutBindings?: ShortcutBindings;
}) {
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  const { groups, defaultSection } = useMemo(
    () => settingsSections(contributed, selectedCommunity),
    [contributed, selectedCommunity],
  );
  const current = selected ?? defaultSection;
  const section = ({
    id,
    label,
    icon: Icon = ChatCircleIcon,
  }: SettingsSection) => (
    <NavigationItem
      key={id}
      label={label}
      icon={<Icon aria-hidden="true" size={18} />}
      selected={current === id}
      {...(id === "plugins" && recommendations > 0
        ? { trailing: <RecommendationCount count={recommendations} /> }
        : {})}
      aria-current={current === id ? "page" : undefined}
      onClick={() => onSection(id)}
    />
  );

  return (
    <SettingsSearchNavigation
      groups={groups}
      onSection={onSection}
      onSetting={onSetting ?? ((entry) => onSection(entry.section))}
      shortcutBindings={shortcutBindings}
    >
      {selectedCommunity && (
        <NavigationSection>
          <CommunityAddress
            communities={communities}
            community={selectedCommunity}
          />
        </NavigationSection>
      )}
      {groups.map((group) => (
        <NavigationSection key={group.id} label={group.label}>
          {group.sections.map(section)}
        </NavigationSection>
      ))}
    </SettingsSearchNavigation>
  );
}
