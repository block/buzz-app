import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChannelLifecycleDialog } from "../../bundled/channels/ChannelLifecycleDialog";
import { ChannelLifecycleMenu } from "../../bundled/channels/ChannelLifecycleMenu";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import { personalGroups } from "../channel-templates/setup";
import type { TemplateProviders } from "../channel-templates/provider";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { useChannelList, useRelayConnection } from "../relay/react";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { Panel } from "../../shared/design-system/ui/Panel";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuItem,
  MenuIcon,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../relay/contracts";
import { useChannelRowMenu } from "../../bundled/channels/useChannelRowMenu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  BellIcon,
  BellSlashIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { ChannelReadMenuItem } from "../../bundled/channels/ChannelReadMenuItem";
import { useOptimisticMute } from "../../bundled/channels/useOptimisticMute";
import { ChannelSidebarItem } from "../../bundled/channels/ChannelSidebarItem";
import { SidebarUnread } from "../../bundled/channels/SidebarUnread";
import { SidebarSection } from "../../bundled/channels/SidebarSection";
import { useChannelLabels } from "../../bundled/channels/useChannelLabels";
import { useHiddenDms } from "../../bundled/channels/useHiddenDms";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import { useSidebarStartup } from "../../bundled/channels/useSidebarStartup";
import { useSidebarView } from "../../bundled/channels/useSidebarView";
import {
  sidebarSections,
  isChannelSectionKey,
} from "../../bundled/channels/sidebar-sections";
import {
  CreateChannelDialog,
  type CreateChannelInput,
} from "../../bundled/channels/CreateChannelDialog";
import { writeView } from "../../shared/view-state";
import { useChannelNavigation } from "./ChannelNavigationState";
import { channelPlaceholder, newSessionParent } from "./routes";
import { ChannelSidebarResizeHandle } from "./ChannelSidebarResizeHandle";
import styles from "../../bundled/channels/Channels.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  providers: TemplateProviders;
  target: OpenTarget;
  sessionsEnabled: boolean;
  agentsEnabled: boolean;
};
export function ChannelSidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const navigation = (
    <SidebarNavigation
      agentsEnabled={props.agentsEnabled}
      navigator={props.navigator}
      scope={connection.scope ?? "disconnected"}
      target={props.target}
      viewer={connection.viewer}
    />
  );
  return (
    <SidebarBoundary
      key={`${connection.scope}:${connection.generation}`}
      fallback={navigation}
    >
      {connection.status === "ready" ? (
        <ReadySidebar
          {...props}
          key={`${connection.scope}:${connection.generation}`}
          queries={connection.session}
          scope={connection.scope ?? "disconnected"}
          viewer={connection.viewer}
        />
      ) : (
        <div className="shell-sidebar-default">
          <Panel as="aside" aria-label="Channel sidebar">
            <div className={styles.sidebar}>
              {navigation}
              <p className={styles.empty}>
                {connection.status === "connecting"
                  ? "Connecting to your relay…"
                  : (connection.error ?? "Choose a community to see channels.")}
              </p>
              {connection.status === "error" && (
                <Button onClick={props.relay.retry}>Retry channels</Button>
              )}
            </div>
          </Panel>
        </div>
      )}
    </SidebarBoundary>
  );
}

type SidebarNavigationProps = Pick<
  Props,
  "agentsEnabled" | "navigator" | "target"
> & {
  scope: string;
  viewer?: string | undefined;
};

function SidebarNavigation({
  agentsEnabled,
  navigator,
  scope,
  target,
  viewer,
}: SidebarNavigationProps) {
  const placeholder =
    target.kind === "page" && target.pluginId === "buzz.channels"
      ? channelPlaceholder(target.route?.params)
      : undefined;
  const communityOrigin = viewer
    ? scope.slice(0, -(viewer.length + 1))
    : undefined;
  const openChannelDestination = (destination: "Inbox" | "Bestie") => {
    if (!viewer || communityOrigin === undefined) return;
    void navigator.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      scope: { viewer, communityOrigin },
      route: { version: 1, params: destination },
    });
  };
  const destinations = [
    {
      title: "Inbox",
      icon: <BellIcon weight="bold" size={15} />,
      selected: placeholder === "Inbox",
      open: () => openChannelDestination("Inbox"),
    },
    {
      title: "Bestie",
      icon: <img src="/bestie.png" alt="" width={17} height={17} />,
      selected: placeholder === "Bestie",
      open: () => openChannelDestination("Bestie"),
    },
    ...(agentsEnabled
      ? [
          {
            title: "Agents",
            icon: <RobotIcon weight="bold" size={15} />,
            selected:
              target.kind === "page" && target.pluginId === "buzz.agents",
            open: () =>
              void navigator.open({
                version: 1,
                kind: "page",
                pluginId: "buzz.agents",
                pageId: "agents",
                scope:
                  viewer && communityOrigin !== undefined
                    ? { viewer, communityOrigin }
                    : null,
              }),
          },
        ]
      : []),
  ];
  return (
    <>
      <div className={styles.sidebarBrand}>
        <span
          className={styles.sidebarBrandMark}
          role="img"
          aria-label="Buzz"
        />
      </div>
      <div className={styles.destinations}>
        {destinations.map(({ title, icon, selected, open }) => (
          <NavigationItem
            key={title}
            label={title}
            selected={selected}
            icon={<span className={styles.sidebarIcon}>{icon}</span>}
            onClick={open}
          />
        ))}
      </div>
    </>
  );
}
class SidebarBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="shell-sidebar-default">
        <Panel as="aside" aria-label="Channel sidebar">
          <div className={styles.sidebar}>
            {this.props.fallback}
            <p role="alert">Channels couldn’t open.</p>
            <Button onClick={() => this.setState({ failed: false })}>
              Retry channels
            </Button>
          </div>
        </Panel>
      </div>
    ) : (
      this.props.children
    );
  }
}
function ReadySidebar({
  relay,
  navigator,
  providers,
  target,
  sessionsEnabled,
  agentsEnabled,
  queries,
  scope,
  viewer,
}: Props & {
  queries: RelaySession;
  scope: string;
  viewer?: string | undefined;
}) {
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  const startup = useSidebarStartup(queries, list, preferences);
  const [activityErrorDismissed, setActivityErrorDismissed] = useState(false);
  useEffect(() => {
    if (list.activityStatus !== "error") setActivityErrorDismissed(false);
  }, [list.activityStatus]);
  const mute = useOptimisticMute(queries.sidebarPreferences.setMute);
  const rowMenuGeneration = useRef(0);
  const [readWrite, setReadWrite] = useState<{
    pending: boolean;
    error?: string;
  }>();
  const [rowFocus, setRowFocus] = useState<string>();
  const kitState = useSyncExternalStore(
    queries.channelKit.subscribe,
    queries.channelKit.snapshot,
  );
  const personal = personalGroups(kitState.entries)?.record.value;
  const groups = personal?.type === "groups" ? personal : undefined;
  const hiddenDms = useHiddenDms(scope, queries, list);
  const lifecycle = queries.channelLifecycle;
  const dmVisibility = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.snapshot,
    lifecycle.snapshot,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed roster refresh also refreshes per-viewer visibility.
  useEffect(() => {
    if (list.status === "ready") void lifecycle.refreshVisibility();
  }, [lifecycle, list.asOf, list.status]);
  const [lifecycleDialog, setLifecycleDialog] = useState<{
    channel: ChannelSummary;
    action: ChannelLifecycleAction;
  }>();
  const lifecycleFocus = useRef<string | undefined>(undefined);
  const sidebar = useSidebarView(
    scope,
    startup.ready &&
      list.status === "ready" &&
      preferences.status !== "loading",
  );
  const { channels, profiles: dmProfiles } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const workingIds = useSyncExternalStore(
    queries.agentActivity.subscribeWorking,
    queries.agentActivity.workingSnapshot,
    queries.agentActivity.workingSnapshot,
  );
  const workingChannels = useMemo(
    () => new Set<string>(JSON.parse(workingIds)),
    [workingIds],
  );
  const handoff = useChannelNavigation();
  const draftParents = handoff?.draftParents ?? [];
  const draftParent =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    sessionsEnabled
      ? newSessionParent(target.route?.params)
      : undefined;
  const composingMessage =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    target.route?.params === "new-message";
  const preparingDm = composingMessage ? handoff?.preparingDm : undefined;
  const sidebarChannels = channels.filter(
    (channel) =>
      !preparingDm ||
      preparingDm.existing.has(channel.id) ||
      channel.channelType !== "dm" ||
      channel.members?.length !== preparingDm.members.size ||
      !channel.members.every((member) => preparingDm.members.has(member)),
  );
  const current = channels.find(
    (channel) =>
      channel.id ===
      (target.kind === "conversation" ? target.channelId : draftParent),
  );
  const childSessions = useRef(new Map<string, typeof channels>());
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

  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const createChannelTrigger = useRef<HTMLButtonElement>(null);
  const startingSession = useRef(false);
  const removedDmFocus = useRef<
    { channelId: string; target: HTMLElement } | undefined
  >(undefined);
  const [initialGroup, setInitialGroup] = useState("");
  const [kitError, setKitError] = useState("");
  const pendingChannelCreation = useSyncExternalStore(
    queries.channelCreation.subscribe,
    queries.channelCreation.snapshot,
    queries.channelCreation.snapshot,
  );
  useEffect(() => {
    if (list.status === "ready") {
      queries.channelKit.ensure();
      void queries.unread.ensure();
    }
  }, [queries, list.status]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
  ) => {
    // Let the existing context menu restore focus before opening confirmation.
    requestAnimationFrame(() => {
      if (mounted.current) setLifecycleDialog({ channel, action });
    });
  };
  useLayoutEffect(() => {
    if (!lifecycleFocus.current || lifecycleDialog) return;
    const id = lifecycleFocus.current;
    lifecycleFocus.current = undefined;
    const rows = [
      ...(sidebar.list.current?.querySelectorAll<HTMLButtonElement>(
        "[data-channel-id]",
      ) ?? []),
    ];
    const row =
      rows.find(
        (row) => row.dataset.channelId === id && row.getClientRects().length,
      ) ?? rows.find((row) => row.getClientRects().length);
    (
      row ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
  }, [lifecycleDialog, sidebar.list]);
  const select = useCallback(
    (id: string) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      writeView(scope, "selected-channel", id);
      void navigator.open({
        version: 1,
        kind: "conversation",
        channelId: id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    },
    [navigator, relay, queries, scope, viewer],
  );
  const startSession = useCallback(
    (parentId: string) => {
      const parent = channels.find((channel) => channel.id === parentId);
      if (
        !viewer ||
        relay.snapshot().session !== queries ||
        !sessionsEnabled ||
        !parent ||
        parent.readOnly ||
        parent.archived ||
        parent.channelType === "dm" ||
        parent.channelType === "session"
      )
        return;
      handoff?.updateDraftParents((previous) =>
        previous.includes(parentId) ? previous : [...previous, parentId],
      );
      sidebar.toggle(`session-children:${parentId}`, true);
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        route: { version: 1, params: { kind: "new-session", parentId } },
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    },
    [
      channels,
      viewer,
      relay,
      queries,
      sessionsEnabled,
      handoff,
      sidebar.toggle,
      navigator,
      scope,
    ],
  );
  const openActivityThread = useCallback(
    (channelId: string, rootId: string) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      if (handoff)
        handoff.activityThread.current = {
          channelId,
          rootId,
          trigger:
            sidebar.list.current?.querySelector<HTMLElement>(
              `[data-channel-id="${CSS.escape(channelId)}"]`,
            ) ?? null,
        };
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
    },
    [viewer, relay, queries, handoff, sidebar.list, navigator, scope],
  );
  const createChannel = async (input: CreateChannelInput) => {
    const id = await queries.channelCreation.create(input);
    if (!mounted.current || relay.snapshot().session !== queries) return;
    select(id);
    sidebar.toggle("channels", true);
  };
  const displayedPreferences = groups
    ? {
        ...preferences.data,
        sections: groups.groups.map((group, order) => ({
          id: group.id,
          name: group.name,
          order,
        })),
        assignments: groups.assignments,
        starred: preferences.data?.starred ?? [],
        muted: preferences.data?.muted ?? [],
      }
    : preferences.data;
  const sections = startup.ready
    ? sidebarSections(
        sidebarChannels,
        displayedPreferences,
        new Set([...hiddenDms.hiddenIds, ...dmVisibility.hidden]),
      )
    : [];
  const setSectionSort = (key: string, mode: "alpha" | "recent") => {
    void preferences
      .setSort(
        key.startsWith("group:") ? `section:${key.slice(6)}` : key,
        mode,
        displayedPreferences?.sections.map((section) => section.id) ?? [],
      )
      .catch(() => {});
  };
  // Compose actual items here; menu availability is their count, not the policy
  // of any one action. Sibling actions keep their own eligibility checks.
  const rowActions = (channel: ChannelSummary) => {
    const actions: ReactNode[] = [];
    if (
      sessionsEnabled &&
      channel.channelType !== "dm" &&
      channel.channelType !== "session" &&
      !channel.archived
    ) {
      actions.push(
        <MenuItem
          key="new-session"
          onClick={() => {
            startingSession.current = true;
            startSession(channel.id);
          }}
        >
          New session
        </MenuItem>,
      );
    }
    const muteable =
      queries.sidebarPreferences.muteWritable && !!preferences.data;
    const readable = queries.unread.sync().capability === "frontier-sync";
    if (actions.length && (muteable || readable))
      actions.push(<MenuSeparator key="attention-separator" />);
    if (muteable) {
      const intent = mute.intents.get(channel.id);
      const muted = intent?.pending
        ? intent.muted
        : (preferences.data?.muted.includes(channel.id) ?? false);
      actions.push(
        <MenuItem
          key="mute"
          closeOnClick={false}
          disabled={readWrite?.pending ?? false}
          onClick={() => changeMute(channel.id, channel.name, !muted)}
        >
          <MenuIcon>
            {muted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
          </MenuIcon>
          {muted ? "Unmute" : "Mute"}
        </MenuItem>,
      );
    }
    if (readable)
      actions.push(
        <ChannelReadMenuItem
          key="read"
          unread={queries.unread}
          channelId={channel.id}
          pending={readWrite?.pending ?? false}
          run={(action) => runReadAction(channel.id, action)}
        />,
      );
    if (channel.channelType !== "session" && !channel.archived) {
      actions.push(
        <ChannelLifecycleMenu
          key="lifecycle"
          separator={actions.length > 0}
          channelId={channel.id}
          lifecycle={lifecycle}
          disabled={!!lifecycleDialog}
          choose={(action) => chooseLifecycle(channel, action)}
        />,
      );
    }
    if (channel.channelType === "dm") {
      actions.push(
        <MenuItem
          key="remove-message"
          onClick={() => {
            const trigger = sidebar.list.current?.querySelector<HTMLElement>(
              `[data-channel-id="${CSS.escape(channel.id)}"]`,
            );
            const section = trigger?.closest("[data-sidebar-section]");
            const rows = [
              ...(section?.querySelectorAll<HTMLElement>(
                "button[data-channel-id]",
              ) ?? []),
            ];
            const index = rows.indexOf(trigger as HTMLButtonElement);
            const survivingSummary = [
              ...(sidebar.list.current?.querySelectorAll<HTMLElement>(
                "[data-sidebar-section] details > summary",
              ) ?? []),
            ].find((summary) => !section?.contains(summary));
            const target =
              rows[index + 1] ?? rows[index - 1] ?? survivingSummary;
            removedDmFocus.current = target
              ? { channelId: channel.id, target }
              : undefined;
            hiddenDms.hide(channel.id);
          }}
        >
          Remove from Messages
        </MenuItem>,
      );
    }
    return actions;
  };
  const {
    rowMenu,
    open: openMenu,
    close: closeMenu,
  } = useChannelRowMenu(sections, rowActions);
  const openRowMenu = useCallback(
    (channel: ChannelSummary, sectionKey: string, anchor?: HTMLElement) => {
      startingSession.current = false;
      rowMenuGeneration.current++;
      setReadWrite(undefined);
      removedDmFocus.current = undefined;
      openMenu(channel, sectionKey, anchor);
    },
    [openMenu],
  );
  const closeRowMenu = useCallback(() => {
    rowMenuGeneration.current++;
    setReadWrite(undefined);
    closeMenu();
  }, [closeMenu]);
  const rowMenuFinalFocus = useCallback(
    (channelId: string) =>
      removedDmFocus.current?.channelId === channelId
        ? removedDmFocus.current.target
        : startingSession.current
          ? (document
              .getElementById("new-session-prompt")
              ?.querySelector<HTMLElement>('[role="textbox"]') ?? false)
          : (sidebar.list.current?.querySelector<HTMLButtonElement>(
              `[data-channel-id="${CSS.escape(channelId)}"]`,
            ) ?? false),
    [sidebar.list],
  );
  useLayoutEffect(() => {
    if (!rowFocus) return;
    sidebar.list.current
      ?.querySelector<HTMLButtonElement>(
        `[data-channel-id="${CSS.escape(rowFocus)}"]`,
      )
      ?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus, sidebar.list]);
  const runReadAction = async (
    channelId: string,
    action: () => Promise<unknown>,
  ) => {
    const generation = rowMenuGeneration.current;
    setReadWrite({ pending: true });
    try {
      await action();
      if (!mounted.current || generation !== rowMenuGeneration.current) return;
      // Startup can move the row; resolve its current owner after the commit.
      setRowFocus(channelId);
      closeRowMenu();
    } catch (error) {
      if (!mounted.current || generation !== rowMenuGeneration.current) return;
      setReadWrite({
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const changeMute = (channelId: string, name: string, muted: boolean) => {
    mute.change(channelId, name, muted);
    setRowFocus(channelId);
    closeRowMenu();
  };
  return (
    <>
      {lifecycleDialog && (
        <ChannelLifecycleDialog
          channelId={lifecycleDialog.channel.id}
          channelName={lifecycleDialog.channel.name}
          action={lifecycleDialog.action}
          lifecycle={lifecycle}
          close={() => {
            lifecycleFocus.current = lifecycleDialog.channel.id;
            setLifecycleDialog(undefined);
          }}
          completed={() => {
            const id = lifecycleDialog.channel.id;
            lifecycleFocus.current = id;
            setLifecycleDialog(undefined);
            if (current?.id === id) {
              const next = sections
                .flatMap((section) => section.rows)
                .find((channel) => channel.id !== id);
              if (next) select(next.id);
              else {
                writeView(scope, "selected-channel", undefined);
                void navigator.open({
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.channels",
                  pageId: "channels",
                  route: { version: 1, params: "empty" },
                });
              }
            }
          }}
        />
      )}
      <div className="shell-sidebar" style={{ width: sidebar.width }}>
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
            {dmVisibility.status === "error" && (
              <div role="alert">
                Hidden conversations could not be refreshed.{" "}
                <Button onClick={() => void lifecycle.refreshVisibility()}>
                  Retry hidden conversations
                </Button>
              </div>
            )}
            <SidebarUnread listRef={sidebar.list}>
              <SidebarNavigation
                agentsEnabled={agentsEnabled}
                navigator={navigator}
                scope={scope}
                target={target}
                viewer={viewer}
              />
              {sections.map((section) => (
                <SidebarSection
                  key={section.key}
                  sectionKey={section.key}
                  title={section.title}
                  icon={section.icon}
                  session={queries}
                  open={!sidebar.collapsed.includes(section.key)}
                  onToggle={(open) => sidebar.toggle(section.key, open)}
                  createChannel={
                    isChannelSectionKey(section.key)
                      ? {
                          available: queries.channelCreation.available,
                          open: (trigger) => {
                            createChannelTrigger.current = trigger;
                            setInitialGroup(
                              groups && section.key.startsWith("group:")
                                ? section.key.slice(6)
                                : "",
                            );
                            setCreateChannelOpen(true);
                          },
                        }
                      : undefined
                  }
                  newMessage={
                    section.key === "dms"
                      ? () => {
                          if (viewer && relay.snapshot().session === queries)
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
                        }
                      : undefined
                  }
                  sort={
                    preferences.sortWritable
                      ? {
                          value:
                            preferences.data?.sort?.[
                              section.key.startsWith("group:")
                                ? `section:${section.key.slice(6)}`
                                : section.key
                            ] ?? "alpha",
                          change: (mode) => setSectionSort(section.key, mode),
                        }
                      : undefined
                  }
                >
                  {section.rows.map((channel) => {
                    const sessions = childrenByParent.get(channel.id);
                    const selected =
                      current?.id === channel.id ||
                      sessions?.some((child) => child.id === current?.id)
                        ? current?.id
                        : undefined;
                    const actions = rowActions(channel);
                    const menuEnabled = actions.length > 0;
                    const menuOpen =
                      menuEnabled &&
                      rowMenu?.channelId === channel.id &&
                      rowMenu.sectionKey === section.key;
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
                        selected={composingMessage ? undefined : selected}
                        collapsed={sidebar.collapsed.includes(
                          `session-children:${channel.id}`,
                        )}
                        onToggle={sidebar.toggle}
                        draft={draftParents.includes(channel.id)}
                        draftSelected={draftParent === channel.id}
                        sessions={sessions}
                        onSelect={select}
                        onNewSession={startSession}
                        onOpenThread={openActivityThread}
                        menuEnabled={menuEnabled}
                        sectionKey={section.key}
                        onOpenMenu={openRowMenu}
                        menuOpen={menuOpen}
                        menuAnchor={menuOpen ? rowMenu.anchor : undefined}
                        menuContent={
                          menuOpen ? (
                            <>
                              {actions}
                              {readWrite?.pending && (
                                <p role="status">Saving…</p>
                              )}
                              {readWrite?.error && (
                                <p role="alert">{readWrite.error}</p>
                              )}
                            </>
                          ) : undefined
                        }
                        onCloseMenu={closeRowMenu}
                        menuFinalFocus={rowMenuFinalFocus}
                      />
                    );
                  })}
                </SidebarSection>
              ))}
              {list.status === "loading" && !list.channels.length && (
                <p className={styles.empty}>Loading your channels…</p>
              )}
              {list.status === "error" && (
                <p role="alert" className={styles.empty}>
                  {list.error}
                </p>
              )}
              {!startup.ready && (
                <p className={styles.empty} role="status">
                  Loading your sidebar…
                </p>
              )}
              {startup.ready && list.status === "ready" && !channels.length && (
                <p className={styles.empty}>No channels yet.</p>
              )}
            </SidebarUnread>
            {startup.updating && (
              <p className={styles.preferenceNotice} role="status">
                Updating sidebar details…
              </p>
            )}
            {preferences.sortErrors?.map(({ group, mode, error }) => (
              <div key={group} className={styles.preferenceNotice} role="alert">
                <p>
                  Couldn’t save the sort order for{" "}
                  {sections.find(
                    ({ key }) =>
                      key ===
                      (group.startsWith("section:")
                        ? `group:${group.slice(8)}`
                        : group),
                  )?.title ?? "this section"}
                  . {error}
                </p>
                <button
                  type="button"
                  onClick={() => setSectionSort(group, mode)}
                >
                  Retry sort
                </button>
                <button
                  type="button"
                  onClick={() => preferences.dismissSortError(group)}
                >
                  Dismiss
                </button>
              </div>
            ))}
            {[...mute.intents.values()]
              .filter((intent) => !intent.pending)
              .map((intent) => (
                <ToastNotice
                  key={intent.channelId}
                  title={`Couldn’t ${intent.muted ? "mute" : "unmute"} ${intent.name}`}
                  description={intent.error ?? "Please try again."}
                  tone="warning"
                >
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      changeMute(intent.channelId, intent.name, intent.muted)
                    }
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      mute.dismiss(intent.channelId);
                      setRowFocus(intent.channelId);
                    }}
                  >
                    Dismiss
                  </Button>
                </ToastNotice>
              ))}
            {startup.ready && preferences.status === "error" ? (
              <ToastNotice
                title="Saved sidebar preferences couldn’t refresh"
                description="Your conversations are still available."
                tone="warning"
              >
                <Button type="button" size="sm" onClick={preferences.reload}>
                  Retry
                </Button>
              </ToastNotice>
            ) : startup.ready && preferences.status === "unsupported" ? (
              <p className={styles.preferenceNotice} role="status">
                Saved groups and stars aren’t supported by this host yet.
              </p>
            ) : null}
            {list.activityStatus === "error" && !activityErrorDismissed && (
              <ToastNotice
                title="Couldn’t refresh recent activity"
                description="Sections sorted by Recent may be out of date."
                tone="warning"
                onDismiss={() => setActivityErrorDismissed(true)}
              >
                <Button
                  type="button"
                  size="sm"
                  onClick={() => queries.channels.refreshList?.()}
                >
                  Retry
                </Button>
              </ToastNotice>
            )}
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
          groups={groups}
          initialGroup={initialGroup}
          groupsReady={kitState.status === "ready"}
        />
      </div>
      <ChannelSidebarResizeHandle
        width={sidebar.width}
        setWidth={sidebar.setWidth}
      />
    </>
  );
}
