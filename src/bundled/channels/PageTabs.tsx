import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { RelaySession } from "../../features/relay/session";
import type {
  ConversationExtensions,
  ConversationWorkspaceProps,
  PageTabOptions,
  PageTabsProps,
  PageTabTarget,
} from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { PagesReader } from "../../features/pages/service";
import type { OpenTarget } from "../../features/navigation/targets";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { LinkThreadTabContext } from "../../features/conversation/LinkLabelContext";
import { useChannelList } from "../../features/relay/react";
import { channelIcon } from "../../features/channels/channel-icon";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { PanelDock } from "../../features/panels/PanelDock";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  DotsThreeIcon,
  SidebarRightIcon,
} from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import panelStyles from "../../features/panels/Panels.module.css";
import { useChannelLabels } from "./useChannelLabels";
import {
  entryPane,
  panelTabId,
  selectedTabId,
  tabPane,
  threadTab,
  useChannelTabState,
  type ConversationTab,
} from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";
import { ConversationTab as ConversationReader } from "./ConversationTab";
import { panelOpening } from "../../features/panels/service";
import { coveringDock, useCoveredByDock } from "./useCoveredByDock";
import { pageTabRoute } from "./page-tab-route";
import styles from "./Channels.module.css";
import { BOARD_MAIN_MIN_REM } from "./panel-split";

export type { PageTabOptions, PageTabsProps, PageTabTarget };

// The tab each page's next plain open replaces, for as long as its tabs last.
const previews = new WeakMap<RelaySession, Map<string, string>>();

/** Whether two page visits share a scope. Unscoped and Personal (null)
 * visits each match only their own kind. */
function sameScope(visit: OpenTarget, other: OpenTarget) {
  const a = visit.kind === "page" ? visit.scope : undefined;
  const b = other.kind === "page" ? other.scope : undefined;
  return a && b
    ? a.viewer === b.viewer && a.communityOrigin === b.communityOrigin
    : a === b;
}

type HostProps = {
  host: ConversationHostServices & { pages?: PagesReader | undefined };
  extensions?: ConversationExtensions | undefined;
};

export function ConversationWorkspace(
  props: ConversationWorkspaceProps & HostProps,
) {
  return (
    <PageTabs {...props} workspace={props}>
      {() => null}
    </PageTabs>
  );
}

/** A page's content as the first tab, with conversations it opens beside it. */
export function PageTabs({
  id,
  session,
  scope,
  label,
  icon,
  children,
  host,
  extensions,
  visits,
  workspace,
}: PageTabsProps &
  HostProps & {
    workspace?: ConversationWorkspaceProps;
  }) {
  const tabState = useChannelTabState(session, undefined, `page:${id}`);
  const list = useChannelList(session.channels);
  // Every joined row, as in Channels: sidebar visibility is not access.
  const { joined: channels, profiles } = useChannelLabels(
    // As in Channels, a Huddle room's tabs show the unavailable placeholder.
    list.channels.filter(
      (channel) => !channel.huddle && !channel.metadataPending,
    ),
    session.profiles,
    session.names,
  );
  const mounted = useRef(false);
  const continuing = useRef(false);
  useLayoutEffect(() => {
    mounted.current = continuing.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fallbackFocus = useRef<HTMLDivElement>(null);
  const navigator = host.navigation;
  // The page shown as this workspace mounted. When its route accepts tab
  // visits, a tab it opens, or a link opens beside it, takes a visit that
  // Back and Forward return to, as Channels' threads and details do.
  const [tabPage] = useState(() => {
    const { target } = navigator.snapshot().entry;
    if (workspace || target.kind !== "page") return;
    const route = host.pages
      ?.snapshot()
      .find(
        (item) => item.key === `${target.pluginId}/${target.pageId}`,
      )?.route;
    try {
      if (route?.version === 1 && route.validate({ tab: "conversation" }))
        return { pluginId: target.pluginId, pageId: target.pageId };
    } catch {}
  });
  const ownPage = (
    target: OpenTarget,
  ): target is Extract<OpenTarget, { kind: "page" }> =>
    !!tabPage &&
    target.kind === "page" &&
    target.pluginId === tabPage.pluginId &&
    target.pageId === tabPage.pageId;
  const tabOfVisit = (target: OpenTarget) =>
    ownPage(target) && target.route?.version === 1
      ? pageTabRoute(target.route.params)
      : undefined;
  // The page's last visit naming no tab, as with the filters it opened
  // with; a close that leaves no tab selected returns to it.
  const pageVisit = useRef<OpenTarget>(undefined);
  const pageTarget = (
    tab?: string,
    message?: string,
  ): OpenTarget | undefined => {
    const { target } = navigator.snapshot().entry;
    if (!ownPage(target)) return;
    const { route: _route, ...plain } = target;
    if (!tab) return pageVisit.current ?? plain;
    return {
      ...plain,
      route: { version: 1, params: { tab, ...(message && { message }) } },
    };
  };
  const visitedTab = () => tabOfVisit(navigator.snapshot().entry.target)?.tab;
  // The visits of closed tabs in the closing visit's own scope. Another
  // community's or viewer's visit to the same tab is its own, and stays.
  const retiring =
    (ids: readonly string[], closing: OpenTarget) => (visit: OpenTarget) =>
      ids.includes(tabOfVisit(visit)?.tab ?? "") && sameScope(visit, closing);
  // Back/Forward reopening a visit's tab takes no visit of its own, and a
  // visit this page opens has nothing to reopen.
  const restoring = useRef(false);
  const recording = useRef(false);
  // A close's return lands after its dismissal in browser history. Until
  // then the retiring visit is current; an opening waits for the return,
  // and so does retiring the visits of tabs closed meanwhile.
  const pendingReturn = useRef<{
    from: string;
    kept?: string | undefined;
    paneOpen: boolean;
    open?: { tab: string; message?: string | undefined };
    retire: readonly string[];
  }>(undefined);
  const returning = () =>
    pendingReturn.current?.from === navigator.snapshot().entry.id;
  // Record where Back returns before an opening changes the selection.
  const leaveVisit = (tab: string) => {
    if (tabPage && !restoring.current && !returning() && visitedTab() !== tab)
      tabState.leaveVisit();
  };
  const visitTab = (tab: string, message?: string) => {
    const target = pageTarget(tab, message);
    if (!target || restoring.current || visitedTab() === tab) return;
    if (returning() && pendingReturn.current) {
      pendingReturn.current.open = { tab, message };
      return;
    }
    recording.current = true;
    try {
      void navigator.open(target, { focus: "preserve", sidebar: "preserve" });
    } finally {
      recording.current = false;
    }
  };
  // Closing a tab retires its visits; the selection it leaves stays. A
  // closed selection leaves the side pane showing its first survivor.
  const dismissTabs = (ids: readonly string[]) => {
    const survivors = [
      ...tabState.tabs
        .filter((tab) => tabPane(tab) === "side")
        .map((tab) => tab.id),
      ...tabState.entries
        .filter((entry) => entryPane(tabState.mainEntries, entry) === "side")
        .map(panelTabId),
    ].filter((tab) => !ids.includes(tab));
    const kept = selectedTabId(tabState.getSelected(), survivors) || undefined;
    const fallback = pageTarget(kept);
    if (!fallback || !ids.length) return;
    const pending = pendingReturn.current;
    if (returning() && pending) {
      // A second dismissal now would move history again under the return
      // in flight. Its tabs' visits retire once that return lands, which
      // then shows the survivor this close leaves, or the waiting opening.
      const { open: waiting, ...rest } = pending;
      pendingReturn.current = {
        ...rest,
        kept,
        paneOpen: tabState.paneOpen,
        retire: [...pending.retire, ...ids],
        ...(waiting && !ids.includes(waiting.tab) && { open: waiting }),
      };
      return;
    }
    const { id, target } = navigator.snapshot().entry;
    const retires = retiring(ids, target);
    // Only retiring the current visit returns; browser history lands that
    // return a task later, so it stays pending until the entry changes.
    pendingReturn.current = retires(target)
      ? { from: id, kept, paneOpen: tabState.paneOpen, retire: [] }
      : undefined;
    navigator.dismiss(retires, fallback);
  };
  const secondary = useConversationTabs({
    state: tabState,
    relay: host.relay,
    session,
    panels: host.panels,
    current: undefined,
    scope,
    channels,
    profiles,
    extensions,
    leadingIds: [],
    continuingVisit: continuing.current,
    isLive: () => true,
    openLink(url) {
      const viewer = session.viewer;
      const target =
        viewer &&
        isBuzzLink(url) &&
        buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
      if (!target) return false;
      void host.navigation.open(target);
      return true;
    },
    fallbackFocus,
    mainPane: true,
    anyMainThread: true,
    // The page stays in view; a thread reaches the main pane only when moved.
    threadPane: "side",
    visits,
    navigation: host.navigation,
    ...(tabPage && {
      onVisitPanel(entry) {
        leaveVisit(panelTabId(entry));
        visitTab(panelTabId(entry));
      },
      onClosePanel: (entry) => dismissTabs([panelTabId(entry)]),
      onCloseThread: (tab) => dismissTabs([tab.id]),
      onCloseConversation: (tab) => dismissTabs([tab.id]),
      onCloseTabs: (tabs, entries) =>
        dismissTabs([...tabs.map((tab) => tab.id), ...entries.map(panelTabId)]),
    }),
    conversationIcon: (item) => {
      const Icon = channelIcon(item);
      return <Icon size="1rem" />;
    },
  });
  const enteredDetail = useRef<
    | {
        session: RelaySession;
        key: string;
      }
    | undefined
  >(undefined);
  const detailKey =
    workspace?.detail &&
    JSON.stringify([
      scope,
      id,
      workspace.target.channelId,
      workspace.target.threadId,
      workspace.target.messageId,
      workspace.detail.target,
      workspace.detail.rootId,
    ]);
  useLayoutEffect(() => {
    if (!workspace?.detail || !detailKey) {
      enteredDetail.current = undefined;
      return;
    }
    if (
      enteredDetail.current?.session === session &&
      enteredDetail.current.key === detailKey
    )
      return;
    const entry = panelOpening(
      host.panels,
      workspace.target.channelId,
      workspace.detail.target,
      workspace.detail.rootId,
    );
    if (!entry) return;
    enteredDetail.current = { session, key: detailKey };
    secondary.open(entry, true);
  });
  const primaryChannelId = workspace?.target.channelId;
  useLayoutEffect(() => {
    if (!primaryChannelId) return;
    return host.panels.handleOpenRequests(({ target, channelId, rootId }) => {
      const connection = host.relay.snapshot();
      if (
        !mounted.current ||
        channelId !== primaryChannelId ||
        connection.status !== "ready" ||
        connection.session !== session
      )
        return false;
      const entry = panelOpening(host.panels, channelId, target, rootId);
      if (!entry) return false;
      secondary.open(entry, true);
      return true;
    });
  }, [host.panels, host.relay, primaryChannelId, secondary.open, session]);
  // One stable opener, so a page's effects can depend on it; it reads the
  // live workspace when called.
  const opening = useRef<
    (target: PageTabTarget, options?: PageTabOptions) => boolean
  >(() => false);
  const closing = useRef<(target: PageTabTarget) => boolean>(() => false);
  // A page's own close leaves focus to the page, so the workspaces adopt the
  // selection it leaves without focusing it; an open in the same update, as
  // when Archive advances, focuses its tab as usual.
  const [closes, setCloses] = useState(0);
  const committedCloses = useRef(closes);
  useLayoutEffect(() => {
    committedCloses.current = closes;
  });
  // A thread opened at a reply keeps its tab once its root resolves.
  const tabOf = ({ channelId, threadId }: PageTabTarget) =>
    (threadId && threadTab(tabState.tabs, channelId, threadId)) ||
    tabState.tabs.find(
      (item) =>
        item.id ===
        (threadId
          ? `thread:${channelId}:${threadId}`
          : `conversation:${channelId}`),
    );
  const isOpen = (target: PageTabTarget) => !!tabOf(target);
  useLayoutEffect(() => {
    closing.current = (target) => {
      const tab = tabOf(target);
      if (!mounted.current || !tab) return false;
      tabState.setTabs((tabs) => tabs.filter((item) => item.id !== tab.id));
      setCloses(committedCloses.current + 1);
      dismissTabs([tab.id]);
      return true;
    };
    opening.current = (
      { channelId, threadId, messageId, unreadSince },
      { keep, markRead } = {},
    ) => {
      // A thread tab shows a channel the viewer can only read; a
      // conversation tab needs one they can post in.
      if (
        !mounted.current ||
        !(threadId
          ? secondary.canOpenThread(channelId)
          : secondary.canOpenConversation(channelId))
      )
        return false;
      setCloses(committedCloses.current);
      const known = new Set(tabState.tabs.map((tab) => tab.id));
      // An open thread keeps its tab in whichever pane it was moved to, and
      // under its verified root.
      const existing = threadId ? tabOf({ channelId, threadId }) : undefined;
      leaveVisit(
        existing?.id ??
          (threadId
            ? `thread:${channelId}:${threadId}`
            : `conversation:${channelId}`),
      );
      // Each open at a message asks the reader to show it again; any other
      // open focuses the composer, except a Back/Forward reopen.
      if (threadId)
        secondary.openConversationThread(
          channelId,
          messageId ?? threadId,
          (existing?.kind === "thread" && existing.rootId) || threadId,
          messageId || restoring.current ? "reveal" : "focus",
          messageId ? undefined : unreadSince,
        );
      else {
        const tab = `conversation:${channelId}`;
        tabState.setTabs((tabs) => {
          const previous = tabs.find((item) => item.id === tab);
          const prior =
            previous?.kind === "conversation" ? previous : undefined;
          const next: ConversationTab = {
            id: tab,
            kind: "conversation",
            channelId,
            ...(messageId && { messageId }),
            revealRequest: (prior?.revealRequest ?? 0) + (messageId ? 1 : 0),
            focusRequest:
              (prior?.focusRequest ?? 0) +
              (messageId || restoring.current ? 0 : 1),
            ...(markRead === false && { markRead: false }),
          };
          return previous
            ? tabs.map((item) => (item === previous ? next : item))
            : [...tabs, next];
        });
        tabState.select(tab);
      }
      // A plain open replaces the tab the last one added; a kept, moved or
      // already-open tab stays.
      const page = previews.get(session) ?? new Map<string, string>();
      previews.set(session, page);
      const opened = existing?.id || tabState.getSelected();
      const preview = page.get(id);
      if (known.has(opened)) {
        if (keep && opened === preview) page.delete(id);
      } else if (!keep) {
        if (preview && known.has(preview))
          tabState.setTabs((tabs) =>
            tabs.filter((tab) => tab.id !== preview || tabPane(tab) === "main"),
          );
        page.set(id, opened);
      }
      visitTab(opened, messageId);
      return true;
    };
  });
  // Each visit to the page restores the tabs it showed. A tab closed since
  // without being dismissed, as one a later open replaced, opens again
  // beside the others: Back and Forward never close a tab.
  const enteredVisit = useRef<string>(undefined);
  const enter = useRef(() => {});
  useLayoutEffect(() => {
    enter.current = () => {
      const { id: entry, target } = navigator.snapshot().entry;
      if (
        !mounted.current ||
        !ownPage(target) ||
        enteredVisit.current === entry
      )
        return;
      enteredVisit.current = entry;
      tabState.enterVisit(`${entry}:page`, undefined, true);
      const route = tabOfVisit(target);
      if (!route) pageVisit.current = target;
      if (recording.current) return;
      const landed = pendingReturn.current;
      if (landed && landed.from !== entry && landed.retire.length) {
        // Retire the visits of tabs closed while the return was pending. If
        // that retires where it landed, history returns again; the return
        // stays pending until then.
        const retires = retiring(landed.retire, target);
        const fallback = pageTarget(
          landed.open?.tab ?? landed.kept,
          landed.open?.message,
        );
        if (fallback) {
          const again = retires(target);
          pendingReturn.current = again
            ? { ...landed, from: entry, retire: [] }
            : undefined;
          navigator.dismiss(retires, fallback);
          if (again) return;
        }
      }
      if (landed && landed.from !== entry) {
        pendingReturn.current = undefined;
        // The close's survivor stays selected over the visit's own snapshot;
        // an opening made meanwhile takes its visit now.
        const selected = landed.open?.tab ?? landed.kept;
        if (landed.open) tabState.leaveVisit();
        if (selected) {
          tabState.select(selected);
          tabState.setPaneOpen(!!landed.open || landed.paneOpen);
        }
        if (landed.open) {
          const { tab, message } = landed.open;
          queueMicrotask(() => visitTab(tab, message));
        }
        return;
      }
      const thread = /^thread:([^:]+):([^:]+)(?::[^:]+)?$/.exec(
        route?.tab ?? "",
      );
      const conversation = /^conversation:(.+)$/.exec(route?.tab ?? "");
      const reopen: PageTabTarget | undefined =
        thread?.[1] && thread[2]
          ? { channelId: thread[1], threadId: thread[2] }
          : conversation?.[1]
            ? { channelId: conversation[1] }
            : undefined;
      if (!reopen || tabOf(reopen)) return;
      restoring.current = true;
      try {
        opening.current(
          {
            ...reopen,
            ...(route?.message && { messageId: route.message }),
          },
          { keep: true },
        );
      } finally {
        restoring.current = false;
      }
    };
  });
  useLayoutEffect(() => {
    if (!tabPage) return;
    enter.current();
    return navigator.subscribe(() => enter.current());
  }, [navigator, tabPage]);
  const open = useCallback(
    (target: PageTabTarget, options?: PageTabOptions) =>
      opening.current(target, options),
    [],
  );
  const close = useCallback(
    (target: PageTabTarget) => closing.current(target),
    [],
  );
  const focusPage = useRef(false);
  const closeAll = () => {
    if (!secondary.closeAllTabs()) return false;
    focusPage.current = true;
    return true;
  };
  // The page owns the close-all command while its workspace is shown, even
  // while a floating pane covers the page.
  useLayoutEffect(() => {
    const close = (event: Event) => {
      const workspace = split.ref.current;
      if (
        event.defaultPrevented ||
        !workspace?.isConnected ||
        workspace.closest('[hidden], [inert], [aria-hidden="true"]') ||
        !workspace.getClientRects().length ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;
      flushSync(() => {
        if (closeAll()) event.preventDefault();
      });
    };
    window.addEventListener("buzz:close-all-tabs", close);
    return () => window.removeEventListener("buzz:close-all-tabs", close);
  });
  // Surviving content keeps focus; a removed tab or closing menu returns it
  // to the page's own tab.
  useLayoutEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.isConnected &&
      !focused.closest('[inert], [hidden], [aria-hidden="true"], [role="menu"]')
    )
      return;
    (
      fallbackFocus.current?.querySelector<HTMLElement>(
        '[role="tab"][data-tab-value="conversation"]',
      ) ?? fallbackFocus.current
    )?.focus({ preventScroll: true });
  });
  // An update that removes the control in use, such as a reader whose room
  // became a Huddle, returns focus to the tab that showed it.
  const focused = useRef<{ node: Element; tab: string | null | undefined }>(
    undefined,
  );
  useLayoutEffect(() => {
    const last = focused.current;
    if (
      !last ||
      last.node.isConnected ||
      document.activeElement !== document.body
    )
      return;
    focused.current = undefined;
    (
      (last.tab && document.getElementById(last.tab)) ||
      fallbackFocus.current
    )?.focus({ preventScroll: true });
  });
  const split = usePanelSplit(
    scope,
    `page:${id}`,
    undefined,
    undefined,
    undefined,
    BOARD_MAIN_MIN_REM,
  );
  const hasTabs = secondary.items.length > 0;
  const showingPanel = tabState.paneOpen && hasTabs;
  const covered = useCoveredByDock(split.ref, fallbackFocus, showingPanel);
  const [primaryFocus] = useState(() =>
    document.activeElement?.closest('input, textarea, [contenteditable="true"]')
      ? undefined
      : 1,
  );
  const primaryTarget = workspace?.target;
  const latestRequest = primaryTarget?.messageId
    ? undefined
    : workspace?.latestRequest;
  const revealLatest = useEffectEvent(() => {
    tabState.selectMain(undefined);
    // The coverage observer may still be measuring a newly mounted workspace.
    const dock = showingPanel ? coveringDock(split.ref.current) : undefined;
    if (!dock) return;
    if (dock.contains(document.activeElement)) secondary.closePane();
    else tabState.setPaneOpen(false);
  });
  useLayoutEffect(() => {
    if (latestRequest && !latestRequest.aborted) revealLatest();
  }, [latestRequest]);
  const primaryChannel =
    primaryTarget &&
    channels.find((channel) => channel.id === primaryTarget.channelId);
  const primaryTab: ConversationTab | undefined = primaryTarget && {
    id: "conversation",
    channelId: primaryTarget.channelId,
    ...(primaryTarget.threadId
      ? {
          kind: "thread" as const,
          messageId:
            primaryTarget.messageId ??
            primaryTarget.subthreadId ??
            primaryTarget.threadId,
          rootId: primaryTarget.threadId,
        }
      : {
          kind: "conversation" as const,
          ...(primaryTarget.messageId && {
            messageId: primaryTarget.messageId,
          }),
        }),
    // A delayed workspace mount must not take focus from a sidebar name edit.
    ...(primaryTarget.messageId
      ? { revealRequest: 1 }
      : { focusRequest: primaryFocus }),
  };
  // As in a plain channel visit, the page reads its visible selected side tab
  // while focus stays anywhere on the page, such as the row that opened it.
  // A conversation moved to the main pane still reads only by its own focus.
  const readingTab =
    showingPanel &&
    secondary.selectedMain === "conversation" &&
    !!secondary.selectedTab;
  const tabMenu = {
    key: JSON.stringify([scope, id]),
    closeAll,
  };
  const paneToggle = (
    onClick: () => void,
    ref?: typeof secondary.splitTrigger,
  ) => (
    <IconButton
      hint="familiar"
      ref={ref}
      data-tab-pane-toggle=""
      size="toolbar"
      aria-label="Toggle tab pane"
      title={showingPanel ? "Close tab pane" : "Open tab pane"}
      aria-expanded={showingPanel}
      onClick={onClick}
      icon={<SidebarRightIcon size="1rem" aria-hidden="true" />}
    />
  );
  return (
    <LinkThreadTabContext value={secondary.openLinkedThread}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Focus within records the control in use, restored if an update removes it. */}
      <div
        className={styles.root}
        onFocus={({ target }) => {
          const panel = target.closest('[role="tabpanel"]');
          focused.current = {
            node: target,
            // A portalled dialog sits outside its tab's panel; it belongs to
            // the tab focus came from.
            tab: panel
              ? panel.getAttribute("aria-labelledby")
              : focused.current?.tab,
          };
        }}
      >
        <div
          ref={split.ref}
          style={split.style}
          data-reading-thread={readingTab ? "" : undefined}
          className={`${styles.board} ${panelStyles.splitMotion}`}
        >
          <div
            ref={fallbackFocus}
            tabIndex={-1}
            className={styles.conversation}
            inert={covered}
            aria-hidden={covered || undefined}
          >
            <PanelWorkspace
              main
              tabMenu={tabMenu}
              drag={secondary.drag.main}
              label={`${label} tabs`}
              focusOnMount={false}
              adoptSelection={closes}
              value={secondary.selectedMain}
              select={(tab) =>
                tabState.selectMain(tab === "conversation" ? undefined : tab)
              }
              actions={
                hasTabs &&
                !showingPanel && (
                  <span className={panelStyles.paneToggle}>
                    {paneToggle(
                      () => tabState.setPaneOpen(true),
                      secondary.splitTrigger,
                    )}
                  </span>
                )
              }
              items={[
                {
                  id: "conversation",
                  label,
                  icon,
                  toolbar: (workspace?.headerActions ||
                    !!workspace?.actions?.length) && (
                    <>
                      {workspace?.headerActions}
                      {!!workspace?.actions?.length && (
                        <MenuRoot>
                          <MenuTrigger
                            render={
                              <IconButton
                                hint="familiar"
                                size="sm"
                                aria-label="Conversation actions"
                                title="Conversation actions"
                                icon={
                                  <DotsThreeIcon
                                    size="1rem"
                                    aria-hidden="true"
                                  />
                                }
                              />
                            }
                          />
                          <MenuPopup align="end">
                            {workspace.actions.map((action) => (
                              <MenuItem
                                key={action.label}
                                onClick={() => action.run()}
                              >
                                {action.label}
                              </MenuItem>
                            ))}
                          </MenuPopup>
                        </MenuRoot>
                      )}
                    </>
                  ),
                  actions: workspace?.actions,
                  content: workspace ? (
                    <div className={styles.conversation}>
                      <div className={styles.workspaceReader}>
                        {primaryTab &&
                        primaryChannel &&
                        secondary.canOpenConversation(primaryChannel.id) ? (
                          <ConversationReader
                            key={JSON.stringify(primaryTarget)}
                            tab={primaryTab}
                            intro={workspace.intro}
                            subthreadId={primaryTarget?.subthreadId}
                            latestRequest={latestRequest}
                            active={
                              secondary.selectedMain === "conversation" &&
                              !covered
                            }
                            channel={primaryChannel}
                            session={session}
                            scope={scope}
                            extensions={extensions}
                            openLink={(url, origin) =>
                              secondary.openConversationLink(
                                primaryChannel.id,
                                url,
                                origin,
                              )
                            }
                            canOpenLink={(target) =>
                              !!host.panels.resolve(target)
                            }
                            openThread={(messageId, rootId, intent) =>
                              secondary.openConversationThread(
                                primaryChannel.id,
                                messageId,
                                rootId,
                                intent,
                              )
                            }
                            close={() => {}}
                          />
                        ) : (
                          <p role="status" className={styles.empty}>
                            This conversation is no longer available.
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    children(open, close, isOpen)
                  ),
                },
                ...secondary.mainItems,
              ]}
            />
          </div>
          {secondary.drag.feedback}
          {secondary.hosts}
          <p role="status" className="sr-only">
            {secondary.announcement}
          </p>
          <PanelDock
            open={showingPanel}
            keepMounted={
              tabState.entries.length > 0 || (hasTabs && !tabState.paneOpen)
            }
            className={styles.panelStack}
            resizeHandle={split.handle}
          >
            {hasTabs && (
              <div className={styles.retainedPanel}>
                <PanelWorkspace
                  drag={secondary.drag.side}
                  actions={paneToggle(secondary.closePane)}
                  tabMenu={tabMenu}
                  value={secondary.selectedTab}
                  select={secondary.selectPanelTab}
                  items={secondary.items}
                  focusOnMount={continuing.current}
                  adoptSelection={closes}
                />
              </div>
            )}
          </PanelDock>
        </div>
      </div>
    </LinkThreadTabContext>
  );
}
