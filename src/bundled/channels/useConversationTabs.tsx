import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  panelOpening,
  type PanelOpening,
  type Panels,
} from "../../features/panels/service";
import { useTabDrag } from "../../features/panels/useTabDrag";
import { PanelCard } from "../../features/panels/PanelCard";
import type { MessageLinkOrigin } from "../../features/messages/MessageRow";
import {
  BrowserIcon,
  MessageReplyIcon,
  InfoIcon,
} from "../../shared/design-system/icons";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { useIdentityNames } from "../../features/identity-names/react";
import { dmLabel } from "../../features/conversation/dm-label";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import { ConversationTab } from "./ConversationTab";
import { TabSlot, useTabNodes } from "./TabHosts";
import { createPortal, flushSync } from "react-dom";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelPanels } from "./useChannelPanels";
import { focusDock } from "./useCoveredByDock";
import {
  panelContentTarget,
  profileContentPanel,
  panelTabId,
  rootOfTab,
  selectedTabId,
  type ConversationTab as Tab,
  type useChannelTabState,
} from "./useChannelTabState";
import styles from "./Channels.module.css";
import tabStyles from "./ChannelTabs.module.css";

/** The content-tab families whose visits follow explicit dismissal. */
export const historyPanel = (entry: PanelOpening) =>
  !entry.channelContext &&
  (entry.panel.addressable === true ||
    profileContentPanel(entry) ||
    entry.panel.key === "buzz.github/object");

/** Shared secondary workspace. Pages retain their main reader and route semantics. */
export function useConversationTabs({
  state: tabState,
  relay,
  session: queries,
  panels,
  current,
  scope,
  channels,
  profiles,
  conversationIcon,
  extensions,
  leadingIds,
  continuingVisit,
  navigationSignal,
  isLive,
  openLink,
  fallbackFocus,
  eligible,
  threadId,
  onOpenDrawer,
  openMembers,
  withholdThreads = false,
  visits = true,
  navigation,
  routed,
  onCloseThread,
  onRetryNavigation,
  conversationToolbar,
  onVisitPanel,
  onClosePanel,
  onCloseTabs,
}: {
  state: ReturnType<typeof useChannelTabState>;
  relay: RelayData;
  session: RelaySession;
  panels: Panels;
  current: ChannelSummary | undefined;
  scope: string;
  channels: readonly ChannelSummary[];
  /** The channels' labelled participants, for DM captions. */
  profiles: ReadonlyMap<string, Profile>;
  conversationIcon(channel: ChannelSummary): ReactNode;
  /** Header actions for a conversation tab, owned by the page; `open` shows
   * the conversation in its channel. */
  conversationToolbar?:
    | ((channel: ChannelSummary, open?: () => void) => ReactNode)
    | undefined;
  extensions?: ConversationExtensions | undefined;
  leadingIds: string[];
  continuingVisit: boolean;
  navigationSignal?: AbortSignal | undefined;
  isLive(): boolean;
  openLink(url: string): boolean;
  fallbackFocus?: RefObject<HTMLElement | null>;
  eligible?(entry: PanelOpening): boolean;
  threadId?: string | undefined;
  onOpenDrawer?(): void;
  openMembers?(): void;
  /** A page withholds thread content while something covers it; it mounts
   * afresh after. */
  withholdThreads?: boolean | undefined;
  /** Showing a tab visits its conversation; a page may only reveal it. */
  visits?: boolean | undefined;
  /** Opens another conversation's tab where it lives, from the tab's menu. */
  navigation?: Pick<Navigation, "open"> | undefined;
  /** The route's thread request, handed only to the tab that matches it. */
  routed?:
    | { channelId: string; messageId: string; navigation: PageNavigation }
    | undefined;
  onCloseThread?(
    tab: Extract<Tab, { kind: "thread" }>,
    active: boolean,
    last: boolean,
  ): void;
  onRetryNavigation?(): void;
  onVisitPanel?(entry: PanelOpening): void;
  onClosePanel?(entry: PanelOpening, remaining: PanelOpening[]): void;
  /** One history transaction after the batch's local selection is committed. */
  onCloseTabs?(
    tabs: readonly Tab[],
    entries: readonly PanelOpening[],
    keep?: string,
  ): void;
}) {
  const currentId = current?.id;
  const viewer = queries.viewer;
  const { entries, setEntries } = tabState;
  const panelHistory = useRef({ onVisitPanel, onClosePanel });
  panelHistory.current = { onVisitPanel, onClosePanel };
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  // Rows read this while rendering; it changes only with the available panels.
  // biome-ignore lint/correctness/useExhaustiveDependencies: panels.resolve reads the availability `available` subscribes to.
  const canOpenLink = useCallback(
    (target: string) => !!panels.resolve(target),
    [panels, available],
  );
  const splitTrigger = useRef<HTMLButtonElement>(null);
  const focusSplit = useRef(false);
  // An opener under a floating pane is inert until the close commits, so its
  // target resolves then. A pane that still covers it keeps focus instead.
  const focusUncovered =
    useRef<() => HTMLElement | null | undefined>(undefined);
  // The opening control remounts in the main header when the pane closes,
  // under a dock that stays open, such as the companion.
  useLayoutEffect(() => {
    const resolve = focusUncovered.current;
    focusUncovered.current = undefined;
    const uncovered = resolve?.();
    if (resolve && !uncovered?.isConnected) focusSplit.current = true;
    const target = focusSplit.current
      ? (splitTrigger.current ?? fallbackFocus?.current)
      : uncovered;
    focusSplit.current = false;
    const cover = target?.closest("[inert]");
    if (cover) focusDock(cover.parentElement);
    else target?.focus({ preventScroll: true });
  });
  const panelTrigger = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const visit = useMemo(() => ({ queries, currentId }), [queries, currentId]);
  const liveVisit = useRef(visit);
  useLayoutEffect(() => {
    mounted.current = true;
    liveVisit.current = visit;
    return () => {
      mounted.current = false;
    };
  }, [visit]);
  // Editing local tabs remains available while the retained Messages session reconnects.
  const currentVisit = () => mounted.current && liveVisit.current === visit;
  const active = () => {
    const connection = relay.snapshot();
    return (
      currentVisit() &&
      isLive() &&
      connection.status === "ready" &&
      connection.session === queries
    );
  };
  type Opening = PanelOpening;
  const opened = entries.find(
    (entry) => panelTabId(entry) === tabState.selected,
  );
  const entryList = useRef<Opening[]>(entries);
  const opening = useRef<Opening | undefined>(opened);
  const renderedChannel = useRef({ currentId, queries });
  if (
    renderedChannel.current.currentId !== currentId ||
    renderedChannel.current.queries !== queries
  ) {
    renderedChannel.current = { currentId, queries };
    entryList.current = entries;
    opening.current = opened;
  }
  const selectOpening = useCallback(
    (next: Opening | undefined) => {
      opening.current = next;
      tabState.select(next ? panelTabId(next) : "thread");
    },
    [tabState.select],
  );
  const open = useCallback(
    (next: Opening | undefined, append = false) => {
      const found = next
        ? entryList.current.find(
            (entry) =>
              entry.panel === next.panel && entry.target === next.target,
          )
        : undefined;
      // A tab retained for its channel stays retained when a link reopens it,
      // and a channel tool that reopens a link's tab takes it over. A link
      // from another conversation selects the retained tab unchanged.
      const kept =
        next && !next.channelContext ? found?.channelContext : undefined;
      const wanted =
        next && kept
          ? found?.channelId === next.channelId
            ? { ...next, channelContext: kept }
            : found
          : next;
      const existing =
        found && (append || found.channelContext || found.panel.keepOpen)
          ? found
          : undefined;
      // A link from another conversation retargets the open tab's context.
      const retarget =
        existing &&
        wanted &&
        (existing.channelId !== wanted.channelId ||
          existing.rootId !== wanted.rootId ||
          existing.channelContext !== wanted.channelContext)
          ? wanted
          : undefined;
      const selected = retarget || existing || wanted;
      // Timeline actions replace transient details, never retained channel tools.
      const retained = append
        ? entryList.current
        : entryList.current.filter(
            (entry) =>
              entry === existing ||
              ((entry.channelContext || entry.panel.keepOpen) &&
                (!selected || panelTabId(entry) !== panelTabId(selected))),
          );
      const updated = retarget
        ? retained.map((entry) => (entry === existing ? retarget : entry))
        : selected && !existing
          ? [...retained, selected]
          : retained;
      entryList.current = updated;
      if (selected && historyPanel(selected))
        panelHistory.current.onVisitPanel?.(selected);
      setEntries(updated);
      selectOpening(selected);
    },
    [selectOpening, setEntries],
  );
  const panelTabs = entries.filter(
    (entry) =>
      available.includes(entry.panel) &&
      (!eligible || eligible(entry)) &&
      (!entry.channelContext ||
        (current &&
          !current.cached &&
          (!current.readOnly || current.viewerRole === "guest") &&
          (!current.archived ||
            entry.panel.channelMenu?.eligible(current, queries)) &&
          current.id === entry.channelId)),
  );
  const panel = opened && panelTabs.includes(opened) ? opened.panel : undefined;
  useEffect(() => {
    if (entries.length !== panelTabs.length) {
      entryList.current = panelTabs;
      setEntries(panelTabs);
    }
    if (opened && !panel) selectOpening(undefined);
  }, [entries.length, panelTabs, opened, panel, setEntries, selectOpening]);
  const panelActive = (entry: Opening) =>
    !!(
      active() &&
      opened &&
      panel &&
      opening.current === entry &&
      panels.snapshot().includes(panel)
    );
  const panelContext = (entry: Opening) => ({
    channelId: entry.channelId,
    ...(entry.rootId && { rootId: entry.rootId }),
    canOpen: (target: string) => !!panels.resolve(target),
    open: (target: string) => {
      if (!panelActive(entry)) return false;
      const next = panels.resolve(target);
      if (!next) return false;
      const existing = entryList.current.find(
        (item) => item.panel === next && item.target === target,
      );
      const replacement = existing ?? { ...entry, panel: next, target };
      if (historyPanel(replacement))
        panelHistory.current.onVisitPanel?.(replacement);
      entryList.current = entryList.current
        .map((item) => (item === entry ? replacement : item))
        .filter((item, index, all) => all.indexOf(item) === index);
      setEntries(entryList.current);
      selectOpening(replacement);
      return true;
    },
    push: (target: string) => {
      if (!panelActive(entry)) return false;
      const next = panelOpening(panels, entry.channelId, target, entry.rootId);
      if (!next) return false;
      open(next, true);
      return true;
    },
  });
  const tabId = panelTabId;
  const closeTab = (entry: Opening) => {
    if (!currentVisit() || !entryList.current.includes(entry)) return;
    const remaining = entryList.current.filter((item) => item !== entry);
    entryList.current = remaining;
    setEntries(remaining);
    afterClose(tabId(entry), panelTrigger.current);
    panelHistory.current.onClosePanel?.(entry, remaining);
  };
  const drawerContext = useMemo(
    () =>
      current &&
      !current.cached &&
      (!current.readOnly || current.viewerRole === "guest") &&
      viewer
        ? {
            scope,
            viewer,
            channelId: current.id,
            channelName: current.name,
            ...(threadId && { threadId }),
            relayUrl: scope
              .slice(0, -(viewer.length + 1))
              .replace(/^https:/, "wss:")
              .replace(/^http:/, "ws:"),
          }
        : undefined,
    [scope, viewer, current, threadId],
  );
  const rootTabIds = [
    ...leadingIds,
    ...tabState.tabs.map((tab) => tab.id),
    ...panelTabs.map(tabId),
  ];
  const selectedTab = selectedTabId(tabState.selected, rootTabIds);
  // A tab-placed channel launcher keeps one retained tab per channel.
  const channelTab = (panel: Opening["panel"], channelId: string) =>
    panelTabs.find(
      (entry) =>
        entry.panel === panel &&
        !!entry.channelContext &&
        entry.channelId === channelId,
    );
  const drawer = useChannelPanels(
    panels,
    drawerContext,
    () => {
      onOpenDrawer?.();
      tabState.setPaneOpen(true);
    },
    {
      paneOpen: tabState.paneOpen,
      pressed: (panel, context) => {
        const entry = channelTab(panel, context.channelId);
        return !!entry && tabState.paneOpen && selectedTab === tabId(entry);
      },
      toggle: (panel, context, target) => {
        if (!currentVisit()) return;
        const entry = channelTab(panel, context.channelId);
        if (entry && tabState.paneOpen && selectedTab === tabId(entry)) {
          closeTab(entry);
          return;
        }
        panelTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        tabState.setPaneOpen(true);
        const opening: Opening = {
          panel,
          channelId: context.channelId,
          target,
          channelContext: context,
        };
        // One tab per channel: a new target replaces the launcher's tab in place.
        if (entry && entry.target !== target)
          entryList.current = entryList.current
            .filter(
              (item) =>
                item === entry ||
                item.panel !== panel ||
                item.target !== target,
            )
            .map((item) => (item === entry ? opening : item));
        open(opening, true);
      },
    },
    {
      canOpen: canOpenLink,
      // Called only after render, once the link handler below exists.
      open: (target) =>
        !!drawerContext &&
        openConversationLink(drawerContext.channelId, target),
    },
    openMembers,
    {
      opening: tabState.sideDrawer,
      set: tabState.setSideDrawer,
      fallbackFocus,
    },
  );
  // The pane's page-local side panel, so a tab opened from outside the page
  // knows the pane is in use; it ends with this mount.
  const sidePanel = !!drawer.side;
  const { setSidePanel } = tabState;
  useLayoutEffect(() => {
    setSidePanel(sidePanel);
    return () => setSidePanel(false);
  }, [setSidePanel, sidePanel]);
  const selectPanelTab = (id: string, visit = true) => {
    opening.current = panelTabs.find((entry) => tabId(entry) === id);
    if (visit && opening.current && historyPanel(opening.current))
      panelHistory.current.onVisitPanel?.(opening.current);
    tabState.select(id);
  };
  const afterClose = (id: string, trigger?: HTMLElement | null) => {
    if (id !== selectedTab) return;
    const index = rootTabIds.indexOf(id);
    const remaining = rootTabIds.filter((tab) => tab !== id);
    selectPanelTab(
      remaining[Math.min(index, remaining.length - 1)] ?? "",
      false,
    );
    if (!remaining.length) {
      const resolve = () =>
        trigger?.isConnected ? trigger : fallbackFocus?.current;
      const target = resolve();
      if (target?.closest("[inert]")) focusUncovered.current = resolve;
      else if (target) target.focus({ preventScroll: true });
      else focusSplit.current = true;
    }
  };
  const closeConversationTab = (id: string) => {
    const closing = tabState.tabs.find((tab) => tab.id === id);
    const wasActive = tabState.paneOpen && selectedTab === id;
    tabState.setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    afterClose(id);
    const last = rootTabIds.length === 1;
    if (last) focusSplit.current = true;
    // Once the pane empties, the page's own focus return (to the opener) is
    // the last word; until then focus stays with the remaining tabs.
    if (closing?.kind === "thread") onCloseThread?.(closing, wasActive, last);
  };
  const [announcement, setAnnouncement] = useState("");
  // Place the tab and focus it where it landed in the same task. Reinserting
  // the tab's element blurs it, and a frame-deferred refocus would take focus
  // back from wherever the user has since moved it.
  const placeTab = (id: string, index: number) => {
    flushSync(() => tabState.moveTab(id, index));
    document
      .querySelector<HTMLElement>(
        `[role="tab"][data-tab-value="${CSS.escape(id)}"]`,
      )
      ?.focus({ preventScroll: true });
  };
  const moveBy = (tab: Tab, delta: -1 | 1) => {
    if (!currentVisit() || tab.kind !== "thread") return;
    const order = tabState.tabs;
    const position = order.indexOf(tab) + delta;
    if (position < 0 || position >= order.length) return;
    placeTab(tab.id, position);
    setAnnouncement(`Moved to position ${position + 1} of ${order.length}.`);
  };
  const drag = useTabDrag({
    visit,
    navigationSignal,
    movable: new Set(
      tabState.tabs.filter((tab) => tab.kind === "thread").map((tab) => tab.id),
    ),
    order: new Set(tabState.tabs.map((tab) => tab.id)),
    move: (id, index) => {
      if (!currentVisit()) return;
      if (tabState.tabs.findIndex((tab) => tab.id === id) === index) return;
      placeTab(id, index);
      setAnnouncement(
        `Moved to position ${index + 1} of ${tabState.tabs.length}.`,
      );
    },
  });
  const openConversationThread = (
    channelId: string,
    messageId: string,
    rootId: string,
    intent?: "reply" | "reveal" | "focus",
  ) => {
    if (!currentVisit()) return;
    tabState.openThreadTab(channelId, messageId, rootId, intent);
    if (
      opening.current &&
      panelTabId(opening.current) !== tabState.getSelected()
    )
      opening.current = undefined;
  };
  const openConversationLink = (
    channelId: string,
    url: string,
    origin?: MessageLinkOrigin,
  ) => {
    const connection = relay.snapshot();
    if (
      !active() ||
      connection.status !== "ready" ||
      connection.session !== queries
    )
      return false;
    const parsed = parseBuzzLink(url);
    if (
      parsed?.format === "legacy" &&
      !parsed.messageId &&
      queries.channels
        .list()
        .channels.some(
          (item) => item.id === parsed.channelId && item.channelType === "solo",
        )
    )
      return openLink(url);
    const next = panelOpening(panels, channelId, url, origin?.rootId);
    if (next) {
      panelTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      open(next, true);
      return true;
    }
    return openLink(url);
  };

  const nodes = useTabNodes(
    tabState.tabs.filter((tab) => tab.kind === "thread").map((tab) => tab.id),
  );
  // Threads and opted-in panels mount when shown, then stay for the visit.
  const visitTabs = useRef<{ shown: Set<string>; entered: Map<string, Tab> }>(
    undefined,
  );
  if (!continuingVisit || !visitTabs.current)
    visitTabs.current = {
      shown: new Set(),
      entered: new Map(tabState.tabs.map((tab) => [tab.id, tab])),
    };
  const visitTab = visitTabs.current;
  // A closed tab's lifetime ends; reopening it starts its requests afresh.
  const openIds = new Set([
    ...tabState.tabs.map((tab) => tab.id),
    ...panelTabs.map(tabId),
  ]);
  for (const id of visitTab.entered.keys())
    if (!openIds.has(id)) visitTab.entered.delete(id);
  for (const id of visitTab.shown)
    if (!openIds.has(id)) visitTab.shown.delete(id);
  function usableChannel(target: ChannelSummary) {
    return (
      !target.readOnly &&
      !target.archived &&
      !target.cached &&
      (target.channelType !== "solo" ||
        !!target.members?.includes(queries.viewer ?? ""))
    );
  }
  // The currently resolved channel can be a verified public/archived preview
  // absent from the joined sidebar list. Reading its thread is not write access.
  function tabChannel(tab: Pick<Tab, "kind" | "channelId">) {
    if (tab.kind === "thread" && current?.id === tab.channelId)
      return current.cached ? undefined : current;
    const target = channels.find((item) => item.id === tab.channelId);
    return target && usableChannel(target) ? target : undefined;
  }
  // Message rows are memoized: links read one stable opener that consults the
  // live workspace when chosen.
  const linkedThread = useRef<
    (channelId: string, messageId: string, rootId: string) => boolean
  >(() => false);
  useLayoutEffect(() => {
    linkedThread.current = (channelId, messageId, rootId) => {
      if (!currentVisit() || !tabChannel({ kind: "thread", channelId }))
        return false;
      tabState.openThreadTab(channelId, messageId, rootId, "reveal");
      if (
        opening.current &&
        panelTabId(opening.current) !== tabState.getSelected()
      )
        opening.current = undefined;
      return true;
    };
  });
  const openLinkedThread = useCallback(
    (channelId: string, messageId: string, rootId: string) =>
      linkedThread.current(channelId, messageId, rootId),
    [],
  );
  // Several open threads stay distinguishable by their original message.
  function threadLabel(tab: Extract<Tab, { kind: "thread" }>, name?: string) {
    if (tab.name) return tab.name;
    const rootId = rootOfTab(tab);
    const root = queries.channels
      .window(tab.channelId)
      .rows.find((row) => row.id === rootId);
    const text = root?.content
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~>#]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return text || (name ? `Thread · ${name}` : "Thread");
  }
  // The current conversation's own threads are already in its channel.
  function openInChannel(tab: Tab, target: ChannelSummary | undefined) {
    return target && navigation && viewer && tab.channelId !== currentId
      ? () =>
          void navigation.open({
            version: 1,
            kind: "conversation",
            scope: {
              viewer,
              communityOrigin: scope.slice(0, -(viewer.length + 1)),
            },
            channelId: tab.channelId,
            ...(tab.messageId && { messageId: tab.messageId }),
            // The channel shows the thread's root beside it, for its context.
            ...(tab.kind === "thread" && {
              threadRootId: rootOfTab(tab),
              context: "channel",
            }),
          })
      : undefined;
  }
  // A thread names its conversation as Inbox rows do, bounding a group DM's
  // names where its tab lists them all; the name opens it there.
  const resolveName = useIdentityNames(queries.names);
  function parentOf(tab: Tab, target: ChannelSummary) {
    const open = openInChannel(tab, target);
    return (
      open && {
        label:
          target.channelType === "dm"
            ? `DM · ${dmLabel(target.participants, profiles, resolveName, target.name)}`
            : `#${target.name}`,
        open,
      }
    );
  }
  function tabItem(tab: Tab) {
    const target = tabChannel(tab);
    const usable = !!target;
    const openChannel = openInChannel(tab, target);
    return {
      id: tab.id,
      composer: true,
      ...(tab.kind === "conversation" &&
        target && {
          identity: (
            <ChannelMembersButton
              session={queries}
              channelId={target.id}
              conversationName={target.name}
              canOpenLink={canOpenLink}
              onOpenLink={(url) => openConversationLink(target.id, url)}
              onOpenConversation={(id) =>
                openConversationLink(
                  target.id,
                  `buzz://channel/${encodeURIComponent(id)}`,
                )
              }
            />
          ),
        }),
      label:
        tab.kind === "thread"
          ? threadLabel(tab, target?.name)
          : (target?.name ?? "Unavailable conversation"),
      icon:
        tab.kind === "thread" ? (
          <MessageReplyIcon size="1rem" />
        ) : target ? (
          conversationIcon(target)
        ) : (
          <BrowserIcon size="1rem" />
        ),
      close: () => closeConversationTab(tab.id),
      ...(tab.kind === "conversation" &&
        target && { toolbar: conversationToolbar?.(target, openChannel) }),
      ...(tab.kind === "thread" && {
        attentionRequest: tab.attentionRequest,
        move: (delta: -1 | 1) => moveBy(tab, delta),
        rename: (name: string) => tabState.renameTab(tab.id, name),
      }),
      ...(openChannel && {
        actions: [{ label: "Open in channel", run: openChannel }],
      }),
      content:
        !usable || !target ? (
          <p role="status" className={styles.empty}>
            This conversation is no longer available.
          </p>
        ) : tab.kind === "thread" && nodes.get(tab.id) ? (
          <TabSlot node={nodes.get(tab.id) as HTMLDivElement} />
        ) : (
          <ConversationTab
            focusOnMount={continuingVisit}
            active={tabState.paneOpen && selectedTab === tab.id}
            visit={visits}
            tab={tab}
            channel={target}
            session={queries}
            scope={scope}
            extensions={extensions}
            openLink={(url, origin) =>
              openConversationLink(target.id, url, origin)
            }
            canOpenLink={canOpenLink}
            openThread={(id, root, intent) =>
              openConversationThread(target.id, id, root, intent)
            }
            close={() => closeConversationTab(tab.id)}
            parent={parentOf(tab, target)}
          />
        ),
    };
  }

  function panelItem(entry: Opening) {
    const id = tabId(entry);
    if (tabState.paneOpen && selectedTab === id) visitTab.shown.add(id);
    return {
      id,
      instance: entry,
      label: entry.panel.title,
      ...(entry.channelContext && {
        icon: <InfoIcon size="1rem" />,
      }),
      close: () => closeTab(entry),
      content:
        !entry.panel.deferUntilShown || visitTab.shown.has(id) ? (
          <PanelCard
            panel={entry.panel}
            contentKey={panelContentTarget(entry)}
            target={entry.target}
            context={panelContext(entry)}
            channelContext={entry.channelContext}
            close={() => closeTab(entry)}
          />
        ) : null,
    };
  }

  // Close all tabs and Close other tabs: one store update, including hidden
  // tabs. False when the visit ended or nothing would change: nothing to
  // close and the kept tab already selected.
  const closeTabsExcept = (keep?: string) => {
    const closing = tabState.tabs.filter((tab) => tab.id !== keep);
    const closingEntries = tabState.entries.filter(
      (entry) => panelTabId(entry) !== keep,
    );
    const unselected =
      (tabState.tabs.some((tab) => tab.id === keep) ||
        tabState.entries.some((entry) => panelTabId(entry) === keep) ||
        (!!tabState.settings && keep === "settings")) &&
      !(tabState.paneOpen && selectedTab === keep);
    if (
      !currentVisit() ||
      navigationSignal?.aborted ||
      !(
        closing.length ||
        tabState.entries.some((entry) => panelTabId(entry) !== keep) ||
        (tabState.settings && keep !== "settings") ||
        tabState.thread ||
        unselected
      )
    )
      return false;
    const addressed = closing.find(
      (tab) =>
        tab.kind === "thread" &&
        routed?.channelId === tab.channelId &&
        routed.messageId === tab.messageId,
    );
    entryList.current = entryList.current.filter(
      (entry) => panelTabId(entry) === keep,
    );
    opening.current = entryList.current[0];
    tabState.closeTabs(keep);
    if (onCloseTabs) onCloseTabs(closing, closingEntries, keep);
    else if (addressed?.kind === "thread")
      onCloseThread?.(addressed, false, true);
    return true;
  };

  return {
    open,
    opened,
    panel,
    panelTabs,
    selectOpening,
    selectPanelTab,
    afterClose,
    closePane: () => {
      if (!currentVisit()) return;
      focusSplit.current = true;
      tabState.setPaneOpen(false);
    },
    closeTab,
    closeAllTabs: () => closeTabsExcept(),
    closeOtherTabs: (id: string) => closeTabsExcept(id),
    selectedTab,
    drawer,
    drawerContext,
    splitTrigger,
    panelTrigger,
    canOpenLink,
    openConversationLink,
    openConversationThread,
    openLinkedThread,
    /** Whether a tab for this conversation could show it. */
    canOpenConversation: (channelId: string) =>
      !!tabChannel({ kind: "conversation", channelId }),
    announcement,
    drag,
    // Thread content renders here once and is attached to its tab's slot.
    hosts: tabState.tabs.flatMap((tab) => {
      if (tab.kind !== "thread" || withholdThreads) return [];
      const node = nodes.get(tab.id);
      const target = tabChannel(tab);
      if (!node || !target) return [];
      const active = tabState.paneOpen && selectedTab === tab.id;
      if (active) visitTab.shown.add(tab.id);
      else if (!visitTab.shown.has(tab.id)) return [];
      const route =
        routed?.channelId === tab.channelId &&
        routed.messageId === tab.messageId
          ? routed.navigation
          : undefined;
      return [
        createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: Escape from the hosted thread closes its tab, as in the tab host.
          <div
            className={tabStyles.tabSlot}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                // Shift+Escape is Mark all as read, not a dismissal.
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                !event.defaultPrevented &&
                event.currentTarget.contains(event.target as Node)
              ) {
                event.stopPropagation();
                closeConversationTab(tab.id);
              }
            }}
          >
            <ConversationTab
              focusOnMount={continuingVisit}
              restored={visitTab.entered.get(tab.id)}
              active={active}
              visit={visits}
              tab={tab}
              channel={target}
              session={queries}
              scope={scope}
              extensions={extensions}
              navigation={route}
              onRetryNavigation={onRetryNavigation}
              onResolvedRoot={(rootId) =>
                tabState.resolveThreadRoot(tab.id, rootId)
              }
              onDifferentThread={(requested, kept) =>
                tabState.divertThread(tab.id, requested, kept)
              }
              openLink={(url, origin) =>
                openConversationLink(target.id, url, origin)
              }
              canOpenLink={canOpenLink}
              openThread={(id, root, intent) =>
                openConversationThread(target.id, id, root, intent)
              }
              close={() => closeConversationTab(tab.id)}
              parent={parentOf(tab, target)}
            />
          </div>,
          node,
          tab.id,
        ),
      ];
    }),
    items: [...tabState.tabs.map(tabItem), ...panelTabs.map(panelItem)],
  };
}
