import { useEffect, useState, useSyncExternalStore } from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  SquaresFourIcon,
  UserIcon,
  PaletteIcon,
  BellIcon,
  WrenchIcon,
  CpuIcon,
  WalletIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Communities } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import { DeveloperSettings } from "./DeveloperSettings";

import { CommunityComputePage } from "../bundled/community-compute/CommunityComputePage";
import { CreditsSandbox } from "../bundled/community-compute/CreditsSandbox";

type Section = { id: string; label: string; icon: typeof UserIcon };

const baseSections: Section[] = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "plugins", label: "Plugins", icon: SquaresFourIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
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
  plugins,
  communities,
  appearance,
  notifications,
  navigation,
  onSection,
}: {
  plugins: PluginManager;
  communities: Communities;
  appearance: Appearance;
  notifications: NotificationsService;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
}) {
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const computeEnabled =
    activation["buzz.community-compute"]?.status === "active";
  const availableSections = computeEnabled
    ? [...sections, { id: "compute", label: "Compute", icon: CpuIcon }]
    : sections;
  const settingsSections = developerMode
    ? [
        ...availableSections,
        { id: "wallet", label: "Wallet (demo)", icon: WalletIcon },
      ]
    : availableSections;
  const [selected, setSelected] = useState<string>("profile");
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? "profile")
      : undefined;
  const requestedSectionAvailable =
    requestedSection === "wallet"
      ? developerMode
      : requestedSection === "compute"
        ? computeEnabled
        : sections.some((section) => section.id === requestedSection);
  useEffect(() => {
    if (requestedSection && requestedSectionAvailable)
      setSelected(requestedSection);
  }, [requestedSection, requestedSectionAvailable]);
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  return (
    <section aria-labelledby="settings-title" className={styles.root}>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <h1 id="settings-title" className="m-0 px-3 py-4 text-label">
            Settings
          </h1>
          <nav aria-label="Settings sections" className={styles.navigation}>
            {settingsSections.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={selected === id ? "page" : undefined}
                className={styles.navigationRow}
                onClick={(event) => {
                  event.currentTarget.focus();
                  if (onSection) onSection(id);
                  else setSelected(id);
                }}
              >
                <Icon aria-hidden="true" size={18} />
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <div className={styles.detail}>
          {selected === "compute" &&
            (computeEnabled ? (
              <CommunityComputePage relay={communities.relay} />
            ) : (
              <p role="status">Enable Compute in Plugins to configure it.</p>
            ))}
          {developerMode && (
            <div hidden={selected !== "wallet"}>
              <section aria-labelledby="wallet-settings-title">
                <h2 id="wallet-settings-title" className="mt-0 mb-2 text-label">
                  Wallet
                </h2>
                <p className="mt-0 mb-6 text-body-sm text-muted">
                  A local-only credits prototype for exploring the earn, spend,
                  and ledger experience.
                </p>
                <CreditsSandbox />
              </section>
            </div>
          )}
          <div hidden={selected !== "notifications"}>
            <NotificationSettings notifications={notifications} />
          </div>
          <div hidden={selected !== "appearance"}>
            <AppearanceSettings appearance={appearance} />
          </div>
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
              <h2 id="plugin-settings-title" className="mt-0 mb-6 text-label">
                Plugins
              </h2>
              {catalog ? (
                <PluginImport plugins={plugins} catalog={catalog} busy={busy} />
              ) : configuration.status === "recovery" ? (
                <RecoveryScreen plugins={plugins} />
              ) : (
                <p role="status">
                  Plugin settings are unavailable. Profile and Appearance still
                  work.
                </p>
              )}
              <div className="overflow-hidden">
                <div>
                  {externalPluginsPaused && (
                    <p role="status" className="notice">
                      External plugins are paused for this launch. Your saved
                      enabled settings are unchanged; you can still manage
                      plugins here.
                    </p>
                  )}
                  {refreshError && (
                    <div role="alert" className="notice">
                      <p>
                        Couldn’t refresh plugin settings. Showing the last
                        available configuration; retrying automatically.
                      </p>
                      <p>{refreshError}</p>
                    </div>
                  )}
                  {error && (
                    <div role="alert" className="notice">
                      <p>
                        That change could not be confirmed. Check the current
                        settings before trying again.
                      </p>
                      <p>{error}</p>
                      <button type="button" onClick={plugins.dismissError}>
                        Dismiss
                      </button>
                    </div>
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
                        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
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
                          <button
                            type="button"
                            role="switch"
                            aria-checked={plugin.enabled}
                            aria-label={`Enable ${plugin.manifest.name}`}
                            className="group flex h-7 w-12 shrink-0 items-center rounded-full border-0 bg-toggle-track p-1 transition-colors motion-reduce:transition-none aria-checked:bg-primary"
                            aria-disabled={busy}
                            onClick={(event) => {
                              if (busy) return;
                              // Keep keyboard focus through the manager's busy transition,
                              // including when disabling a plugin removes its open card.
                              event.currentTarget.focus();
                              void plugins.change(
                                plugin.enabled ? "disable" : "enable",
                                id,
                              );
                            }}
                          >
                            <span className="size-5 rounded-full bg-toggle-thumb shadow-sm transition-transform motion-reduce:transition-none group-aria-checked:translate-x-5" />
                          </button>
                          {plugin.previous && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => plugins.change("rollback", id)}
                            >
                              Roll back
                            </button>
                          )}
                          {plugin.source === "external" && (
                            <button
                              type="button"
                              className="danger"
                              disabled={busy}
                              onClick={() => plugins.change("remove", id)}
                            >
                              Delete
                            </button>
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
    </section>
  );
}
