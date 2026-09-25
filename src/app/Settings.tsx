import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { Button } from "../shared/design-system/ui/Button";
import { Switch } from "../shared/design-system/ui/Switch";
import { useEffect, useState, useSyncExternalStore } from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  SquaresFourIcon,
  UserIcon,
  PaletteIcon,
  BellIcon,
  ChatCircleIcon,
  KeyboardIcon,
  WrenchIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Communities } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutSettings } from "./ShortcutSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { MessageSettings } from "./MessageSettings";
import type { SettingsCards } from "../features/settings/service";
import { OwnedContribution } from "../plugins/OwnedContribution";

type Section = { id: string; label: string; icon: typeof UserIcon };

const baseSections: Section[] = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "plugins", label: "Plugins", icon: SquaresFourIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "messages", label: "Messages", icon: ChatCircleIcon },
  { id: "notifications", label: "Notifications", icon: BellIcon },
];

// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too.
export const developerMode =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

const sections: Section[] = developerMode
  ? [...baseSections, { id: "developer", label: "Developer", icon: WrenchIcon }]
  : baseSections;

export function Settings({
  cards,
  plugins,
  communities,
  appearance,
  shortcuts,
  shortcutBindings,
  notifications,
  navigation,
  onSection,
}: {
  cards: SettingsCards;
  plugins: PluginManager;
  communities: Communities;
  appearance: Appearance;
  shortcuts: ShortcutsService;
  shortcutBindings: ShortcutBindings;
  notifications: NotificationsService;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
}) {
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const messageCards = contributed.filter((card) => !card.group);
  const groups = [
    ...new Set(contributed.flatMap((card) => card.group ?? [])),
  ].map((label) => ({
    label,
    cards: contributed.filter((card) => card.group === label),
  }));
  const [chosen, setSelected] = useState("profile");
  // A grouped card's section is its contribution key; it closes with its plugin.
  const selected =
    sections.some((section) => section.id === chosen) ||
    contributed.some((card) => card.group && card.key === chosen)
      ? chosen
      : "profile";
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? "profile")
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      (sections.some((section) => section.id === requestedSection) ||
        contributed.some((card) => card.group && card.key === requestedSection))
    )
      setSelected(requestedSection);
  }, [requestedSection, contributed]);
  const choose = (id: string) => {
    if (onSection) onSection(id);
    else setSelected(id);
  };
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  return (
    <div className={styles.root}>
      <Panel aria-labelledby="settings-title">
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <h1 id="settings-title" className="m-0 px-3 py-4 text-label">
              Settings
            </h1>
            <nav aria-label="Settings sections" className={styles.navigation}>
              {sections.map(({ id, label, icon: Icon }) => (
                <NavigationItem
                  label={label}
                  icon={<Icon aria-hidden="true" size={18} />}
                  selected={selected === id}
                  type="button"
                  key={id}
                  aria-current={selected === id ? "page" : undefined}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    choose(id);
                  }}
                />
              ))}
              {groups.map((group) => (
                <NavigationSection key={group.label} label={group.label}>
                  {group.cards.map((card) => (
                    <NavigationItem
                      label={card.title}
                      selected={selected === card.key}
                      type="button"
                      key={card.key}
                      aria-current={selected === card.key ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        choose(card.key);
                      }}
                    />
                  ))}
                </NavigationSection>
              ))}
            </nav>
          </aside>
          <div className={styles.detail}>
            <div hidden={selected !== "notifications"}>
              <NotificationSettings
                notifications={notifications}
                active={selected === "notifications"}
              />
            </div>
            <div hidden={selected !== "appearance"}>
              <AppearanceSettings
                appearance={appearance}
                active={selected === "appearance"}
              />
            </div>
            <div hidden={selected !== "shortcuts"}>
              <ShortcutSettings
                shortcuts={shortcuts}
                bindings={shortcutBindings}
                plugins={plugins}
              />
            </div>
            <div hidden={selected !== "messages"}>
              <MessageSettings active={selected === "messages"} />
              {selected === "messages" &&
                messageCards.map((card) => (
                  <OwnedContribution
                    key={card.key}
                    entry={card}
                    registry={cards}
                  >
                    {(entry, active) => {
                      const Card = entry.component;
                      return <Card active={active} />;
                    }}
                  </OwnedContribution>
                ))}
            </div>
            {contributed.map(
              (card) =>
                card.group &&
                selected === card.key && (
                  <OwnedContribution
                    key={card.key}
                    entry={card}
                    registry={cards}
                  >
                    {(entry, active) => {
                      const Card = entry.component;
                      return <Card active={active} />;
                    }}
                  </OwnedContribution>
                ),
            )}
            <div hidden={selected !== "profile"}>
              <ProfileSettings communities={communities} />
            </div>
            {developerMode && (
              <div hidden={selected !== "developer"}>
                <DeveloperSettings relay={communities.relay} />
              </div>
            )}
            <div hidden={selected !== "plugins"}>
              <section aria-labelledby="plugin-settings-title">
                <Header
                  id="plugin-settings-title"
                  title="Plugins"
                  subtitle={
                    !plugins.imports
                      ? "Open the desktop app to load plugins from a folder or Git repository."
                      : undefined
                  }
                />
                {catalog ? (
                  <PluginImport
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                  />
                ) : configuration.status === "recovery" ? (
                  <RecoveryScreen plugins={plugins} />
                ) : (
                  <p role="status">
                    Plugin settings are unavailable. Profile and Appearance
                    still work.
                  </p>
                )}
                <div className="overflow-hidden">
                  <div>
                    {externalPluginsPaused && (
                      <p role="status" className="text-body-sm text-subtle">
                        External plugins are paused for this launch. Your saved
                        enabled settings are unchanged; you can still manage
                        plugins here.
                      </p>
                    )}
                    {selected === "plugins" && refreshError && (
                      <ToastNotice
                        title="Plugin settings couldn’t refresh"
                        description={`Showing the last available configuration; retrying automatically. ${refreshError}`}
                      />
                    )}
                    {selected === "plugins" && error && (
                      <ToastNotice
                        title="Plugin change wasn’t confirmed"
                        description={`Check the current settings before trying again. ${error}`}
                        onDismiss={plugins.dismissError}
                        closeLabel="Dismiss"
                      />
                    )}
                  </div>
                  <div className="divide-y divide-line">
                    {catalog?.plugins.map((plugin) => {
                      const id = plugin.manifest.id;
                      const running = activation[id];
                      const failure =
                        plugin.error ??
                        (running?.revision === plugin.revision
                          ? running.error
                          : null);
                      return (
                        <article
                          className="flex flex-wrap items-center justify-between gap-3 px-1 py-3"
                          key={id}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-soft text-muted">
                              <SquaresFourIcon aria-hidden="true" size={17} />
                            </span>
                            <div className="min-w-0">
                              <h3 className="m-0 text-label font-medium">
                                {plugin.manifest.name}
                              </h3>
                              {failure && (
                                <p role="alert" className="error">
                                  {failure}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="actions items-center">
                            {/* Channels is required and has no enable/disable control. */}
                            {id !== "buzz.channels" && (
                              <Switch
                                aria-label={`Enable ${plugin.manifest.name}`}
                                checked={plugin.enabled}
                                readOnly={busy}
                                aria-disabled={busy}
                                onClick={(event) => event.currentTarget.focus()}
                                onCheckedChange={() => {
                                  if (busy) return;
                                  void plugins.change(
                                    plugin.enabled ? "disable" : "enable",
                                    id,
                                  );
                                }}
                              />
                            )}
                            {plugin.previous && (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => plugins.change("rollback", id)}
                              >
                                Roll back
                              </Button>
                            )}
                            {plugin.reloadable && !plugin.enabled && (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => plugins.reload(id)}
                              >
                                Reload
                              </Button>
                            )}
                            {plugin.source === "external" && (
                              <Button
                                type="button"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => plugins.change("remove", id)}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
