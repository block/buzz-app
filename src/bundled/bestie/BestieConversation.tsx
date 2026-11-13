import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChannelHeaderMenu } from "../channels/ChannelHeaderMenu";
import { ChannelSettingsPanel } from "../channels/ChannelSettingsPanel";
import { ChannelMembersDialog } from "../channels/ChannelMembersDialog";
import { UnreadOptions } from "../channels/UnreadBadge";
import { ChannelBody } from "../channels/ChannelBody";
import {
  historyPanel,
  useConversationTabs,
} from "../channels/useConversationTabs";
import {
  rootOfTab,
  tabPane,
  panelTabId,
  entryPane,
  useChannelTabState,
  type ConversationTab,
} from "../channels/useChannelTabState";
import {
  ConversationChannel,
  ConversationComposer,
  useMediaReview,
} from "../../features/conversation/Conversation";
import { LinkThreadTabContext } from "../../features/conversation/LinkLabelContext";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import { ForwardMessageProvider } from "../../features/messages/ForwardMessage";
import { MessageManagementStatus } from "../../features/messages/MessageManagement";
import { useMessageOpening } from "../../features/messages/use-message-opening";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { targetKey } from "../../features/navigation/targets";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { panelOpening, type PanelOpening } from "../../features/panels/service";
import {
  profileHistoryBase,
  profilePanelKey,
  profileActivityViewKey,
} from "../../features/profiles/target";
import { ConversationPresentation } from "../../features/conversation/ConversationPresentation";
import { Panel } from "../../shared/design-system/ui/Panel";
import { COMPANION_SPLIT } from "../../features/panels/PanelFrame";
import { PanelDock } from "../../features/panels/PanelDock";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import panelStyles from "../../features/panels/Panels.module.css";
import { flushSync } from "react-dom";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { GearIcon, SidebarRightIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  bestieBaseTarget,
  bestieConversationTarget,
  bestieRoute,
  bestieMessageRoute,
  bestieThreadTarget,
  bestieDetailRoute,
  bestieDetailTarget,
} from "./routes";
import { FirstAgentWelcome, useFirstAgentWelcome } from "./FirstAgentWelcome";
import styles from "./PinnedBestie.module.css";

/** Bestie owns its pinned destination; Messages owns conversation tabs and readers. */
export function BestieConversation({
  session,
  scope,
  host,
  extensions,
  navigator,
  navigation,
  channel,
  agent,
  community,
  icon,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  channel: ChannelSummary;
  agent: { pubkey: string; name: string; picture?: string | undefined };
  community?: string | undefined;
  icon: ReactNode;
}) {
  const bestie = agent.name;
  const welcome = useFirstAgentWelcome(scope, agent.pubkey, channel.id);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const membersTrigger = useRef<HTMLElement | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const availablePanels = useSyncExternalStore(
    host.panels.subscribe,
    host.panels.snapshot,
  );
  const openMembers = () => {
    membersTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMembersOpen(true);
  };
  const [sent, setSent] = useState<string>();
  const [composerFocus, focusComposer] = useState(0);
  const trigger = useRef<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const dismissedTo = useRef<{
    from: string;
    target: string;
    arrival?: { entryId: string; signal: AbortSignal };
  }>(undefined);
  const pending = dismissedTo.current;
  if (navigation && pending && navigation.entryId !== pending.from) {
    if (!pending.arrival && targetKey(navigation.target) === pending.target)
      pending.arrival = {
        entryId: navigation.entryId,
        signal: navigation.signal,
      };
    else if (
      pending.arrival?.entryId !== navigation.entryId ||
      pending.arrival.signal !== navigation.signal
    )
      dismissedTo.current = undefined;
  }
  const preserveNavigation =
    !!navigation && dismissedTo.current?.arrival?.signal === navigation.signal;
  const state = useChannelTabState(session, channel.id, "messages", navigator);
  const routed =
    navigation?.target.kind === "page"
      ? bestieRoute(navigation.target.route?.params)
      : undefined;
  const exact =
    navigation?.target.kind === "page"
      ? bestieMessageRoute(navigation.target.route?.params)
      : undefined;
  const detail =
    navigation?.target.kind === "page"
      ? bestieDetailRoute(navigation.target.route?.params)
      : undefined;
  const addressed = routed ?? exact ?? detail;
  // A visit handed off from Messages shows its message in the chat history on
  // its first presentation: a thread visit's root beside the thread, once it
  // is loaded or found in older history; a message visit's message, or its
  // thread when it is a reply or isn't in history. Threads Bestie opens itself
  // and Back/Forward leave the history where the reader left it.
  const opened = useRef<{ from: string; target: string; entryId?: string }>(
    undefined,
  );
  const own = opened.current;
  if (navigation && own && navigation.entryId !== own.from) {
    if (!own.entryId && targetKey(navigation.target) === own.target)
      own.entryId = navigation.entryId;
    else if (own.entryId !== navigation.entryId) opened.current = undefined;
  }
  const handedOff =
    !!navigation &&
    !navigation.traversal &&
    !preserveNavigation &&
    opened.current?.entryId !== navigation.entryId &&
    addressed?.channelId === channel.id;
  const visits = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new visit asks again for the same message.
  const visit = useMemo(() => ++visits.current, [navigation?.entryId]);
  // A thread visit's address names its root as the link's hint. The context
  // reveal follows the root a thread's reader verifies for the visit's own
  // message, recorded on the visit by the tab store: neither a hint naming an
  // unrelated message nor that message's already-open thread, verified for an
  // earlier visit, marks it; until then nothing is sought.
  const record = navigation
    ? state.routedVisits?.[navigation.entryId]
    : undefined;
  const sought = handedOff
    ? routed
      ? record?.verified
        ? record.rootId
        : undefined
      : exact?.messageId
    : undefined;
  // The reader's own move in the chat during a thread visit, a scroll or a
  // send, ends its context reveal: the root is no longer sought. A message
  // visit's reveal is the visit itself and stays, as it does in Messages: a
  // revealed activity row the chat otherwise hides keeps its place and focus.
  const [movedOn, setMovedOn] = useState<number>();
  const stayed = movedOn !== visit;
  const context = useRef<number>(undefined);
  context.current = handedOff && routed && stayed ? visit : undefined;
  const moveOn = useCallback(() => {
    if (context.current !== undefined) setMovedOn(context.current);
  }, []);
  // A message visit that opened as a thread returns to that thread. The tab
  // store's record outlives this page's mount and is pruned with history.
  const recorded = exact ? record : undefined;
  // Without that record, as when the visit was left before history answered
  // or after a reload, Back and Forward decide again between the chat and the
  // thread, without revealing the message.
  const unresolved =
    exact?.channelId === channel.id && !recorded ? exact.messageId : undefined;
  const inTimeline = useMessageOpening(
    session.channels,
    channel.id,
    (stayed ? sought : undefined) ?? unresolved,
    visit,
  );
  const thread =
    routed ??
    (recorded
      ? {
          channelId: recorded.channelId,
          messageId: recorded.messageId,
          threadRootId: recorded.rootId,
        }
      : exact && inTimeline === false
        ? { ...exact, threadRootId: exact.messageId }
        : undefined);
  const revealKey =
    sought && stayed && inTimeline
      ? JSON.stringify([sought, visit])
      : undefined;
  const [reveal, setReveal] = useState<{ key: string; signal: AbortSignal }>();
  useEffect(() => {
    if (!revealKey) return;
    const request = new AbortController();
    setReveal({ key: revealKey, signal: request.signal });
    return () => request.abort();
  }, [revealKey]);
  const ownsCurrentVisit = useCallback(
    () =>
      !navigation ||
      (!navigation.signal.aborted &&
        navigator.snapshot().entry.id === navigation.entryId),
    [navigation, navigator],
  );
  useEffect(() => {
    if (
      !addressed ||
      addressed.channelId === channel.id ||
      navigation?.target.kind !== "page" ||
      !ownsCurrentVisit()
    )
      return;
    // Never restore a former Bestie's thread in the current DM.
    const base = bestieBaseTarget(navigation.target);
    navigator.dismiss((target) => {
      if (
        target.kind !== "page" ||
        targetKey(bestieBaseTarget(target)) !== targetKey(base)
      )
        return false;
      const route =
        bestieRoute(target.route?.params) ??
        bestieMessageRoute(target.route?.params) ??
        bestieDetailRoute(target.route?.params);
      return !!route && route.channelId !== channel.id;
    }, base);
  }, [addressed, channel.id, navigation, navigator, ownsCurrentVisit]);
  const panelIdentity = (target: string) =>
    profilePanelKey(target) || profileActivityViewKey(target)
      ? profileHistoryBase(target)
      : target;
  const dismissContent = (
    tabs: readonly ConversationTab[],
    entries: readonly PanelOpening[],
    pane: "main" | "side",
  ) => {
    if (navigation?.target.kind !== "page" || !ownsCurrentVisit()) return;
    const base = bestieBaseTarget(navigation.target);
    const remainingTabs = state.tabs.filter((tab) => !tabs.includes(tab));
    const remainingEntries = state.entries.filter(
      (entry) => !entries.includes(entry),
    );
    const selections =
      pane === "main"
        ? [state.getMainSelected(), state.getSelected()]
        : [state.getSelected(), state.getMainSelected()];
    const survivor = selections
      .map((id) => ({
        thread: remainingTabs.find((tab) => tab.id === id),
        panel: remainingEntries.find(
          (entry) => panelTabId(entry) === id && historyPanel(entry),
        ),
      }))
      .find((item) => item.thread || item.panel);
    const keptThread = survivor?.thread;
    const keptPanel = survivor?.panel;
    const fallback = keptPanel
      ? bestieDetailTarget(base, {
          channelId: keptPanel.channelId,
          detail: keptPanel.target,
          ...(keptPanel.rootId && { rootId: keptPanel.rootId }),
        })
      : keptThread?.kind === "thread"
        ? bestieThreadTarget(base, {
            channelId: keptThread.channelId,
            messageId: keptThread.messageId,
            threadRootId: rootOfTab(keptThread),
          })
        : base;
    // A surviving tab already owns its reading and typing position; returning
    // to its address after Close must not issue a new message-reveal request.
    dismissedTo.current = {
      from: navigation.entryId,
      target: targetKey(fallback),
    };
    // Visits recorded as showing a closing thread, however addressed: a
    // message visit may have opened as its thread. Addresses also retire known
    // visits after reload, when local tab records have not been reconstructed
    // for every earlier visit.
    const shown = new Set(
      tabs.flatMap((tab) =>
        tab.kind === "thread"
          ? state.threadVisits(tab.channelId, rootOfTab(tab))
          : [],
      ),
    );
    navigator.dismiss((target, entryId) => {
      if (shown.has(entryId)) return true;
      if (
        target.kind !== "page" ||
        targetKey(bestieBaseTarget(target)) !== targetKey(base)
      )
        return false;
      const thread =
        bestieRoute(target.route?.params) ??
        bestieMessageRoute(target.route?.params);
      const panel = bestieDetailRoute(target.route?.params);
      // An unrecorded message visit showed a thread only when its message was
      // a reply: the closing tab's root differs from it. Otherwise, the chat.
      return (
        !!(
          thread &&
          tabs.some(
            (tab) =>
              tab.kind === "thread" &&
              tab.channelId === thread.channelId &&
              (thread.threadRootId
                ? rootOfTab(tab) === thread.threadRootId ||
                  tab.messageId === thread.messageId
                : tab.messageId === thread.messageId &&
                  rootOfTab(tab) !== thread.messageId),
          )
        ) ||
        !!(
          panel &&
          entries.some(
            (item) =>
              item.channelId === panel.channelId &&
              panelIdentity(item.target) === panelIdentity(panel.detail),
          )
        )
      );
    }, fallback);
  };
  const visitPanel = (entry: PanelOpening) => {
    if (
      navigation?.target.kind !== "page" ||
      !ownsCurrentVisit() ||
      (detail?.detail === entry.target && detail.rootId === entry.rootId)
    )
      return;
    state.leaveVisit();
    void navigator.open(
      bestieDetailTarget(navigation.target, {
        channelId: entry.channelId,
        detail: entry.target,
        ...(entry.rootId && { rootId: entry.rootId }),
      }),
    );
  };
  const secondary = useConversationTabs({
    state,
    relay: host.relay,
    session,
    panels: host.panels,
    current: channel,
    scope,
    channels: [channel],
    profiles: new Map(),
    conversationIcon: () => icon,
    extensions,
    leadingIds: state.settings ? ["settings"] : [],
    openMembers,
    onOpenDrawer: () => state.setSettings(undefined),
    continuingVisit: true,
    navigationSignal: navigation?.signal,
    isLive: ownsCurrentVisit,
    fallbackFocus: main,
    mainPane: true,
    openLink: (url) => {
      if (!session.viewer) return false;
      const target = buzzLinkTarget(url, {
        viewer: session.viewer,
        communityOrigin: scope.slice(0, -65),
      });
      if (!target || !ownsCurrentVisit()) return false;
      // A link into this DM is this page's own visit, not a Messages round trip.
      const here =
        target.kind === "conversation" && target.channelId === channel.id
          ? bestieConversationTarget(target)
          : undefined;
      void navigator.open(here ?? target);
      return true;
    },
    routed:
      thread?.channelId === channel.id && navigation && !preserveNavigation
        ? { channelId: channel.id, messageId: thread.messageId, navigation }
        : undefined,
    onVisitPanel: visitPanel,
    onClosePanel: (entry) =>
      dismissContent([], [entry], entryPane(state.mainEntries, entry)),
    onCloseThread: (tab, active, last) => {
      dismissContent([tab], [], tabPane(tab));
      if (!active || !last) return;
      const opener = trigger.current;
      if (
        opener?.isConnected &&
        !opener.closest('[inert], [aria-hidden="true"]')
      )
        opener.focus({ preventScroll: true });
      else focusComposer((value) => value + 1);
    },
    onCloseTabs: (tabs, entries) => dismissContent(tabs, entries, "main"),
  });
  const appliedVisit = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (
      !navigation ||
      !ownsCurrentVisit() ||
      (addressed?.channelId && addressed.channelId !== channel.id) ||
      // A message visit waits for history to say whether it is a thread visit.
      (exact && !thread && inTimeline === undefined) ||
      appliedVisit.current === navigation.entryId
    )
      return;
    appliedVisit.current = navigation.entryId;
    state.enterVisit(
      `${navigation.entryId}:${thread ? "thread" : detail ? "detail" : "channel"}`,
      thread && {
        channelId: channel.id,
        messageId: thread.messageId,
        rootId: thread.threadRootId,
      },
      !!detail,
      detail && { channelId: channel.id, target: detail.detail },
    );
    if (detail) {
      const opening = panelOpening(
        host.panels,
        channel.id,
        detail.detail,
        detail.rootId,
      );
      if (opening && historyPanel(opening)) secondary.open(opening, true);
      else navigation.complete({ status: "failed", reason: "unavailable" });
    }
  }, [
    navigation,
    ownsCurrentVisit,
    addressed,
    channel.id,
    state.enterVisit,
    exact,
    inTimeline,
    thread,
    detail,
    host.panels,
    secondary.open,
  ]);
  const openThread = (messageId: string, rootId: string, intent?: "reply") => {
    if (!ownsCurrentVisit()) return;
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    state.leaveVisit();
    state.openThreadTab(channel.id, messageId, rootId, intent);
    if (navigation?.target.kind === "page") {
      const target = bestieThreadTarget(navigation.target, {
        channelId: channel.id,
        messageId,
        threadRootId: rootId,
      });
      const key = targetKey(target);
      opened.current = {
        from: navigation.entryId,
        target: key,
        // Opening the shown thread again restarts this visit under its id.
        ...(key === targetKey(navigation.target) && {
          entryId: navigation.entryId,
        }),
      };
      void navigator.open(target);
    }
  };
  const media = useMediaReview();
  const split = usePanelSplit(
    scope,
    COMPANION_SPLIT.name,
    COMPANION_SPLIT.defaultWidth,
    COMPANION_SPLIT.min,
  );
  const closeSettings = () => {
    state.setSettings(undefined);
    secondary.afterClose("settings", settingsTrigger.current);
  };
  const sideItems = [
    ...(state.settings
      ? [
          {
            id: "settings",
            label: "Channel settings",
            icon: <GearIcon size="1rem" />,
            close: closeSettings,
            content: (
              <ChannelSettingsPanel
                channel={channel}
                scope={scope}
                session={session}
                openMembers={openMembers}
                close={closeSettings}
                canOpenLink={(target) => !!host.panels.resolve(target)}
                onOpenLink={(target) =>
                  secondary.openConversationLink(channel.id, target)
                }
              >
                <UnreadOptions session={session} channelId={channel.id} />
              </ChannelSettingsPanel>
            ),
          },
        ]
      : []),
    ...secondary.items,
  ];
  const paneOpen =
    state.paneOpen && (sideItems.length > 0 || !!secondary.drawer.side);
  const focusAfterClose = useRef(false);
  const closeAll = () => {
    if (!secondary.closeAllTabs()) return false;
    focusAfterClose.current = true;
    return true;
  };
  const tabMenu = {
    key: `bestie:${scope}:${channel.id}`,
    closeAll,
    closeOthers: secondary.closeOtherTabs,
  };
  useLayoutEffect(() => {
    const close = (event: Event) => {
      const workspace = main.current;
      if (
        event.defaultPrevented ||
        !ownsCurrentVisit() ||
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
  // Close All can remove both the focused content and its context menu.
  // Keep surviving controls focused; otherwise return to the main conversation.
  useLayoutEffect(() => {
    if (!focusAfterClose.current) return;
    focusAfterClose.current = false;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.isConnected &&
      !focused.closest('[inert], [hidden], [aria-hidden="true"], [role="menu"]')
    )
      return;
    (
      main.current?.querySelector<HTMLElement>(
        '[data-main-workspace] [role="tab"][data-tab-value="conversation"]',
      ) ?? main.current
    )?.focus({ preventScroll: true });
  });
  const toggle = (expanded: boolean) => (
    <IconButton
      ref={secondary.splitTrigger}
      size="sm"
      variant="ghost"
      aria-label="Toggle tab pane"
      title={expanded ? "Close tab pane" : "Open tab pane"}
      aria-expanded={expanded}
      icon={<SidebarRightIcon size="1rem" />}
      onClick={() =>
        expanded ? secondary.closePane() : state.setPaneOpen(true)
      }
    />
  );
  return (
    <ForwardMessageProvider
      session={session}
      scope={scope}
      navigation={host.navigation}
    >
      <LinkThreadTabContext value={secondary.openLinkedThread}>
        <ConversationChannel
          session={session}
          scope={scope}
          extensions={extensions}
          channel={channel}
          channelName={channel.name || bestie}
          active
          interactions={{
            onOpenLink: (url, origin) =>
              secondary.openConversationLink(channel.id, url, origin),
            canOpenLink: (url) => !!host.panels.resolve(url),
            onOpenMediaReview: media.open,
          }}
          mediaReview={media.review}
        >
          <section
            className={styles.work}
            aria-label={`Chat with ${bestie}`}
            ref={main}
            tabIndex={-1}
          >
            <div
              ref={split.ref}
              style={split.style}
              className={`${panelStyles.frame} ${panelStyles.splitMotion}`}
            >
              <div className={panelStyles.page}>
                <Panel>
                  <PanelWorkspace
                    main
                    label="Bestie conversation tabs"
                    focusOnMount={false}
                    value={secondary.selectedMain}
                    select={(id) =>
                      state.selectMain(id === "conversation" ? undefined : id)
                    }
                    tabMenu={tabMenu}
                    drag={secondary.drag.main}
                    actions={
                      <>
                        {secondary.drawer.launchers}
                        <ChannelHeaderMenu
                          channel={channel}
                          session={session}
                          origin={navigation?.signal}
                          trigger={settingsTrigger}
                          openDetails={() => {
                            secondary.drawer.close();
                            state.setSettings({ channelId: channel.id });
                          }}
                          menuPanels={
                            channel.cached
                              ? []
                              : availablePanels.filter((panel) =>
                                  panel.channelMenu?.eligible(channel, session),
                                )
                          }
                          openMenuPanel={(panel) => {
                            const connection = host.relay.snapshot();
                            const current = session.channels
                              .list()
                              .channels.find((item) => item.id === channel.id);
                            if (
                              !ownsCurrentVisit() ||
                              connection.status !== "ready" ||
                              connection.cached ||
                              connection.session !== session ||
                              !secondary.drawerContext ||
                              !current ||
                              current.cached ||
                              (current.readOnly &&
                                current.viewerRole !== "guest") ||
                              !current.members?.includes(
                                session.viewer ?? "",
                              ) ||
                              !host.panels.snapshot().includes(panel) ||
                              !panel.channelMenu?.eligible(current, session)
                            )
                              return;
                            secondary.drawer.close();
                            secondary.open(
                              {
                                panel,
                                channelId: channel.id,
                                target: channel.id,
                                channelContext: secondary.drawerContext,
                              },
                              true,
                            );
                          }}
                        />
                        {!paneOpen &&
                        (sideItems.length > 0 || secondary.drawer.side)
                          ? toggle(false)
                          : null}
                      </>
                    }
                    items={[
                      {
                        id: "conversation",
                        label: bestie,
                        icon,
                        content: (
                          <ConversationPresentation
                            value={secondary.selectedMain === "conversation"}
                          >
                            <section
                              className={styles.work}
                              data-attachment-drop-zone=""
                            >
                              <MessageManagementStatus />
                              <ChannelBody
                                intro={
                                  welcome ? (
                                    <FirstAgentWelcome
                                      name={bestie}
                                      picture={agent.picture}
                                      community={community}
                                    />
                                  ) : undefined
                                }
                                viewer={session.viewer}
                                cached={!!channel.cached}
                                revealMessageId={sent}
                                // Mount the list once, at the message, not while it
                                // is sought. A thread's root is context: the list
                                // stays, and the thread keeps focus.
                                holding={
                                  !!exact &&
                                  !!sought &&
                                  inTimeline === undefined
                                }
                                inlineTarget={
                                  sought &&
                                  reveal &&
                                  reveal.key === revealKey &&
                                  !reveal.signal.aborted
                                    ? {
                                        messageId: sought,
                                        signal: reveal.signal,
                                        focus:
                                          !routed &&
                                          navigation?.focus !== "preserve",
                                      }
                                    : undefined
                                }
                                marksRead
                                onOpenThread={openThread}
                                onReaderIntent={moveOn}
                              />
                              <ConversationComposer
                                label={`Message ${bestie}`}
                                shown={
                                  secondary.selectedMain === "conversation"
                                }
                                focusRequest={composerFocus}
                                onSend={(id) => {
                                  setSent(id);
                                  moveOn();
                                }}
                              />
                            </section>
                          </ConversationPresentation>
                        ),
                      },
                      ...secondary.mainItems,
                    ]}
                  />
                </Panel>
              </div>
              <PanelDock
                open={paneOpen}
                keepMounted={
                  state.entries.length > 0 ||
                  (sideItems.length > 0 && !state.paneOpen) ||
                  !!secondary.drawer.side
                }
                className={panelStyles.dock}
                resizeHandle={split.handle}
              >
                {sideItems.length > 0 && (
                  <Panel>
                    <PanelWorkspace
                      label="Bestie panel tabs"
                      items={sideItems}
                      value={secondary.selectedTab}
                      select={secondary.selectPanelTab}
                      actions={toggle(true)}
                      tabMenu={tabMenu}
                      drag={secondary.drag.side}
                    />
                  </Panel>
                )}
                {secondary.drawer.side}
              </PanelDock>
            </div>
            {secondary.drawer.content}
            {membersOpen && (
              <ChannelMembersDialog
                session={session}
                channelId={channel.id}
                trigger={membersTrigger}
                close={() => setMembersOpen(false)}
                signal={navigation?.signal}
                canOpenLink={(target) => !!host.panels.resolve(target)}
                onOpenLink={(target) =>
                  secondary.openConversationLink(channel.id, target)
                }
              />
            )}
            {secondary.drag.feedback}
            {secondary.hosts}
            <span role="status" className="sr-only">
              {secondary.announcement}
            </span>
          </section>
        </ConversationChannel>
      </LinkThreadTabContext>
    </ForwardMessageProvider>
  );
}
