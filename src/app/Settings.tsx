import type { Agents } from "../features/agents/service";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { ChoiceRow } from "../shared/design-system/ui/ChoiceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  CheckCircleIcon,
  SparklesIcon,
  SquaresFourIcon,
  XIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { PluginInfo } from "../plugins/types";
import type { Communities, Membership } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { PluginReadme } from "./PluginReadme";
import { bundledReadmes } from "../bundled/readmes";
import { bundledIcons } from "../bundled/icons";
import type { Identity } from "../features/identity/service";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutSettings } from "./ShortcutSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { AgentSettings } from "./AgentSettings";
import type { SettingsCards } from "../features/settings/service";
import { OwnedContribution } from "../plugins/OwnedContribution";
import type { Updates } from "../features/updates/updates";
import { UpdateSettings } from "../features/updates/UpdateSettings";
import { CommunityDepartureSettings } from "./CommunityDepartureSettings";
import { developerMode, settingsSections } from "./settings-sections";

import { pluginCategoryDefinitions } from "./plugin-categories";

function isRequiredPlugin(plugin: PluginInfo) {
  return plugin.manifest.id === "buzz.channels";
}

function isEssentialPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.discovery?.tags?.some(
      (tag) => tag.trim().toLowerCase() === "essentials",
    ) ??
      false)
  );
}

function comparePlugins(a: PluginInfo, b: PluginInfo) {
  return (
    Number(isRequiredPlugin(b)) - Number(isRequiredPlugin(a)) ||
    Number(isEssentialPlugin(b)) - Number(isEssentialPlugin(a))
  );
}

function groupPlugins(plugins: readonly PluginInfo[]) {
  const known = new Map<string, PluginInfo[]>(
    pluginCategoryDefinitions.map(({ id }) => [id, []]),
  );
  const other: PluginInfo[] = [];
  for (const plugin of plugins) {
    const group = known.get(plugin.manifest.discovery?.category ?? "");
    (group ?? other).push(plugin);
  }
  for (const entries of known.values()) entries.sort(comparePlugins);
  other.sort(comparePlugins);
  return [
    ...pluginCategoryDefinitions.flatMap(({ id, label }) => {
      const entries = known.get(id) ?? [];
      return entries.length ? [{ id, label, plugins: entries }] : [];
    }),
    ...(other.length ? [{ id: "other", label: "Other", plugins: other }] : []),
  ];
}

function PluginIcon({
  plugin,
  size = 24,
}: {
  plugin: PluginInfo;
  size?: number;
}) {
  const url =
    plugin.source === "bundled"
      ? bundledIcons.get(plugin.manifest.id)
      : undefined;
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span className={styles.pluginIcon} aria-hidden="true">
      {url && url !== failedUrl ? (
        <img src={url} alt="" onError={() => setFailedUrl(url)} />
      ) : (
        <SquaresFourIcon size={size} />
      )}
    </span>
  );
}

function PluginProvenance({
  source,
  publisher,
  className,
}: {
  source: "bundled" | "external";
  publisher?: string | null | undefined;
  className?: string | undefined;
}) {
  if (source !== "bundled" && !publisher) return null;
  return (
    <span className={`${styles.pluginProvenance} ${className ?? ""}`}>
      <span>{source === "bundled" ? "Buzz" : publisher}</span>
    </span>
  );
}

/** Narrow containers cover the catalog with details (Settings.module.css). */
function covered(element: Element | null) {
  return !!element && getComputedStyle(element).visibility === "hidden";
}

function PluginDetails({
  plugin,
  failure,
  busy,
  plugins,
  close,
  onClose,
}: {
  plugin: PluginInfo;
  failure: string | null;
  busy: boolean;
  plugins: PluginManager;
  close: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useLayoutEffect(() => {
    close.current?.focus();
  }, [close]);
  // READMEs ship with Buzz; never attach one to an external plugin.
  const readme =
    plugin.source === "bundled" && bundledReadmes.get(plugin.manifest.id);
  const otherTags = (plugin.manifest.discovery?.tags ?? []).filter(
    (tag) =>
      !isEssentialPlugin(plugin) || tag.trim().toLowerCase() !== "essentials",
  );
  return (
    <aside
      id="plugin-details"
      className={styles.pluginAside}
      aria-label={`${plugin.manifest.name} details`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.pluginAsideHeader}>
        <div className={styles.pluginAsideIdentity}>
          <PluginIcon plugin={plugin} size={48} />
          <h2>{plugin.manifest.name}</h2>
          <div className={styles.pluginBadges}>
            {plugin.source === "bundled" ? (
              <span className={styles.pluginInstallBadge}>
                <CheckCircleIcon size={14} aria-hidden="true" />
                Made by Buzz
              </span>
            ) : (
              <PluginProvenance
                source={plugin.source}
                publisher={plugin.publisher}
              />
            )}
            {isEssentialPlugin(plugin) && (
              <span
                className={`${styles.pluginInstallBadge} ${styles.pluginTag}`}
                data-essential
              >
                <SparklesIcon size={14} aria-hidden="true" />
                Essentials
              </span>
            )}
          </div>
          {plugin.manifest.description && (
            <p className={styles.pluginAsideDescription}>
              {plugin.manifest.description}
            </p>
          )}
        </div>
        <IconButton
          ref={close}
          aria-label="Close plugin details"
          size="sm"
          icon={<XIcon size={16} aria-hidden="true" />}
          onClick={onClose}
        />
      </div>
      {plugin.source === "external" && (
        <span className={styles.pluginInstallBadge}>
          <CheckCircleIcon size={14} aria-hidden="true" />
          Installed
        </span>
      )}
      <div className={styles.pluginStatus}>
        {/* Channels is required and has no enable/disable control. */}
        {plugin.manifest.id === "buzz.channels" ? (
          <Button variant="outline" size="sm" disabled>
            Required
          </Button>
        ) : (
          <Button
            variant={plugin.enabled ? "subtle" : "prominent"}
            size="sm"
            disabled={busy}
            focusableWhenDisabled
            onClick={() => {
              if (busy) return;
              void plugins.change(
                plugin.enabled ? "disable" : "enable",
                plugin.manifest.id,
              );
            }}
          >
            {plugin.enabled ? "Disable" : "Enable"}
          </Button>
        )}
      </div>
      {readme && (
        <section
          className={styles.pluginAsideSection}
          aria-label={`${plugin.manifest.name} README`}
        >
          <PluginReadme key={plugin.manifest.id} text={readme} />
        </section>
      )}
      <section
        className={styles.pluginAsideSection}
        aria-labelledby="plugin-metadata-title"
      >
        <h3 id="plugin-metadata-title">Details</h3>
        <table
          className={styles.pluginMetadata}
          aria-labelledby="plugin-metadata-title"
        >
          <tbody>
            <tr>
              <th scope="row">Identifier</th>
              <td>
                <code>{plugin.manifest.id}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Plugin API</th>
              <td>{plugin.manifest.apiVersion}</td>
            </tr>
            {otherTags.length > 0 && (
              <tr>
                <th scope="row">Tags</th>
                <td>{otherTags.join(", ")}</td>
              </tr>
            )}
            {plugin.source === "external" && (
              <>
                <tr>
                  <th scope="row">Revision</th>
                  <td>
                    <code>{plugin.revision}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Signature</th>
                  <td>{plugin.hasSignature ? "Signed" : "Unsigned"}</td>
                </tr>
                {plugin.publisher && (
                  <tr>
                    <th scope="row">Publisher</th>
                    <td>
                      <code title={plugin.publisher}>{plugin.publisher}</code>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </section>
      {failure && (
        <p role="alert" className="error text-body-sm">
          {failure}
        </p>
      )}
      <div className="actions items-center">
        {plugin.previous && (
          <Button
            type="button"
            disabled={busy || !!plugin.rollbackBlockedReason}
            onClick={() => plugins.change("rollback", plugin.manifest.id)}
          >
            Roll back
          </Button>
        )}
        {plugin.rollbackBlockedReason && (
          <span className="text-body-sm text-muted">
            {plugin.rollbackBlockedReason}
          </span>
        )}
        {plugin.reloadable && !plugin.enabled && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => plugins.reload(plugin.manifest.id)}
          >
            Reload
          </Button>
        )}
        {plugin.source === "external" && (
          <Button
            type="button"
            ref={deleteTrigger}
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            Delete
          </Button>
        )}
      </div>
      {confirmDelete && (
        <AlertDialog
          title={`Delete ${plugin.manifest.name}?`}
          description="Removes this plugin and its rollback history from Buzz. You can install it again later."
          pending={busy || deleting}
          finalFocus={deleteTrigger}
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Button
                disabled={busy || deleting}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || deleting}
                onClick={async () => {
                  if (busy || deleting) return;
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    if (await plugins.change("remove", plugin.manifest.id))
                      setConfirmDelete(false);
                    else
                      setDeleteError(
                        plugins.snapshot().error ??
                          "Plugin deletion wasn’t confirmed. Try again.",
                      );
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                Delete plugin
              </Button>
            </>
          }
        >
          {deleteError && (
            <p role="alert" className="error text-body-sm">
              {deleteError}
            </p>
          )}
        </AlertDialog>
      )}
    </aside>
  );
}

export function Settings({
  agents,
  cards,
  plugins,
  communities,
  identity,
  appearance,
  shortcuts,
  shortcutBindings,
  notifications,
  updates,
  navigation,
  onSection,
  navigationPane = false,
  onDeparturePending,
}: {
  agents?: Agents | undefined;
  cards: SettingsCards;
  plugins: PluginManager;
  communities: Communities;
  identity?: Identity | undefined;
  appearance: Appearance;
  shortcuts: ShortcutsService;
  shortcutBindings: ShortcutBindings;
  notifications: NotificationsService;
  updates: Updates;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
  navigationPane?: boolean;
  onDeparturePending?: (pending: boolean) => void;
}) {
  useEffect(() => cards.retainVisibility(), [cards]);
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  // Local removal drops the saved membership before session disposal/purge
  // settles. Retain only this action's context so its modal can finish.
  const [departure, setDeparture] = useState<{
    community: Membership;
    viewer: string | undefined;
  } | null>(null);
  const departureCommunity =
    departure?.viewer === client.viewer
      ? (departure?.community ?? selectedCommunity)
      : selectedCommunity;
  const { groups, sections, defaultSection } = useMemo(
    () => settingsSections(contributed, departureCommunity),
    [contributed, departureCommunity],
  );
  const [selected, setSelected] = useState(defaultSection);
  const departureFocus = useRef(false);
  useLayoutEffect(() => {
    if (selected !== "profile" || !departureFocus.current) return;
    departureFocus.current = false;
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    if (
      departure &&
      (selected !== "leave-community" ||
        departure.viewer !== client.viewer ||
        (client.selected !== null &&
          client.selected !== departure.community.id))
    )
      setDeparture(null);
  }, [client.selected, client.viewer, departure, selected]);
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? defaultSection)
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      sections.some((section) => section.id === requestedSection)
    )
      setSelected(requestedSection);
    else if (!sections.some((section) => section.id === selected)) {
      setSelected(defaultSection);
      if (requestedSection === selected) onSection?.(defaultSection);
    }
  }, [defaultSection, onSection, requestedSection, selected, sections]);
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  const pluginGroups = useMemo(
    () => groupPlugins(catalog?.plugins ?? []),
    [catalog?.plugins],
  );
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [updatingPluginId, setUpdatingPluginId] = useState<string>();
  const [pluginImportActions, setPluginImportActions] =
    useState<HTMLSpanElement | null>(null);
  const pluginTrigger = useRef<HTMLButtonElement>(null);
  const restorePluginFocus = useRef(false);
  const pluginSection = useRef<HTMLElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const detailsClose = useRef<HTMLButtonElement>(null);
  const selectedPlugin = catalog?.plugins.find(
    (plugin) => plugin.manifest.id === selectedPluginId,
  );
  const showingDetails = selected === "plugins" && !!selectedPlugin;
  const visibleReturn = (target: HTMLElement | null) =>
    covered(pluginSection.current) ? (detailsClose.current ?? target) : target;
  useEffect(() => {
    if (selected !== "plugins") setSelectedPluginId(undefined);
  }, [selected]);
  useEffect(() => {
    const element = layout.current;
    if (!showingDetails || !element) return;
    // Resizing can hide the focused catalog control; keep focus in details.
    const observer = new ResizeObserver(() => {
      const active = document.activeElement;
      const details = detailsClose.current?.closest("aside");
      if (
        covered(pluginSection.current) &&
        (active === document.body ||
          (!!active && element.contains(active) && !details?.contains(active)))
      )
        detailsClose.current?.focus();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showingDetails]);
  useEffect(() => {
    if (selectedPluginId && catalog && !selectedPlugin) {
      pluginSection.current?.focus();
      setSelectedPluginId(undefined);
    }
  }, [catalog, selectedPlugin, selectedPluginId]);
  const closePluginDetails = () => {
    restorePluginFocus.current = true;
    setSelectedPluginId(undefined);
  };
  useLayoutEffect(() => {
    if (!selectedPlugin && restorePluginFocus.current) {
      restorePluginFocus.current = false;
      pluginTrigger.current?.focus();
    }
  }, [selectedPlugin]);
  const selectedRunning = selectedPlugin
    ? activation[selectedPlugin.manifest.id]
    : undefined;
  const selectedFailure = selectedPlugin
    ? (selectedPlugin.error ??
      (selectedRunning?.revision === selectedPlugin.revision
        ? selectedRunning.error
        : null))
    : null;
  const authorizePluginGit = async (repository: string) => {
    const connection = communities.relay.snapshot();
    return connection.status === "ready"
      ? ((await connection.session.authorizeGit?.(repository)) ?? null)
      : null;
  };
  return (
    <div
      className={`${styles.root} ${navigationPane ? styles.navigationPane : ""}`}
    >
      <Panel
        aria-label={navigationPane ? "Settings" : undefined}
        aria-labelledby={navigationPane ? undefined : "settings-title"}
      >
        <div
          ref={layout}
          className={styles.layout}
          data-plugin-detail={showingDetails ? "" : undefined}
        >
          <aside className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <h1 id="settings-title" className="m-0 text-label">
                Settings
              </h1>
            </div>
            <nav aria-label="Settings sections" className={styles.navigation}>
              {groups.map((group) => (
                <NavigationSection key={group.id} label={group.label}>
                  {group.sections.map(({ id, label, icon: Icon }) => (
                    <NavigationItem
                      label={label}
                      icon={Icon && <Icon aria-hidden="true" size={18} />}
                      selected={selected === id}
                      type="button"
                      key={id}
                      aria-current={selected === id ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        if (onSection) onSection(id);
                        else setSelected(id);
                      }}
                    />
                  ))}
                </NavigationSection>
              ))}
            </nav>
          </aside>
          <div className={`${styles.detail} buzz-settings-page`}>
            {navigationPane && <h1 className="sr-only">Settings</h1>}
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
            <div hidden={selected !== "agents"}>
              <AgentSettings
                agents={agents}
                archive={
                  <ArchiveSettings
                    relay={communities.relay}
                    community={selectedCommunity?.name}
                    active={selected === "agents"}
                  />
                }
                active={selected === "agents"}
              />
            </div>
            <div hidden={selected !== "updates"}>
              <UpdateSettings
                updates={updates}
                active={selected === "updates"}
              />
            </div>
            {contributed.map(
              (card) =>
                selected === card.key && (
                  <OwnedContribution
                    key={card.key}
                    entry={card}
                    registry={cards}
                  >
                    {(entry, active) => {
                      const Card = entry.component;
                      return (
                        <Card
                          active={active}
                          {...(!card.group && selectedCommunity
                            ? { community: selectedCommunity }
                            : {})}
                        />
                      );
                    }}
                  </OwnedContribution>
                ),
            )}
            {departureCommunity && selected === "leave-community" && (
              <CommunityDepartureSettings
                key={`${client.viewer}:${departureCommunity.id}`}
                communities={communities}
                community={departureCommunity}
                onPending={(pending) => {
                  onDeparturePending?.(pending);
                  setDeparture(
                    pending
                      ? { community: departureCommunity, viewer: client.viewer }
                      : null,
                  );
                }}
                onRemoved={() => {
                  departureFocus.current = true;
                  if (onSection) onSection("profile");
                  else setSelected("profile");
                }}
              />
            )}
            <div hidden={selected !== "profile"}>
              <ProfileSettings
                key={`${client.viewer}:${selectedCommunity?.id ?? "local"}`}
                communities={communities}
                community={selectedCommunity}
                identity={identity}
                active={selected === "profile"}
              />
            </div>
            {developerMode && (
              <div hidden={selected !== "developer"}>
                <DeveloperSettings relay={communities.relay} />
              </div>
            )}
            <div hidden={selected !== "plugins"}>
              <section
                ref={pluginSection}
                tabIndex={-1}
                aria-labelledby="plugin-settings-title"
              >
                <Header
                  id="plugin-settings-title"
                  title="Plugins"
                  actions={
                    plugins.imports && catalog ? (
                      <span ref={setPluginImportActions} />
                    ) : undefined
                  }
                />
                {catalog ? (
                  <PluginImport
                    actionTarget={pluginImportActions}
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                    authorizeGit={authorizePluginGit}
                    returnFocus={() => visibleReturn(null)}
                  />
                ) : configuration.status === "recovery" ? (
                  <RecoveryScreen plugins={plugins} />
                ) : (
                  <p role="status">
                    Plugin settings are unavailable. Profile and Appearance
                    still work.
                  </p>
                )}
                {catalog && updatingPluginId && (
                  <PluginImport
                    updateId={updatingPluginId}
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                    authorizeGit={authorizePluginGit}
                    onClosed={() => setUpdatingPluginId(undefined)}
                    returnFocus={() =>
                      visibleReturn(
                        Array.from(
                          pluginSection.current?.querySelectorAll<HTMLButtonElement>(
                            "[data-plugin-update-id]",
                          ) ?? [],
                        ).find(
                          (button) =>
                            button.dataset.pluginUpdateId === updatingPluginId,
                        ) ?? pluginSection.current,
                      )
                    }
                  />
                )}
                <div>
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
                  <div className={styles.pluginCategories}>
                    {pluginGroups.map((group) => (
                      <section
                        aria-labelledby={`plugin-category-${group.id}`}
                        key={group.id}
                      >
                        <InlineHeader
                          id={`plugin-category-${group.id}`}
                          title={
                            <span className={styles.pluginCategoryTitle}>
                              <span>{group.label}</span>
                              <span className={styles.pluginCount}>
                                {group.plugins.length}
                                <span className="sr-only">
                                  {group.plugins.length === 1
                                    ? " plugin"
                                    : " plugins"}
                                </span>
                              </span>
                            </span>
                          }
                        />
                        <SettingsGroup>
                          {group.plugins.map((plugin) => {
                            const id = plugin.manifest.id;
                            const active = id === selectedPluginId;
                            const running = activation[id];
                            const failure =
                              plugin.error ??
                              (running?.revision === plugin.revision
                                ? running.error
                                : null);
                            return (
                              <div key={id}>
                                <article className={styles.plugin}>
                                  <button
                                    type="button"
                                    className={styles.pluginRow}
                                    data-enabled={plugin.enabled}
                                    data-updatable={
                                      (plugin.source === "external" &&
                                        !!plugins.imports) ||
                                      undefined
                                    }
                                    aria-label={`View ${plugin.manifest.name} details`}
                                    aria-describedby={
                                      [
                                        plugin.manifest.description
                                          ? `plugin-description-${id}`
                                          : null,
                                        plugin.source === "external" &&
                                        plugin.publisher
                                          ? `plugin-publisher-${id}`
                                          : null,
                                        isEssentialPlugin(plugin)
                                          ? `plugin-essential-${id}`
                                          : null,
                                      ]
                                        .filter(Boolean)
                                        .join(" ") || undefined
                                    }
                                    aria-expanded={active}
                                    aria-controls={
                                      active ? "plugin-details" : undefined
                                    }
                                    onClick={(event) => {
                                      pluginTrigger.current =
                                        event.currentTarget;
                                      setSelectedPluginId(
                                        active ? undefined : id,
                                      );
                                    }}
                                  >
                                    {isEssentialPlugin(plugin) && (
                                      <span
                                        id={`plugin-essential-${id}`}
                                        className="sr-only"
                                      >
                                        Essential
                                      </span>
                                    )}
                                    <ChoiceRow
                                      leading={<PluginIcon plugin={plugin} />}
                                      label={
                                        <span className={styles.pluginName}>
                                          {plugin.manifest.name}
                                          {plugin.source === "bundled" && (
                                            <CheckCircleIcon
                                              size={14}
                                              strokeWidth={2.5}
                                              aria-hidden="true"
                                            />
                                          )}
                                          {isEssentialPlugin(plugin) && (
                                            <SparklesIcon
                                              size={14}
                                              aria-hidden={false}
                                              role="img"
                                              aria-label="Essential"
                                              data-essential
                                            />
                                          )}
                                        </span>
                                      }
                                      description={
                                        plugin.manifest.description ? (
                                          <span id={`plugin-description-${id}`}>
                                            {plugin.manifest.description}
                                          </span>
                                        ) : undefined
                                      }
                                    />
                                    {plugin.source === "external" && (
                                      <span id={`plugin-publisher-${id}`}>
                                        <PluginProvenance
                                          source={plugin.source}
                                          publisher={plugin.publisher}
                                          className={styles.pluginRowAuthor}
                                        />
                                      </span>
                                    )}
                                  </button>
                                  <div className={styles.pluginRowAction}>
                                    {plugin.source === "external" &&
                                      plugins.imports &&
                                      catalog && (
                                        <Button
                                          size="sm"
                                          aria-label={`Update ${plugin.manifest.name}`}
                                          data-plugin-update-id={id}
                                          disabled={busy}
                                          onClick={() =>
                                            setUpdatingPluginId(id)
                                          }
                                        >
                                          Update
                                        </Button>
                                      )}
                                    {isRequiredPlugin(plugin) ? (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled
                                      >
                                        Required
                                      </Button>
                                    ) : (
                                      <Button
                                        variant={
                                          plugin.enabled
                                            ? "subtle"
                                            : "prominent"
                                        }
                                        size="sm"
                                        aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.manifest.name}`}
                                        disabled={busy}
                                        focusableWhenDisabled
                                        onClick={() => {
                                          if (busy) return;
                                          void plugins.change(
                                            plugin.enabled
                                              ? "disable"
                                              : "enable",
                                            id,
                                          );
                                        }}
                                      >
                                        {plugin.enabled ? "Disable" : "Enable"}
                                      </Button>
                                    )}
                                  </div>
                                </article>
                                {failure && (
                                  <p
                                    role={active ? undefined : "alert"}
                                    className={`${styles.pluginRowError} error text-body-sm`}
                                  >
                                    {failure}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </SettingsGroup>
                      </section>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          </div>
          {showingDetails && selectedPlugin && (
            <PluginDetails
              key={selectedPlugin.manifest.id}
              plugin={selectedPlugin}
              failure={selectedFailure}
              busy={busy}
              plugins={plugins}
              close={detailsClose}
              onClose={closePluginDetails}
            />
          )}
        </div>
      </Panel>
    </div>
  );
}
