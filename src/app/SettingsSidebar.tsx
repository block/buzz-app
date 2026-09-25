import { useEffect, useSyncExternalStore } from "react";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Panel } from "../shared/design-system/ui/Panel";
import { ArrowLeftIcon } from "../shared/design-system/icons";
import type { SettingsCards } from "../features/settings/service";
import { settingsSections } from "./Settings";
import channelStyles from "../bundled/channels/Channels.module.css";
import styles from "./Settings.module.css";

const groups = [
  {
    label: "Personal",
    sections: ["profile", "appearance", "notifications", "shortcuts"],
  },
  { label: "App", sections: ["messages", "plugins", "developer"] },
] as const;

export function SettingsSidebar({
  selected,
  cards,
  onBack,
  onSection,
}: {
  selected: string;
  cards: SettingsCards;
  onBack: () => void;
  onSection: (section: string) => void;
}) {
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const selectedAvailable =
    settingsSections.some((section) => section.id === selected) ||
    contributed.some((card) => card.group && card.key === selected);
  const effectiveSelected = selectedAvailable ? selected : "profile";
  useEffect(() => {
    if (!selectedAvailable && selected !== "profile") onSection("profile");
  }, [onSection, selected, selectedAvailable]);
  const contributedGroups = [
    ...new Set(contributed.flatMap((card) => card.group ?? [])),
  ].map((label) => ({
    label,
    entries: contributed.filter((card) => card.group === label),
  }));
  return (
    <div className="shell-sidebar-default">
      <Panel as="aside" aria-label="Settings sidebar">
        <div className={`${channelStyles.sidebar} ${styles.settingsSidebar}`}>
          <NavigationItem
            label="Back"
            icon={<ArrowLeftIcon aria-hidden="true" size={18} />}
            onClick={onBack}
          />
          <nav
            aria-label="Settings sections"
            className={styles.settingsNavigation}
          >
            {groups.map((group) => {
              const entries = settingsSections.filter((section) =>
                (group.sections as readonly string[]).includes(section.id),
              );
              if (!entries.length) return null;
              return (
                <section
                  key={group.label}
                  aria-labelledby={`settings-${group.label}`}
                >
                  <h2
                    id={`settings-${group.label}`}
                    className={styles.settingsGroupTitle}
                  >
                    {group.label}
                  </h2>
                  <div className={styles.settingsGroupItems}>
                    {entries.map(({ id, label, icon: Icon }) => (
                      <NavigationItem
                        key={id}
                        label={label}
                        icon={<Icon aria-hidden="true" size={18} />}
                        selected={effectiveSelected === id}
                        onClick={() => onSection(id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {contributedGroups.map((group) => (
              <section
                key={group.label}
                aria-labelledby={`settings-${group.label}`}
              >
                <h2
                  id={`settings-${group.label}`}
                  className={styles.settingsGroupTitle}
                >
                  {group.label}
                </h2>
                <div className={styles.settingsGroupItems}>
                  {group.entries.map((card) => (
                    <NavigationItem
                      key={card.key}
                      label={card.title}
                      selected={effectiveSelected === card.key}
                      onClick={() => onSection(card.key)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </nav>
        </div>
      </Panel>
    </div>
  );
}
