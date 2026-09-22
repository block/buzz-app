import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { useChannelPanels } from "./useChannelPanels";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { ChannelSidebarItem } from "./ChannelSidebarItem";
import { SessionMessageTarget } from "../../features/sessions/SessionMessageTarget";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  NewSessionView,
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import { UnreadOptions } from "./UnreadBadge";
import { SidebarUnread } from "./SidebarUnread";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CaretRightIcon,
  HashIcon,
  DotsThreeIcon,
  PlugIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import type { PagesReader } from "../../features/pages/service";
import { PanelCard } from "../../features/panels/PanelCard";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { MediaReviewViewer } from "../../features/messages/MediaReviewViewer";
import type { Attachment } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { sidebarSections } from "./sidebar-sections";
import { SidebarSectionIcon } from "./SidebarSectionIcon";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MAX_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
  useSidebarView,
} from "./useSidebarView";
import styles from "./Channels.module.css";

export function ChannelsPage({
  extensions,
  relay,
  panels,
  pages,
  companion,
  navigation,
  navigator,
}: {
  extensions?: ConversationExtensions | undefined;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  panels: Panels;
  pages: PagesReader;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  const registeredPages = useSyncExternalStore(
    pages.subscribe,
    pages.snapshot,
    pages.snapshot,
  );
  const sessionsEnabled = registeredPages.some(
    (page) => page.pluginId === "buzz.sessions",
  );
  const sessionNavigation = navigation?.forSession(relay, session);
  useEffect(() => {
    if (!navigation || !sessionNavigation) return;
    if (session.status === "disconnected" && navigation.target.kind === "page")
      sessionNavigation.complete({ status: "opened" });
    else if (session.status === "error")
      sessionNavigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, sessionNavigation, session.status]);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" ? (
        <PanelFrame companion={companion}>
          <div className={styles.connect}>
            <div className={styles.connectIcon}>
              <PlugIcon size={30} />
            </div>
            <h1>Your channels, one conversation.</h1>
            <p>
              {session.status === "connecting"
                ? "Connecting to your relay…"
                : (session.error ??
                  "Use Switch community at the top left to choose or add a community. Your profile and settings work without a community.")}
            </p>
            {session.status === "error" && (
              <>
                <Button type="button" onClick={relay.retry}>
                  Connect relay
                </Button>
                <p className={styles.note}>
                  For development, set <code>BUZZ_DEV_VIEWER</code> to your Buzz
                  public key in <code>.env.local</code>, then restart{" "}
                  <code>just web</code> or <code>just desktop</code>. See
                  README.md for requirements.
                </p>
              </>
            )}
          </div>
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          queries={session.session}
          relay={relay}
          navigation={sessionNavigation}
          navigator={navigator}
          viewer={session.viewer}
          panels={panels}
          sessionsEnabled={sessionsEnabled}
          companion={companion}
        />
      )}
    </section>
  );
}

function ChannelWorkspace({
  extensions,
  queries,
  relay,
  panels,
  sessionsEnabled,
  scope,
  companion,
  navigation,
  navigator,
  viewer,
}: {
  extensions?: ConversationExtensions | undefined;
  companion?: ReactNode;
  scope: string;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  viewer?: string | undefined;
  queries: RelaySession;
  relay: RelayData;
  panels: Panels;
  sessionsEnabled: boolean;
}) {
  const list = useChannelList(queries.channels);
  const activity = useSyncExternalStore(
    queries.agentActivity.subscribe,
    queries.agentActivity.snapshot,
    queries.agentActivity.snapshot,
  );
  const workingChannels = new Set([
    ...activity.turns
      .filter((turn) => turn.state === "working")
      .map((turn) => turn.channelId),
    ...activity.typing
      .filter((entry) => !entry.threadRootId)
      .map((entry) => entry.channelId),
  ]);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  useEffect(() => {
    void queries.emoji.ensure();
  }, [queries]);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const [draftParent, setDraftParent] = useState<string>();
  const [draftParents, setDraftParents] = useState<string[]>(() => {
    const saved = readView<unknown>(scope, "sessions:channel-drafts", []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
  const updateDraftParents = useCallback(
    (update: (previous: string[]) => string[]) => {
      setDraftParents((previous) => {
        const next = update(previous);
        writeView(scope, "sessions:channel-drafts", next);
        return next;
      });
    },
    [scope],
  );
  const navigate = useCallback(
    (id: string) => {
      setSelected(id);
      writeView(scope, "selected-channel", id);
      if (navigator && viewer) {
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      }
    },
    [navigator, viewer, scope],
  );
  const [thread, setThread] = useState<{
    channelId: string;
    messageId: string;
  }>();
  const select = useCallback(
    (id: string) => {
      setDraftParent(undefined);
      navigate(id);
      setThread(undefined);
    },
    [navigate],
  );
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const sidebar = useSidebarView(
    scope,
    list.status === "ready" && preferences.status !== "loading",
  );
  const channels = useChannelLabels(list.channels, queries.profiles);
  const childrenByParent = useMemo(() => {
    const children = new Map<string, typeof channels>();
    for (const item of channels) {
      if (item.channelType !== "session" || !item.parentChannelId) continue;
      const siblings = children.get(item.parentChannelId) ?? [];
      siblings.push(item);
      children.set(item.parentChannelId, siblings);
    }
    for (const siblings of children.values())
      siblings.sort(
        (a, b) =>
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
      );
    return children;
  }, [channels]);
  const requestedChannel =
    navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined;
  const current = requestedChannel
    ? (channels.find((channel) => channel.id === requestedChannel) ??
      (list.coverage === "partial"
        ? { id: requestedChannel, name: "Conversation" }
        : undefined))
    : (channels.find((channel) => channel.id === selected) ??
      channels.find((item) => item.channelType !== "session"));
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (requestedChannel && list.status === "ready" && !current)
      navigation?.complete({ status: "failed", reason: "unavailable" });
    if (!requestedChannel && !current && list.status === "ready")
      navigation?.complete({ status: "opened" });
    if (!requestedChannel && current && navigation && viewer) {
      // Resolve the saved default within this attempt, keeping its caller and deadline.
      navigation.resolve({
        version: 1,
        kind: "conversation",
        channelId: current.id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    }
  }, [requestedChannel, current, list.status, navigation, viewer, scope]);
  const requestedMessage =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const requestedThread =
    navigation?.target.kind === "conversation"
      ? navigation.target.threadRootId
      : undefined;
  const currentId = current?.id;
  const drafting =
    !!draftParent && draftParent === currentId && !requestedMessage;
  useEffect(() => {
    if (
      drafting &&
      navigation?.target.kind === "conversation" &&
      !navigation.target.messageId
    )
      navigation.complete({ status: "opened" });
  }, [drafting, navigation]);
  const flatSession = current?.channelType === "session";
  const [exactOpening, setExactOpening] = useState<{
    request: PageNavigation;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      !navigation ||
      !requestedMessage ||
      (!flatSession && requestedThread === requestedMessage) ||
      !currentId ||
      navigation.signal.aborted
    )
      return;
    let selected = false;
    const choose = () => {
      if (selected || navigation.signal.aborted) return;
      const window = queries.channels.window(currentId);
      if (window.status === "idle" || window.status === "loading") return;
      selected = true;
      // Freeze the presentation for this attempt. An isolated lookup or later
      // live event must not move an already-opened thread into the timeline.
      setExactOpening({
        request: navigation,
        inTimeline:
          (flatSession || requestedThread !== requestedMessage) &&
          window.status === "ready" &&
          window.freshness !== "cached" &&
          window.rows.some(
            (row) =>
              row.id === requestedMessage && (flatSession || !row.threadRootId),
          ),
      });
    };
    const stop = queries.channels.subscribeWindow(currentId, choose);
    choose();
    return stop;
  }, [
    navigation,
    requestedMessage,
    requestedThread,
    currentId,
    queries,
    flatSession,
  ]);
  const exact =
    !flatSession &&
    navigation &&
    requestedMessage &&
    requestedThread === requestedMessage
      ? { request: navigation, inTimeline: false }
      : exactOpening?.request === navigation
        ? exactOpening
        : undefined;
  type ShowingThread = {
    channelId: string;
    messageId: string;
    navigation?: PageNavigation | undefined;
  };
  const priorRoutedThread = useRef<ShowingThread | undefined>(undefined);
  let showingThread: ShowingThread | undefined = requestedMessage
    ? exact && !exact.inTimeline && current
      ? { channelId: current.id, messageId: requestedMessage, navigation }
      : undefined
    : thread && thread.channelId === current?.id
      ? { ...thread, navigation: undefined }
      : undefined;
  if (flatSession) {
    showingThread = undefined;
    priorRoutedThread.current = undefined;
  }
  if (showingThread?.navigation) priorRoutedThread.current = showingThread;
  else if (!showingThread && (!navigation || (requestedMessage && !exact)))
    showingThread = priorRoutedThread.current;
  else priorRoutedThread.current = undefined;
  useEffect(() => {
    if (thread && !showingThread) setThread(undefined);
  }, [thread, showingThread]);
  type Opening = { channelId: string; panel: RegisteredPanel; target: string };
  const [opened, setOpened] = useState<Opening>();
  const opening = useRef<Opening | undefined>(undefined);
  const open = useCallback((next: Opening | undefined) => {
    // Retire callbacks synchronously, before React commits the next opening.
    opening.current = next;
    setOpened(next);
  }, []);
  const startSession = useCallback(
    (parentId: string) => {
      select(parentId);
      setDraftParent(parentId);
      sidebar.toggle(`session-children:${parentId}`, true);
      updateDraftParents((previous) =>
        previous.includes(parentId) ? previous : [...previous, parentId],
      );
      setThread(undefined);
      open(undefined);
    },
    [select, sidebar.toggle, updateDraftParents, open],
  );
  const panel =
    opened &&
    opened.channelId === current?.id &&
    available.includes(opened.panel)
      ? opened.panel
      : undefined;
  const mounted = useRef(false);
  const channel = useRef(current?.id);
  useLayoutEffect(() => {
    channel.current = current?.id;
  }, [current?.id]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (opened && !panel) open(undefined);
  }, [opened, panel, open]);
  const openThread = useCallback(
    (messageId: string, threadRootId: string) => {
      if (!currentId) return;
      const target = navigator?.snapshot().entry.target;
      if (
        target?.kind === "conversation" &&
        target.channelId === currentId &&
        target.messageId === messageId &&
        target.threadRootId === threadRootId
      )
        return;
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (navigator && viewer) {
        setThread(undefined);
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: currentId,
          messageId,
          threadRootId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      } else setThread({ channelId: currentId, messageId });
      open(undefined);
    },
    [currentId, navigator, viewer, scope, open],
  );
  const mediaReviewTrigger = useRef<HTMLElement | null>(null);
  const [mediaReview, setMediaReview] = useState<{
    channelId: string;
    channelName: string;
    messageId: string;
    attachment: Attachment;
    initialTime: number;
    entryId?: string | undefined;
  }>();
  const showingMediaReview = mediaReviewForDestination(
    mediaReview,
    current?.id,
    navigation?.entryId,
  );
  useEffect(() => {
    if (mediaReview && !showingMediaReview) setMediaReview(undefined);
  }, [mediaReview, showingMediaReview]);
  const openMediaReview = useCallback(
    (messageId: string, attachment: Attachment, initialTime: number) => {
      if (!current) return;
      mediaReviewTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setThread(undefined);
      setMediaReview({
        channelId: current.id,
        channelName: current.name,
        messageId,
        attachment,
        initialTime,
        ...(navigation ? { entryId: navigation.entryId } : {}),
      });
    },
    [current, navigation],
  );
  useEffect(() => {
    if (
      mediaReview &&
      list.status === "ready" &&
      list.coverage !== "partial" &&
      !list.channels.some(
        (channel) => channel.id === mediaReview.channelId && !channel.archived,
      )
    )
      setMediaReview(undefined);
  }, [mediaReview, list]);
  const openActivityThread = useCallback(
    (channelId: string, rootId: string) => {
      threadTrigger.current =
        sidebar.list.current?.querySelector<HTMLElement>(
          `[data-channel-id="${CSS.escape(channelId)}"]`,
        ) ?? null;
      if (navigator && viewer) {
        setThread(undefined);
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId,
          messageId: rootId,
          threadRootId: rootId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      } else {
        navigate(channelId);
        setThread({ channelId, messageId: rootId });
      }
      open(undefined);
    },
    [navigate, navigator, viewer, scope, sidebar.list, open],
  );
  const closeThread = () => {
    if (showingThread?.navigation && current) select(current.id);
    setThread(undefined);
    if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  };
  const panelTrigger = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    open(undefined);
    if (panelTrigger.current?.isConnected)
      panelTrigger.current.focus({ preventScroll: true });
    else if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  }, [open]);
  // Availability follows active contributions; dispatch still re-resolves at click time.
  const canOpenLink = useCallback(
    (target: string) =>
      available.some((candidate) => {
        try {
          return candidate.matches(target);
        } catch {
          return false;
        }
      }),
    [available],
  );
  const linkContext = useRef({
    channelId: currentId,
    routedThread: !!showingThread?.navigation,
  });
  useLayoutEffect(() => {
    linkContext.current = {
      channelId: currentId,
      routedThread: !!showingThread?.navigation,
    };
  }, [currentId, showingThread?.navigation]);
  const openLink = useCallback(
    (url: string) => {
      const connection = relay.snapshot();
      if (
        !mounted.current ||
        channel.current !== current?.id ||
        connection.status !== "ready" ||
        connection.session !== queries ||
        navigation?.signal.aborted
      )
        return false;
      if (isBuzzLink(url) && navigator && viewer) {
        const target = buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
        // Internal panel targets also use buzz:. Only routable links belong
        // to the navigator; registered panels handle the remaining targets.
        if (target) {
          if (target.kind === "conversation" && target.messageId)
            threadTrigger.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          setThread(undefined);
          open(undefined);
          void navigator.open(target);
          return true;
        }
      }
      const candidate = panels.resolve(url);
      const context = linkContext.current;
      if (context.channelId && candidate) {
        panelTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (context.routedThread) select(context.channelId);
        setThread(undefined);
        open({
          channelId: context.channelId,
          panel: candidate,
          target: url,
        });
        return true;
      }
      return false;
    },
    [
      panels,
      current,
      open,
      relay,
      queries,
      navigation,
      select,
      navigator,
      viewer,
      scope,
    ],
  );
  const panelActive = () => {
    const connection = relay.snapshot();
    return !!(
      mounted.current &&
      opened &&
      panel &&
      opening.current === opened &&
      channel.current === opened.channelId &&
      panels.snapshot().includes(panel) &&
      connection.status === "ready" &&
      connection.session === queries &&
      !navigation?.signal.aborted
    );
  };
  const panelContext =
    opened && panel
      ? {
          channelId: opened.channelId,
          canOpen: (target: string) => !!panels.resolve(target),
          open: (target: string) => {
            if (!panelActive()) return false;
            const next = panels.resolve(target);
            if (!next) return false;
            // Keep the original conversation trigger for close/focus restoration.
            open({ channelId: opened.channelId, panel: next, target });
            return true;
          },
        }
      : undefined;
  const drawerContext = useMemo(
    () =>
      current && viewer
        ? {
            scope,
            viewer,
            channelId: current.id,
            channelName: current.name,
            relayUrl: scope
              .slice(0, -(viewer.length + 1))
              .replace(/^https:/, "wss:")
              .replace(/^http:/, "ws:"),
            ...(showingThread && { threadId: showingThread.messageId }),
          }
        : undefined,
    [scope, viewer, current, showingThread],
  );
  const drawer = useChannelPanels(panels, drawerContext);
  return (
    <div
      className={`${styles.board} ${panel || showingThread || companion ? styles.withPanel : ""}`}
      style={
        {
          "--channel-sidebar-width": `${sidebar.width}px`,
        } as CSSProperties
      }
    >
      <Panel as="aside" aria-label="Channel sidebar">
        <div className={styles.sidebar}>
          <SidebarUnread listRef={sidebar.list}>
            {sidebarSections(channels, preferences.data).map((section) => (
              <details
                key={section.key}
                className={styles.channelSection}
                open={!sidebar.collapsed.includes(section.key)}
              >
                {/* biome-ignore lint/a11y/noStaticElementInteractions: native summary supports pointer and keyboard activation. */}
                <summary
                  onClick={(event) => {
                    event.preventDefault();
                    sidebar.toggle(
                      section.key,
                      sidebar.collapsed.includes(section.key),
                    );
                  }}
                >
                  <CaretRightIcon
                    className={styles.sectionChevron}
                    size={17}
                    aria-hidden="true"
                  />
                  {section.icon && (
                    <SidebarSectionIcon icon={section.icon} session={queries} />
                  )}
                  <span>{section.title}</span>
                </summary>
                {section.rows.map((channel) => {
                  const sessions = childrenByParent.get(channel.id);
                  const selected =
                    current?.id === channel.id ||
                    sessions?.some((child) => child.id === current?.id)
                      ? current?.id
                      : undefined;
                  return (
                    <ChannelSidebarItem
                      key={channel.id}
                      channel={channel}
                      session={queries}
                      working={workingChannels.has(channel.id)}
                      sessionsEnabled={sessionsEnabled}
                      selected={selected}
                      collapsed={sidebar.collapsed.includes(
                        `session-children:${channel.id}`,
                      )}
                      onToggle={sidebar.toggle}
                      draft={draftParents.includes(channel.id)}
                      draftSelected={drafting && draftParent === channel.id}
                      sessions={sessions}
                      onSelect={select}
                      onNewSession={startSession}
                      onOpenThread={openActivityThread}
                    />
                  );
                })}
              </details>
            ))}
            {list.status === "loading" && !list.channels.length && (
              <p className={styles.empty}>Loading your channels…</p>
            )}
            {list.status === "error" && (
              <p role="alert" className={styles.empty}>
                {list.error}
              </p>
            )}
            {list.status === "ready" && !channels.length && (
              <p className={styles.empty}>No channels yet.</p>
            )}
          </SidebarUnread>
          {preferences.status !== "ready" && (
            <div className={styles.preferenceNotice} role="status">
              {preferences.status === "loading"
                ? "Loading saved groups and stars…"
                : preferences.status === "unsupported"
                  ? "Saved groups and stars aren’t supported by this host yet."
                  : "Couldn’t refresh saved groups and stars. Your conversations are still available."}
              {preferences.status === "error" && (
                <Button type="button" onClick={preferences.reload}>
                  Retry
                </Button>
              )}
            </div>
          )}
        </div>
      </Panel>
      <ChannelSidebarResizeHandle
        width={sidebar.width}
        setWidth={sidebar.setWidth}
      />
      <Panel as="article" aria-label="Conversation">
        <div className={styles.conversation}>
          {drafting && current ? (
            <NewSessionView parentName={current.name}>
              <NewSessionComposer
                extensions={extensions}
                key={current.id}
                session={queries}
                scope={scope}
                parent={current}
                onStarted={(id) => {
                  updateDraftParents((previous) =>
                    previous.filter((parent) => parent !== current.id),
                  );
                  select(id);
                }}
              />
            </NewSessionView>
          ) : (
            <>
              {current?.channelType === "session" ? (
                <SessionHeading
                  channel={current}
                  parentName={
                    channels.find(
                      (parent) => parent.id === current.parentChannelId,
                    )?.name
                  }
                />
              ) : (
                <PanelHeader
                  title={current?.name ?? "Channels"}
                  icon={
                    current?.channelType === "dm" ? (
                      <ChatCircleIcon size={20} />
                    ) : (
                      <HashIcon size={20} />
                    )
                  }
                  actions={
                    <>
                      {drawer.launchers}
                      <details className={styles.diagnostics}>
                        <summary
                          aria-label="Conversation options"
                          title="Conversation options"
                        >
                          <DotsThreeIcon size={19} aria-hidden="true" />
                        </summary>
                        <div className={styles.diagnosticsMenu}>
                          <UnreadOptions
                            session={queries}
                            channelId={current?.id}
                          />
                          <details>
                            <summary>Diagnostics</summary>
                            <LiveStatus
                              live={queries.live}
                              channelId={current?.id}
                              partialRoster={list.coverage === "partial"}
                              diagnostics
                            />
                            <p>
                              {list.coverage === "partial"
                                ? "Partial roster"
                                : "Roster"}{" "}
                              · {channels.length} channels
                            </p>
                            <Button
                              type="button"
                              onClick={() => queries.channels.refreshList?.()}
                            >
                              Refresh channels
                            </Button>
                            {preferences.error && (
                              <p>Saved groups and stars: {preferences.error}</p>
                            )}
                            {preferences.status !== "unsupported" && (
                              <Button
                                type="button"
                                disabled={preferences.status === "loading"}
                                onClick={preferences.reload}
                              >
                                Refresh groups and stars
                              </Button>
                            )}
                            {current && (
                              <Button
                                type="button"
                                onClick={() =>
                                  queries.channels.refresh?.(current.id)
                                }
                              >
                                Refresh messages
                              </Button>
                            )}
                            {queries.outbox ? (
                              <OutboxStatus
                                outbox={queries.outbox}
                                profiling={queries.profiling}
                              />
                            ) : (
                              <RelayTimings profiling={queries.profiling} />
                            )}
                          </details>
                        </div>
                      </details>
                    </>
                  }
                />
              )}
              <SessionColumn enabled={flatSession}>
                <LiveStatus
                  live={queries.live}
                  channelId={current?.id}
                  partialRoster={list.coverage === "partial"}
                />
                {flatSession &&
                current &&
                navigation &&
                requestedMessage &&
                exact &&
                !exact.inTimeline ? (
                  <SessionMessageTarget
                    key={`${current.id}:${requestedMessage}`}
                    session={queries}
                    scope={scope}
                    channelId={current.id}
                    messageId={requestedMessage}
                    navigation={navigation}
                    extensions={extensions}
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    onLatest={() => select(current.id)}
                    onRetry={() => {
                      void navigator?.retry();
                    }}
                  />
                ) : current ? (
                  <ChannelBody
                    viewer={viewer}
                    extensions={extensions}
                    key={current.id}
                    queries={queries}
                    scope={scope}
                    channelId={current.id}
                    navigation={
                      flatSession || !requestedMessage || exact?.inTimeline
                        ? navigation
                        : undefined
                    }
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    onOpenThread={flatSession ? undefined : openThread}
                    onOpenMediaReview={openMediaReview}
                    revealMessageId={
                      sent?.channelId === current.id ? sent.id : undefined
                    }
                  />
                ) : (
                  <div className={styles.empty}>
                    Select a channel to read it.
                  </div>
                )}
                {current && (
                  <MessageComposer
                    sessionConversation={current.channelType === "session"}
                    extensions={extensions}
                    key={`composer:${current.id}`}
                    session={queries}
                    scope={scope}
                    channelId={current.id}
                    channelName={current.name}
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    label={
                      current.channelType === "session"
                        ? "Message this session"
                        : undefined
                    }
                    onSend={(id) => {
                      setSent({ channelId: current.id, id });
                      if (flatSession && requestedMessage) select(current.id);
                    }}
                  />
                )}
              </SessionColumn>
              {drawer.content}
            </>
          )}
        </div>
      </Panel>
      {showingMediaReview && (
        <MediaReviewViewer
          extensions={extensions}
          attachment={showingMediaReview.attachment}
          session={queries}
          scope={scope}
          channelId={showingMediaReview.channelId}
          channelName={showingMediaReview.channelName}
          messageId={showingMediaReview.messageId}
          initialTime={showingMediaReview.initialTime}
          restoreFocus={mediaReviewTrigger}
          close={() => setMediaReview(undefined)}
        />
      )}
      {!showingMediaReview && (panel || showingThread || companion) && (
        <div className={styles.panelStack}>
          {showingThread && (
            <ThreadPanel
              sessionConversation={current?.channelType === "session"}
              extensions={extensions}
              session={queries}
              scope={scope}
              channelName={current?.name ?? ""}
              channelId={showingThread.channelId}
              messageId={showingThread.messageId}
              navigation={showingThread.navigation}
              close={closeThread}
              onOpenLink={openLink}
              onOpenMediaReview={openMediaReview}
              canOpenLink={canOpenLink}
            />
          )}

          {panel && opened && (
            <PanelCard
              key="target"
              panel={panel}
              target={opened.target}
              context={panelContext}
              close={close}
              closeLabel="Close channel panel"
            />
          )}
          {companion && (
            <div key="companion" className={styles.companion}>
              {companion}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelSidebarResizeHandle({
  width,
  setWidth,
}: {
  width: number;
  setWidth(width: number): void;
}) {
  const handle = useRef<HTMLHRElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(width);
  const drag = useRef<
    { pointerId: number; startX: number; width: number } | undefined
  >(undefined);
  const resize = useRef(setWidth);
  resize.current = setWidth;
  const move = useCallback((event: PointerEvent) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    resize.current(drag.current.width + event.clientX - drag.current.startX);
  }, []);
  const finish = useCallback(() => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    drag.current = undefined;
    delete document.documentElement.dataset.sidebarResizing;
    document.documentElement.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [move]);
  const measure = useCallback(() => {
    const sidebar = handle.current?.previousElementSibling;
    if (!(sidebar instanceof HTMLElement)) return;
    const next = Math.round(sidebar.getBoundingClientRect().width);
    setRenderedWidth((current) => (current === next ? current : next));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  useEffect(() => () => finish(), [finish]);

  return (
    <hr
      ref={handle}
      className={styles.sidebarResizeHandle}
      aria-label="Resize channel sidebar"
      aria-orientation="vertical"
      aria-valuemin={CHANNEL_SIDEBAR_MIN_WIDTH}
      aria-valuemax={CHANNEL_SIDEBAR_MAX_WIDTH}
      aria-valuenow={Math.round(renderedWidth)}
      tabIndex={0}
      data-tooltip="Drag to resize · Double-click to reset"
      onDoubleClick={() => setWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        if (event.key === "ArrowLeft") setWidth(renderedWidth - step);
        else if (event.key === "ArrowRight") setWidth(renderedWidth + step);
        else if (event.key === "Home") setWidth(CHANNEL_SIDEBAR_MIN_WIDTH);
        else if (event.key === "End") setWidth(CHANNEL_SIDEBAR_MAX_WIDTH);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const sidebar = event.currentTarget.previousElementSibling;
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          width:
            sidebar instanceof HTMLElement
              ? sidebar.getBoundingClientRect().width
              : renderedWidth,
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish, { once: true });
        window.addEventListener("pointercancel", finish, { once: true });
        document.documentElement.dataset.sidebarResizing = "true";
        document.documentElement.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
    />
  );
}

export function mediaReviewForDestination<
  T extends { channelId: string; entryId?: string | undefined },
>(
  review: T | undefined,
  channelId: string | undefined,
  entryId: string | undefined,
): T | undefined {
  return review &&
    review.channelId === channelId &&
    (review.entryId === undefined || review.entryId === entryId)
    ? review
    : undefined;
}

const ChannelBody = memo(function ChannelBody({
  viewer,
  extensions,
  scope,
  queries,
  channelId,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  onOpenThread,
  onOpenMediaReview,
  navigation,
}: {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  queries: RelaySession;
  viewer?: string | undefined;
  channelId: string;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string) => void)
    | undefined;
  onOpenMediaReview(
    messageId: string,
    attachment: Attachment,
    seconds: number,
  ): void;
}) {
  const window = useChannelWindow(queries.channels, channelId);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    else if (window.status === "error")
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, window.status]);
  if (window.status === "error" && !window.rows.length)
    return (
      <div className={styles.empty} role="alert">
        <p>{window.error}</p>
        <Button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </Button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <div className={styles.empty} role="status">
        Loading messages…
      </div>
    );
  return (
    <ChannelTimeline
      viewer={viewer}
      extensions={extensions}
      scope={scope}
      channelId={channelId}
      queries={queries}
      window={window}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      {...(onOpenThread ? { onOpenThread } : {})}
      onOpenMediaReview={onOpenMediaReview}
      revealMessageId={revealMessageId}
      navigation={navigation}
    />
  );
});
