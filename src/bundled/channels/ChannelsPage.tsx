import { personalGroups } from "../../features/channel-templates/setup";
import type { TemplateProviders } from "../../features/channel-templates/provider";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { ChannelCanvasDialog } from "./ChannelCanvasDialog";
import { Select } from "../../shared/design-system/ui/Select";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { NewMessage } from "../../features/direct-messages/NewMessage";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useChannelPanels } from "./useChannelPanels";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
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
  DotsThreeIcon,
  PlugIcon,
  ChatCircleIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
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
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { MediaReviewViewer } from "../../features/messages/MediaReviewViewer";
import type { Attachment } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useComposerSent } from "./useComposerSent";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { isChannelSectionKey, sidebarSections } from "./sidebar-sections";
import { useHiddenDms } from "./useHiddenDms";
import { SidebarSectionIcon } from "./SidebarSectionIcon";
import {
  CreateChannelDialog,
  type CreateChannelInput,
} from "./CreateChannelDialog";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MAX_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
  useSidebarView,
} from "./useSidebarView";
import styles from "./Channels.module.css";

export function ChannelsPage({
  providers,
  extensions,
  relay,
  panels,
  pages,
  companion,
  navigation,
  navigator,
}: {
  providers: TemplateProviders;
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
                  "Use the left community rail to choose or add a community. Your profile and settings work without a community.")}
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
          providers={providers}
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
  providers,
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
  providers: TemplateProviders;
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
  const [localNewMessage, setLocalNewMessage] = useState(false);
  const [preparingDm, setPreparingDm] = useState<{
    existing: Set<string>;
    members: Set<string | undefined>;
  }>();
  const composingMessage = navigator
    ? navigation?.target.kind === "page" &&
      navigation.target.route?.params === "new-message"
    : localNewMessage;
  useEffect(() => {
    if (!composingMessage) setPreparingDm(undefined);
  }, [composingMessage]);
  const list = useChannelList(queries.channels);
  const workingIds = useSyncExternalStore(
    queries.agentActivity.subscribeWorking,
    queries.agentActivity.workingSnapshot,
    queries.agentActivity.workingSnapshot,
  );
  const workingChannels = useMemo(
    () => new Set<string>(JSON.parse(workingIds)),
    [workingIds],
  );
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  const kitState = useSyncExternalStore(
    queries.channelKit.subscribe,
    queries.channelKit.snapshot,
  );
  const templateProviders = useSyncExternalStore(
    providers.subscribe,
    providers.snapshot,
  );
  const templateProvider =
    templateProviders.length === 1 ? templateProviders[0] : undefined;
  useEffect(() => {
    // Initial channel discovery cancels in-flight reads as it settles access.
    // Start the optional catalog afterward so opening Messages cannot strand it.
    if (list.status === "ready") queries.channelKit.ensure();
  }, [queries, list.status]);
  const groupEntry = personalGroups(kitState.entries);
  const personal =
    groupEntry?.record.value.type === "groups"
      ? groupEntry.record.value
      : undefined;
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [initialGroup, setInitialGroup] = useState("");
  const [kitError, setKitError] = useState("");
  const hiddenDms = useHiddenDms(scope, queries, list);
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
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const createChannelTrigger = useRef<HTMLButtonElement>(null);
  const pendingChannelCreation = useSyncExternalStore(
    queries.channelCreation.subscribe,
    queries.channelCreation.snapshot,
    queries.channelCreation.snapshot,
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
      setLocalNewMessage(false);
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
  const { channels, profiles: dmProfiles } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const childSessions = useRef(new Map<string, typeof channels>());
  // Signed discovery is needed for send admission; reveal a newly opened DM
  // in the sidebar only after its first message is confirmed.
  const sidebarChannels = channels.filter(
    (channel) =>
      !composingMessage ||
      !preparingDm ||
      preparingDm.existing.has(channel.id) ||
      channel.channelType !== "dm" ||
      channel.members?.length !== preparingDm.members.size ||
      !channel.members.every((member) => preparingDm.members.has(member)),
  );
  const childrenByParent = useMemo(() => {
    const children = new Map<string, typeof channels>();
    for (const item of channels) {
      if (item.channelType !== "session" || !item.parentChannelId) continue;
      const siblings = children.get(item.parentChannelId) ?? [];
      siblings.push(item);
      children.set(item.parentChannelId, siblings);
    }
    for (const [parent, siblings] of children) {
      siblings.sort(
        (a, b) =>
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
      );
      const previous = childSessions.current.get(parent);
      if (
        previous?.length === siblings.length &&
        siblings.every((child, index) => child === previous[index])
      )
        children.set(parent, previous);
    }
    childSessions.current = children;
    return children;
  }, [channels]);
  const requestedChannel =
    navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined;
  const [resolved, setResolved] = useState<{
    request: PageNavigation;
    available: boolean;
  }>();
  const joinedRequest = channels.some(
    (channel) => channel.id === requestedChannel,
  );
  useEffect(() => {
    // Let initial membership discovery settle before resolving an omitted target.
    // A premature exact lookup publishes a one-channel list and starts readers
    // that the completing full roster then invalidates.
    if (
      !requestedChannel ||
      !navigation ||
      joinedRequest ||
      list.status === "idle" ||
      list.status === "loading" ||
      !queries.channels.resolve
    )
      return;
    const controller = new AbortController();
    void queries.channels
      .resolve([requestedChannel], {
        signal: AbortSignal.any([controller.signal, navigation.signal]),
        priority: "foreground",
      })
      .then(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted)
          setResolved({ request: navigation, available: true });
      })
      .catch(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted) {
          setResolved({ request: navigation, available: false });
          navigation.complete({ status: "failed", reason: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [requestedChannel, navigation, joinedRequest, queries, list.status]);
  const resolving =
    !!requestedChannel &&
    !joinedRequest &&
    !!queries.channels.resolve &&
    resolved?.request !== navigation;
  const current = requestedChannel
    ? (channels.find((channel) => channel.id === requestedChannel) ??
      (resolved?.request === navigation && resolved?.available
        ? queries.channels.get?.(requestedChannel)
        : undefined))
    : (channels.find((channel) => channel.id === selected) ??
      channels.find((item) => item.channelType !== "session"));
  const CurrentChannelIcon = channelIcon(current);
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (composingMessage) {
      navigation?.complete({ status: "opened" });
      return;
    }
    if (requestedChannel && !resolving && list.status === "ready" && !current)
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
  }, [
    composingMessage,
    requestedChannel,
    resolving,
    current,
    list.status,
    navigation,
    viewer,
    scope,
  ]);
  const requestedMessage =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const requestedThread =
    navigation?.target.kind === "conversation"
      ? navigation.target.threadRootId
      : undefined;
  const currentId = current?.id;
  const [settings, setSettings] = useState<{
    channelId: string | undefined;
    entryId: string | undefined;
  }>();
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const showingSettings =
    !!settings &&
    settings.channelId === currentId &&
    settings.entryId === navigation?.entryId;
  useEffect(() => {
    if (settings && !showingSettings) setSettings(undefined);
  }, [settings, showingSettings]);
  const closeSettings = () => {
    setSettings(undefined);
    settingsTrigger.current?.focus({ preventScroll: true });
  };
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
  const onComposerSend = useComposerSent(
    currentId,
    flatSession && !!requestedMessage,
    setSent,
    select,
  );
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
  else if (
    current &&
    !showingThread &&
    (!navigation || (requestedMessage && !exact))
  )
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
      setSettings(undefined);
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
  const createChannel = useCallback(
    async (input: CreateChannelInput) => {
      const id = await queries.channelCreation.create(input);
      if (!mounted.current) return;
      select(id);
      sidebar.toggle("channels", true);
    },
    [queries, select, sidebar.toggle],
  );
  useEffect(() => {
    if (opened && !panel) open(undefined);
  }, [opened, panel, open]);
  const [replyRequest, setReplyRequest] = useState<{
    channelId: string;
    messageId: string;
    entryId: string | undefined;
    sequence: number;
  }>();
  const activeEntryId = navigator?.snapshot().entry.id;
  useEffect(() => {
    if (
      replyRequest &&
      (replyRequest.channelId !== currentId ||
        replyRequest.entryId !== activeEntryId)
    )
      setReplyRequest(undefined);
  }, [currentId, activeEntryId, replyRequest]);
  const openThread = useCallback(
    (messageId: string, threadRootId: string, intent?: "reply") => {
      if (!currentId) return;
      const requestReply = () =>
        setReplyRequest((previous) =>
          intent === "reply"
            ? {
                channelId: currentId,
                messageId,
                entryId: navigator?.snapshot().entry.id,
                sequence: (previous?.sequence ?? 0) + 1,
              }
            : undefined,
        );
      setSettings(undefined);
      const target = navigator?.snapshot().entry.target;
      if (
        target?.kind === "conversation" &&
        target.channelId === currentId &&
        target.messageId === messageId &&
        target.threadRootId === threadRootId
      ) {
        requestReply();
        return;
      }
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
      requestReply();
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
      setSettings(undefined);
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
      setSettings(undefined);
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
    setReplyRequest(undefined);
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
        setSettings(undefined);
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
      current && !current.readOnly && viewer
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
  const drawer = useChannelPanels(panels, drawerContext, () =>
    setSettings(undefined),
  );
  const sections = sidebarSections(
    sidebarChannels,
    personal
      ? {
          sections: personal.groups.map((g, order) => ({
            id: g.id,
            name: g.name,
            order,
          })),
          assignments: personal.assignments,
          starred: preferences.data?.starred ?? [],
        }
      : preferences.data,
    hiddenDms.hiddenIds,
  );
  return (
    <div
      className={`${styles.board} ${!composingMessage && (showingSettings || panel || showingThread || companion) ? styles.withPanel : ""}`}
      style={
        {
          "--channel-sidebar-width": `${sidebar.width}px`,
        } as CSSProperties
      }
    >
      <Panel as="aside" aria-label="Channel sidebar">
        <div className={styles.sidebar}>
          {kitState.status === "error" && (
            <p role="alert">
              {kitState.error}{" "}
              <Button onClick={() => void queries.channelKit.refresh()}>
                Retry templates
              </Button>
            </p>
          )}
          {kitError && <p role="alert">{kitError}</p>}
          {pendingChannelCreation && (
            <div>
              <Button size="sm" onClick={() => setCreateChannelOpen(true)}>
                Resume unfinished channel setup
              </Button>
              {queries.channelCreation.partialChannel() && (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      const id = queries.channelCreation.partialChannel();
                      if (id) select(id);
                    }}
                  >
                    Open partial channel
                  </Button>
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (
                        window.confirm(
                          "Keep this channel without finishing setup? Existing members and Canvas stay; pending outbox writes are not cancelled.",
                        )
                      ) {
                        try {
                          const id =
                            await queries.channelCreation.keepPartial();
                          if (id) select(id);
                        } catch (error) {
                          setKitError(String(error));
                        }
                      }
                    }}
                  >
                    Keep partial channel
                  </Button>
                </>
              )}
            </div>
          )}
          <SidebarUnread listRef={sidebar.list}>
            {sections.map((section) => {
              const showsCreateChannel = isChannelSectionKey(section.key);
              return (
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
                      <SidebarSectionIcon
                        icon={section.icon}
                        session={queries}
                      />
                    )}
                    <span className={styles.sectionTitle}>{section.title}</span>
                    {showsCreateChannel && (
                      <span className={styles.sectionAction}>
                        <IconButton
                          type="button"
                          size="compact"
                          shape="round"
                          aria-label="Create channel"
                          title={
                            queries.channelCreation.available
                              ? "Create channel"
                              : "Channel creation unavailable"
                          }
                          disabled={!queries.channelCreation.available}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            createChannelTrigger.current = event.currentTarget;
                            setInitialGroup(
                              personal && section.key.startsWith("group:")
                                ? section.key.slice(6)
                                : "",
                            );
                            setCreateChannelOpen(true);
                          }}
                          icon={<PlusIcon size={16} aria-hidden="true" />}
                        />
                      </span>
                    )}
                    {section.key === "dms" && (
                      <span className={styles.sectionAction}>
                        <IconButton
                          type="button"
                          size="compact"
                          shape="round"
                          aria-label="New message"
                          title="New message"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setThread(undefined);
                            open(undefined);
                            setDraftParent(undefined);
                            setLocalNewMessage(true);
                            if (navigator && viewer)
                              void navigator.open({
                                version: 1,
                                kind: "page",
                                pluginId: "buzz.channels",
                                pageId: "channels",
                                scope: {
                                  viewer,
                                  communityOrigin: scope.slice(
                                    0,
                                    -(viewer.length + 1),
                                  ),
                                },
                                route: { version: 1, params: "new-message" },
                              });
                          }}
                          icon={<PlusIcon size={16} aria-hidden="true" />}
                        />
                      </span>
                    )}
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
                        profile={
                          channel.channelType === "dm" &&
                          channel.participants?.length === 1
                            ? dmProfiles.get(channel.participants[0] ?? "")
                            : undefined
                        }
                        key={channel.id}
                        channel={channel}
                        session={queries}
                        working={workingChannels.has(channel.id)}
                        sessionsEnabled={sessionsEnabled}
                        selected={composingMessage ? undefined : selected}
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
                        onHideDm={hiddenDms.hide}
                      />
                    );
                  })}
                </details>
              );
            })}
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
          {preferences.status === "error" ? (
            <ToastNotice
              title="Saved groups and stars couldn’t refresh"
              description="Your conversations are still available."
              tone="warning"
            >
              <Button type="button" size="sm" onClick={preferences.reload}>
                Retry
              </Button>
            </ToastNotice>
          ) : preferences.status !== "ready" ? (
            <p className={styles.preferenceNotice} role="status">
              {preferences.status === "loading"
                ? "Loading saved groups and stars…"
                : "Saved groups and stars aren’t supported by this host yet."}
            </p>
          ) : null}
        </div>
      </Panel>
      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
        onCreate={createChannel}
        pending={pendingChannelCreation}
        finalFocus={createChannelTrigger}
        session={queries}
        providers={providers}
        groups={personal}
        initialGroup={initialGroup}
        groupsReady={kitState.status === "ready"}
      />
      {current && !current.readOnly && canvasOpen && (
        <ChannelCanvasDialog
          key={`${scope}:${current.id}`}
          canvas={queries.canvas}
          scope={scope}
          channelId={current.id}
          open={canvasOpen}
          onOpenChange={setCanvasOpen}
        />
      )}
      <ChannelSidebarResizeHandle
        width={sidebar.width}
        setWidth={sidebar.setWidth}
      />
      <Panel as="article" aria-label="Conversation">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: file-drop fallback; the composer also provides a keyboard-accessible picker. */}
        <div
          className={styles.conversation}
          data-attachment-drop-zone=""
          onDragOver={rejectUnhandledFileDrop}
          onDrop={rejectUnhandledFileDrop}
        >
          {composingMessage ? (
            <NewMessage
              session={queries}
              scope={scope}
              extensions={extensions}
              onPreparing={(pubkeys) =>
                setPreparingDm((previous) => ({
                  existing:
                    previous?.existing ??
                    new Set(
                      queries.channels
                        .list()
                        .channels.map((channel) => channel.id),
                    ),
                  members: new Set([viewer, ...pubkeys]),
                }))
              }
              onStarted={(channelId, id) => {
                setPreparingDm(undefined);
                setSent({ channelId, id });
                select(channelId);
              }}
            />
          ) : drafting && current ? (
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
                      <CurrentChannelIcon size={20} />
                    )
                  }
                  actions={
                    <>
                      {drawer.launchers}
                      <IconButton
                        ref={settingsTrigger}
                        size="toolbar"
                        aria-label="Channel settings"
                        title="Channel settings"
                        aria-expanded={showingSettings}
                        onClick={() => {
                          if (showingSettings) closeSettings();
                          else {
                            drawer.close();
                            setSettings({
                              channelId: currentId,
                              entryId: navigation?.entryId,
                            });
                          }
                        }}
                        icon={<DotsThreeIcon size={19} aria-hidden="true" />}
                      />
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
                    {resolving
                      ? "Checking conversation access…"
                      : "Select a channel to read it."}
                  </div>
                )}
                {current?.readOnly && (
                  <p className="px-4 py-2 text-body-sm text-subtle">
                    Read-only preview · You haven’t joined this conversation.
                  </p>
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
                    onSend={onComposerSend}
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
      {!showingMediaReview &&
        (showingSettings || panel || showingThread || companion) && (
          <div className={styles.panelStack}>
            {showingSettings && (
              <ChannelSettingsPanel
                setupTools={
                  current && (
                    <div style={{ display: "grid", gap: "var(--space-3)" }}>
                      {!current.readOnly && (
                        <Button onClick={() => setCanvasOpen(true)}>
                          Canvas
                        </Button>
                      )}
                      {templateProvider && (
                        <OwnedContribution
                          key={current.id}
                          entry={templateProvider}
                          registry={providers}
                        >
                          {(entry, active) => {
                            const SaveAs = entry.saveAs;
                            return (
                              <SaveAs
                                session={queries}
                                channel={current}
                                active={active}
                              />
                            );
                          }}
                        </OwnedContribution>
                      )}
                      {personal && (
                        <Select
                          label="Personal group"
                          variant="field"
                          value={personal.assignments[current.id] ?? ""}
                          groups={[
                            {
                              label: "",
                              options: [
                                { value: "", label: "No group" },
                                ...personal.groups.map((g) => ({
                                  value: g.id,
                                  label: g.name,
                                })),
                              ],
                            },
                          ]}
                          onValueChange={async (groupId) => {
                            const assignments = { ...personal.assignments };
                            if (groupId) assignments[current.id] = groupId;
                            else delete assignments[current.id];
                            setKitError("");
                            try {
                              await queries.channelKit.save(
                                { ...personal, assignments },
                                groupEntry?.eventId,
                              );
                            } catch (error) {
                              setKitError(String(error));
                            }
                          }}
                        />
                      )}
                      {kitError && <p role="alert">{kitError}</p>}
                    </div>
                  )
                }
                key={currentId ?? "channels"}
                channel={current}
                close={closeSettings}
              >
                <UnreadOptions session={queries} channelId={current?.id} />
                <LiveStatus
                  live={queries.live}
                  channelId={current?.id}
                  partialRoster={list.coverage === "partial"}
                  diagnostics
                />
                <p>
                  {list.coverage === "partial" ? "Partial roster" : "Roster"} ·{" "}
                  {channels.length} channels
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
                    onClick={() => queries.channels.refresh?.(current.id)}
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
              </ChannelSettingsPanel>
            )}
            {showingThread && (
              <div className={styles.retainedPanel} hidden={showingSettings}>
                <ThreadPanel
                  sessionConversation={current?.channelType === "session"}
                  extensions={extensions}
                  session={queries}
                  scope={scope}
                  channelName={current?.name ?? ""}
                  channelId={showingThread.channelId}
                  messageId={showingThread.messageId}
                  navigation={showingThread.navigation}
                  replyRequest={
                    replyRequest?.channelId === showingThread.channelId &&
                    replyRequest.messageId === showingThread.messageId &&
                    replyRequest.entryId === showingThread.navigation?.entryId
                      ? replyRequest.sequence
                      : undefined
                  }
                  close={closeThread}
                  onOpenLink={openLink}
                  onOpenMediaReview={openMediaReview}
                  canOpenLink={canOpenLink}
                />
              </div>
            )}

            {panel && opened && (
              <div className={styles.retainedPanel} hidden={showingSettings}>
                <PanelCard
                  key="target"
                  panel={panel}
                  target={opened.target}
                  context={panelContext}
                  close={close}
                  closeLabel="Close channel panel"
                />
              </div>
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
        const sidebar = event.currentTarget.previousElementSibling;
        const currentWidth =
          sidebar instanceof HTMLElement
            ? sidebar.getBoundingClientRect().width
            : renderedWidth;
        if (event.key === "ArrowLeft") setWidth(currentWidth - step);
        else if (event.key === "ArrowRight") setWidth(currentWidth + step);
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
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
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
