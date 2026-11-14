import { ActivityNavigationProvider } from "./ActivityNavigation";
import { PageNavigation } from "./PageNavigation";
import { AppDock } from "./AppDock";
import styles from "./AppShell.module.css";
import { ResizeHandle } from "../../features/panels/ResizeHandle";
import { RailNavigation } from "./RailNavigation";
import { RailDrag } from "./RailArrangement";
import { ListColumn } from "./ListColumn";
import { SidePanelPresence } from "../../features/panels/side-panel-presence";
import { useListSection } from "./list-section";
import { routedSection, useListColumn } from "./list-column";
import { navigationOwner, orderPages, pagePlacement } from "./presentation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { isApplePlatform } from "../../features/shortcuts/format";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  SidebarIcon,
  MagnifyingGlassIcon,
} from "../../shared/design-system/icons";
import { createPortal } from "react-dom";
import { Panel } from "../../shared/design-system/ui/Panel";
import { isTauri } from "@tauri-apps/api/core";
import type { SettingsCards } from "../../features/settings/service";
import type { RegisteredPage } from "../../features/pages/service";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import type { JoinRequest } from "../../features/communities/invite-intent";
import type { OpenTarget } from "../../features/navigation/targets";
import {
  CommunityPicker,
  OpenCommunitySwitcher,
} from "../../features/communities/CommunityPicker";
import { ProfileButton } from "./ProfileButton";
import { CommunityShortcuts } from "./CommunityShortcuts";
import { MarkAllReadShortcut } from "./MarkAllReadShortcut";
import type { Appearance } from "../../shared/theme/service";
import { PageSearch, type SearchServices } from "./PageSearch";
import { FindInPage } from "./FindInPage";
import { BestieNavigationProvider } from "./BestieNavigation";
import type {
  Navigation as AppNavigation,
  NavigationOpenOptions,
} from "../../features/navigation/controller";
import {
  ConversationDetailPane,
  useConversationDetailPane,
} from "../../features/conversation/ConversationDetailPane";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { useRelayConnection } from "../../features/relay/react";
import { macTitleBarDragHandlers } from "./title-bar";
import { hasIntegratedWindowControls, WindowControls } from "./WindowControls";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
const titleBarDragProps = macDesktop ? macTitleBarDragHandlers : {};

export function AppShell(props: ComponentProps<typeof AppShellContent>) {
  return (
    <BestieNavigationProvider
      pages={props.pages}
      relay={props.communities.relay}
    >
      <ActivityNavigationProvider
        pages={props.pages}
        relay={props.communities.relay}
      >
        <AppShellContent {...props} />
      </ActivityNavigationProvider>
    </BestieNavigationProvider>
  );
}

function AppShellContent({
  pages,
  selected,
  navigationAttempt,
  onSelect,
  tone,
  workspace,
  workspaceRef,
  sidebar,
  communities,
  invite,
  onInviteClose,
  settingsCards,
  federatedIdentity,
  accountActions,
  appearance,
  pluginRecommendations = 0,
  searchServices,
  navigationControls,
  onCommunitySelect,
  onOpenTarget,
  launchers,
  backdrop,
  companion,
  creationAction,
  creationInSidebar = true,
  children,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  navigationAttempt: string;
  onSelect: (
    key: string,
    options?: Pick<NavigationOpenOptions, "focus"> & { section?: string },
  ) => void;
  tone: string;
  workspace?: boolean;
  /** Centered modal frame below window chrome. */
  workspaceRef?: Ref<HTMLDivElement>;
  sidebar?: (pages: ReactNode, creationAction: ReactNode) => ReactNode;
  communities: Communities;
  invite?: (JoinRequest & { requestId: number }) | undefined;
  onInviteClose?: ((requestId: number) => void) | undefined;
  settingsCards?: SettingsCards | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  accountActions: AccountActionsService;
  appearance: Appearance;
  /** Managed plugin recommendations awaiting review, pointed out beside Plugins. */
  pluginRecommendations?: number;
  searchServices?: SearchServices;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  /** Community menu destinations, opened through the host's navigation. */
  onOpenTarget?: (target: OpenTarget) => void;
  launchers?: ReactNode;
  /** Plugin-painted layers behind the shell; absent by default. */
  backdrop?: ReactNode;
  companion?: ReactNode;
  creationAction?: (
    open: boolean,
    onOpenChange: (open: boolean) => void,
    triggerContainer: HTMLElement | null,
    menuTriggerContainer: HTMLElement | null,
    /** Opens what was created the way the sidebar does: without the list. */
    navigator: AppNavigation | undefined,
  ) => ReactNode;
  creationInSidebar?: boolean;
  children: ReactNode;
}) {
  const detailPane = useConversationDetailPane();
  const fillsWorkspace = workspace || selected === "settings";
  const [creationContainer, setCreationContainer] =
    useState<HTMLDivElement | null>(null);
  const [creationOpen, setCreationOpen] = useState(false);
  const [creationMenuContainer, setCreationMenuContainer] =
    useState<HTMLDivElement | null>(null);
  const [searchContainer, setSearchContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openSwitcher = useCallback(() => {
    setSidebarOpen(true);
    setNavigationOpen(true);
    setSwitcherOpen(true);
  }, []);
  const connection = useRelayConnection(communities.relay);
  const sidebarScope = connection.scope ?? "disconnected";
  const owner = navigationOwner(pages, selected);
  const hasNavigation = pages.some(
    (page) => page.key === selected && !!page.sidebar,
  );
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 650px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 650px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const collapsibleSidebar =
    selected === "settings" ||
    pages.some(
      (page) => page.key === selected && (page.primary || !!page.sidebar),
    );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const listColumn = useListColumn(searchServices?.navigation);
  const askList = listColumn.ask;
  const listSection = useListSection(
    connection.session,
    connection.viewer ? connection.scope : undefined,
    searchServices?.navigation,
    searchServices?.sidebarSections,
    listColumn.list,
  );
  // Open side panels report themselves; the layout does not search for them.
  const [sidePanels, setSidePanels] = useState(0);
  const sidePanelPresence = useMemo(
    () => ({
      opened() {
        setSidePanels((count) => count + 1);
        return () => setSidePanels((count) => count - 1);
      },
    }),
    [],
  );
  const hostNavigation = searchServices?.navigation;
  // The sidebar opens destinations directly; only a section address lists.
  const railNavigator = useMemo(
    () =>
      hostNavigation && {
        ...hostNavigation,
        open: ((target, options) => {
          if (!routedSection(target)) askList("close");
          return hostNavigation.open(target, options);
        }) as typeof hostNavigation.open,
      },
    [hostNavigation, askList],
  );
  // A section opened on one of its conversations lists that section.
  const openInSection = useCallback(
    (section: string, target: OpenTarget) => {
      askList({ section });
      void hostNavigation?.open(target);
    },
    [hostNavigation, askList],
  );
  // Opens from the list keep it showing.
  const listNavigator = useMemo(
    () =>
      hostNavigation && {
        ...hostNavigation,
        open: ((target, options) => {
          askList("keep");
          return hostNavigation.open(target, options);
        }) as typeof hostNavigation.open,
      },
    [hostNavigation, askList],
  );
  const shellScope = useMemo(
    () =>
      connection.viewer && connection.scope
        ? {
            viewer: connection.viewer,
            communityOrigin: connection.scope.slice(
              0,
              -(connection.viewer.length + 1),
            ),
          }
        : undefined,
    [connection.viewer, connection.scope],
  );
  const [railWidth, setRailWidth] = useState(304);
  const railWorkspace = useRef<HTMLDivElement>(null);
  const resizeRail = (width: number) => {
    setRailWidth(Math.min(440, Math.max(240, width)));
  };
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const visibleSidebar =
    hasNavigation && (narrow ? navigationOpen : sidebarOpen);
  const visibleRail = narrow ? navigationOpen : sidebarOpen;
  const compactRail = !narrow && !sidebarOpen;
  const creationInNavigation = !!creationAction && creationInSidebar;
  useEffect(
    () =>
      searchServices?.shortcuts.registerHost({
        id: "new",
        title: "Open New menu",
        binding: { key: "n", mod: true },
        order: 75,
        allowInEditable: true,
        when: () =>
          !!creationAction &&
          !!creationContainer?.querySelector("button:not(:disabled)") &&
          (isApplePlatform(navigator.platform) ||
            !document.activeElement?.closest(".xterm")),
        run: () => {
          setSidebarOpen(true);
          setNavigationOpen(true);
          setCreationOpen(true);
        },
      }),
    [searchServices, creationAction, creationContainer],
  );
  const toggleLabel = narrow
    ? navigationOpen
      ? "Hide navigation"
      : "Show navigation"
    : `${sidebarOpen ? "Hide" : "Show"} sidebar`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a navigation attempt closes the drawer.
  useEffect(() => {
    if (navigationOpen && navigationToggle.current?.getClientRects().length) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    setNavigationOpen(false);
  }, [navigationAttempt]);
  // Toggling the sidebar changes only this shell's own state. Keep the
  // navigation element stable across those renders so React skips the whole
  // sidebar subtree instead of re-rendering every row on each click.
  const navigation = useMemo(() => {
    const selectedPageHasSidebar = pages.some(
      (page) => page.key === selected && !!page.sidebar,
    );
    // Sidebars retain their documented app-link and creation slots.
    const content = sidebar
      ? sidebar(
          <nav aria-label="Pages" className="shell-pages">
            <PageNavigation
              pages={orderPages(
                pages.filter((page) => pagePlacement(page) === "sidebar"),
              )}
              selected={selected}
              onSelect={onSelect}
              previews
            />
          </nav>,
          null,
        )
      : null;
    return selectedPageHasSidebar ? (
      <ResizableSidebar scope={sidebarScope} className="shell-sidebar">
        {content}
      </ResizableSidebar>
    ) : (
      content
    );
  }, [pages, selected, sidebar, sidebarScope, onSelect]);
  const dockPages = useMemo(
    () =>
      orderPages(
        pages.filter((page) => page.primary && page.key === "buzz.inbox/inbox"),
        "dock",
      ),
    [pages],
  );
  const activityPage = selected === "buzz.inbox/inbox";
  const search = (
    <PageSearch
      pages={pages}
      onSelect={onSelect}
      services={searchServices}
      presentation="bar"
    >
      {(open) =>
        searchContainer &&
        createPortal(
          <IconButton
            aria-label="Search"
            title="Search"
            icon={<MagnifyingGlassIcon size={16} />}
            onClick={(event) => {
              event.currentTarget.focus();
              open();
            }}
          />,
          searchContainer,
        )
      }
    </PageSearch>
  );
  const railCommunity = (
    <CommunityPicker
      communities={communities}
      invite={invite}
      onInviteClose={onInviteClose}
      settingsCards={settingsCards}
      federatedIdentity={federatedIdentity}
      onSelect={onCommunitySelect}
      onOpenTarget={onOpenTarget}
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      side="bottom"
    />
  );
  const railActions = (
    <>
      {railCommunity}
      <ProfileButton
        communities={communities}
        accountActions={accountActions}
        settingsSelected={selected === "settings"}
        appearance={appearance}
        pluginRecommendations={pluginRecommendations}
        onSettings={(section) =>
          onSelect("settings", section ? { section } : undefined)
        }
        side="bottom"
      />
      <div ref={setSearchContainer} />
      {creationAction && <div ref={setCreationMenuContainer} />}
    </>
  );
  const dock = (
    <AppDock
      showPrimaryNavigation={
        !(connection.viewer && connection.scope && searchServices?.navigation)
      }
      search={null}
      open={visibleRail || compactRail}
      compact={compactRail}
      onDismiss={() => {
        if (narrow) setNavigationOpen(false);
        else setSidebarOpen(false);
        navigationToggle.current?.focus();
      }}
      pages={dockPages}
      selected={owner}
      currentPage={selected}
      onSelect={onSelect}
      previews
      community={null}
      profile={null}
      settings={null}
      header={railActions}
    >
      {shellScope && searchServices && railNavigator ? (
        <RailNavigation
          key={connection.scope}
          compact={compactRail}
          session={connection.session}
          scope={shellScope}
          sidebarSections={searchServices.sidebarSections}
          navigator={railNavigator}
          listNavigator={listNavigator ?? searchServices.navigation}
          openInSection={openInSection}
          pages={pages}
          selected={selected}
          onSelect={onSelect}
          creationAction={
            creationInNavigation ? <div ref={setCreationContainer} /> : null
          }
        />
      ) : (
        <PageNavigation
          placement={compactRail ? "dock" : "sidebar"}
          pages={pages.filter(
            (page) => page.primary && page.key !== "buzz.inbox/inbox",
          )}
          selected={selected}
          onSelect={onSelect}
        />
      )}
    </AppDock>
  );
  return (
    <div
      data-shell-tone={tone}
      className="shell-background flex h-dvh min-h-0 flex-col overflow-hidden text-ink"
    >
      {backdrop}
      {/* biome-ignore lint/a11y/useValidAnchor: A skip link navigates to a real fragment; enhance focus without replacing the app route hash. */}
      <a
        href="#main-content"
        onClick={(event) => {
          // Focus intent is not a navigation visit and must not replace the route hash.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header
        data-buzz-window-drag={
          macDesktop || hasIntegratedWindowControls() || undefined
        }
        data-tauri-drag-region={macDesktop ? undefined : true}
        {...titleBarDragProps}
        className={`shell-header ${macDesktop ? "shell-header-mac" : ""}`}
      >
        <div
          className="shell-history"
          data-buzz-window-drag={
            macDesktop || hasIntegratedWindowControls() || undefined
          }
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {
            <IconButton
              hint="familiar"
              ref={navigationToggle}
              data-shell-sidebar-toggle=""
              data-highlight-expanded="false"
              type="button"
              variant="ghost"
              aria-label={toggleLabel}
              aria-expanded={visibleRail}
              aria-controls="shell-rail"
              title={toggleLabel}
              onClick={() => {
                if (narrow) setNavigationOpen((open) => !open);
                else setSidebarOpen((open) => !open);
              }}
              icon={<SidebarIcon aria-hidden="true" size={16} />}
            />
          }
          {navigationControls}
        </div>
        <div className="shell-search">
          {search}
          <FindInPage shortcuts={searchServices?.shortcuts} />
        </div>
        <div
          className="shell-actions"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          <div className="shell-actions-fixed">
            {launchers}

            <WindowControls />
          </div>
        </div>
      </header>

      <div
        ref={railWorkspace}
        className="shell-workspace"
        style={
          {
            "--shell-rail-width": compactRail
              ? "calc(var(--size-control-lg) + 2 * var(--space-1))"
              : `${railWidth}px`,
          } as CSSProperties
        }
        data-detail-container=""
        data-feed-layout={activityPage || undefined}
        data-full-width-workspace={
          !!listSection ||
          activityPage ||
          selected === "buzz.drafts-and-sent/drafts-sent" ||
          undefined
        }
        data-rail-open={visibleRail || undefined}
        data-rail-compact={compactRail || undefined}
        data-side-panel={sidePanels > 0 || undefined}
        data-list-column={
          listSection ? (listColumn.list.open ? "open" : "closed") : undefined
        }
      >
        <RailDrag>
          {dock}
          {!narrow && !compactRail && (
            <ResizeHandle
              label="Resize app sidebar"
              width={railWidth}
              min={240}
              max={440}
              target={railWorkspace}
              property="--shell-rail-width"
              className={styles.railResize}
              setWidth={resizeRail}
              reset={() => {
                setRailWidth(304);
                setSidebarOpen(true);
              }}
            />
          )}
          <div
            ref={workspaceRef}
            className="shell-dialog-frame"
            data-shell-dialog-frame=""
          />
          <div
            className={`shell-body ${selected === "settings" ? "shell-body-settings" : ""}`}
          >
            <div className="relative flex min-h-0 min-w-0 flex-1">
              <Panel as="div" joined flat>
                <div className="shell-content">
                  <div
                    id="shell-navigation"
                    hidden={!hasNavigation}
                    className="shell-navigation"
                    data-sidebar-collapsible={
                      (collapsibleSidebar && !narrow) || undefined
                    }
                    data-sidebar-open={visibleSidebar || undefined}
                    aria-hidden={
                      (collapsibleSidebar || narrow) && !visibleSidebar
                    }
                    inert={(collapsibleSidebar || narrow) && !visibleSidebar}
                    data-expanded={navigationOpen}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Escape" &&
                        !event.shiftKey &&
                        navigationOpen &&
                        !event.defaultPrevented &&
                        event.target instanceof Node &&
                        event.currentTarget.contains(event.target)
                      ) {
                        // Closing the drawer consumes Escape, so it marks nothing read.
                        event.preventDefault();
                        setNavigationOpen(false);
                        navigationToggle.current?.focus();
                      }
                    }}
                  >
                    <div className="shell-navigation-content">
                      {hasNavigation ? navigation : null}
                    </div>
                  </div>
                  <main
                    id="main-content"
                    tabIndex={-1}
                    className="min-h-0 min-w-0 flex-1"
                  >
                    <SidePanelPresence value={sidePanelPresence}>
                      <Panel as="div" joined>
                        <ConversationDetailPane value={detailPane.value}>
                          <PanelFrame
                            scope={connection.scope}
                            companion={detailPane.companion ?? companion}
                          >
                            <div
                              id={`shell-page-${owner}`}
                              className={
                                fillsWorkspace
                                  ? "buzz-tabs-panel h-full min-h-0"
                                  : "buzz-tabs-panel h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
                              }
                            >
                              <div
                                className={
                                  fillsWorkspace
                                    ? "h-full min-h-0"
                                    : "mx-auto w-full max-w-4xl"
                                }
                              >
                                <OpenCommunitySwitcher value={openSwitcher}>
                                  <ListColumn
                                    scope={connection.scope ?? "disconnected"}
                                    list={listSection && listColumn.list}
                                    setOpen={listColumn.setOpen}
                                    title={listSection?.title ?? ""}
                                    label={listSection?.label}
                                    fill={!!listSection?.fill}
                                    content={
                                      listSection &&
                                      shellScope &&
                                      searchServices &&
                                      listNavigator && (
                                        <RailNavigation
                                          key={connection.scope}
                                          section={listSection.section}
                                          session={connection.session}
                                          scope={shellScope}
                                          sidebarSections={
                                            searchServices.sidebarSections
                                          }
                                          navigator={listNavigator}
                                          listNavigator={listNavigator}
                                          openInSection={openInSection}
                                          pages={pages}
                                          selected={selected}
                                          onSelect={onSelect}
                                        />
                                      )
                                    }
                                  >
                                    {children}
                                  </ListColumn>
                                </OpenCommunitySwitcher>
                              </div>
                            </div>
                          </PanelFrame>
                        </ConversationDetailPane>
                      </Panel>
                    </SidePanelPresence>
                  </main>
                </div>
              </Panel>
            </div>
          </div>
        </RailDrag>
      </div>
      {creationAction?.(
        creationOpen,
        setCreationOpen,
        creationContainer,
        creationMenuContainer,
        railNavigator,
      )}
      {searchServices && (
        <>
          <MarkAllReadShortcut
            communities={communities}
            shortcuts={searchServices.shortcuts}
          />
          <CommunityShortcuts
            communities={communities}
            shortcuts={searchServices.shortcuts}
            onSelect={onCommunitySelect}
          />
        </>
      )}
    </div>
  );
}
