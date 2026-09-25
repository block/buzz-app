import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Panel } from "../shared/design-system/ui/Panel";
import { ArrowLeftIcon } from "../shared/design-system/icons";
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
  onBack,
  onSection,
}: {
  selected: string;
  onBack: () => void;
  onSection: (section: string) => void;
}) {
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
                        selected={selected === id}
                        onClick={() => onSection(id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </nav>
        </div>
      </Panel>
    </div>
  );
}
