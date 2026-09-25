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
import { Button } from "../../shared/design-system/ui/Button";
import {
  ContextMenuRoot,
  MenuItem,
  MenuIcon,
  MenuPopup,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../relay/contracts";
import { useChannelRowMenu } from "../../bundled/channels/useChannelRowMenu";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  BellIcon,
  BellSlashIcon,
  CaretRightIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { ChannelReadMenuItem } from "../../bundled/channels/ChannelReadMenuItem";
import { useOptimisticMute } from "../../bundled/channels/useOptimisticMute";
import { ChannelSidebarItem } from "../../bundled/channels/ChannelSidebarItem";
import { SidebarUnread } from "../../bundled/channels/SidebarUnread";
import { SidebarSectionIcon } from "../../bundled/channels/SidebarSectionIcon";
import { useChannelLabels } from "../../bundled/channels/useChannelLabels";
import { useHiddenDms } from "../../bundled/channels/useHiddenDms";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
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
import { newSessionParent } from "./routes";
import { ChannelSidebarResizeHandle } from "./ChannelSidebarResizeHandle";
import styles from "../../bundled/channels/Channels.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  providers: TemplateProviders;
  target: OpenTarget;
  sessionsEnabled: boolean;
  children: ReactNode;
};
export function ChannelSidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  return (
    <SidebarBoundary
      key={`${connection.scope}:${connection.generation}`}
      fallback={props.children}
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
              {props.children}
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
  children,
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
    list.status === "ready" && preferences.status !== "loading",
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
  const startSession = (parentId: string) => {
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
      scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
    });
  };
  const openActivityThread = (channelId: string, rootId: string) => {
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
      scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
    });
  };
  const createChannel = async (input: CreateChannelInput) => {
    const id = await queries.channelCreation.create(input);
    if (!mounted.current || relay.snapshot().session !== queries) return;
    select(id);
    sidebar.toggle("channels", true);
  };
  const sections = sidebarSections(
    sidebarChannels,
    groups
      ? {
          sections: groups.groups.map((group, order) => ({
            id: group.id,
            name: group.name,
            order,
          })),
          assignments: groups.assignments,
          starred: preferences.data?.starred ?? [],
          muted: preferences.data?.muted ?? [],
        }
      : preferences.data,
    new Set([...hiddenDms.hiddenIds, ...dmVisibility.hidden]),
  );
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
      openMenu(channel, sectionKey, anchor);
    },
    [openMenu],
  );
  const closeRowMenu = useCallback(() => {
    rowMenuGeneration.current++;
    setReadWrite(undefined);
    closeMenu();
  }, [closeMenu]);
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
            {children}
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
                      <span className={styles.sectionTitle}>
                        {section.title}
                      </span>
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
                              createChannelTrigger.current =
                                event.currentTarget;
                              setInitialGroup(
                                groups && section.key.startsWith("group:")
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

                              if (
                                viewer &&
                                relay.snapshot().session === queries
                              )
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
                      const actions = rowActions(channel);
                      const menuEnabled = actions.length > 0;
                      const menuOpen =
                        menuEnabled &&
                        rowMenu?.channelId === channel.id &&
                        rowMenu.sectionKey === section.key;
                      const channelItem = (
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
                          onHideDm={hiddenDms.hide}
                          menuEnabled={menuEnabled}
                          sectionKey={section.key}
                          onOpenMenu={openRowMenu}
                        />
                      );
                      if (!menuEnabled) return channelItem;
                      return (
                        <ContextMenuRoot
                          key={channel.id}
                          open={menuOpen}
                          onOpenChange={(open) => {
                            if (open) openRowMenu(channel, section.key);
                            else if (menuOpen) closeRowMenu();
                          }}
                        >
                          {channelItem}
                          <MenuPopup
                            aria-label={`Actions for ${channel.name}`}
                            anchor={menuOpen ? rowMenu.anchor : undefined}
                            finalFocus={() =>
                              startingSession.current
                                ? (document
                                    .getElementById("new-session-prompt")
                                    ?.querySelector<HTMLElement>(
                                      '[role="textbox"]',
                                    ) ?? false)
                                : (sidebar.list.current?.querySelector<HTMLButtonElement>(
                                    `[data-channel-id="${CSS.escape(channel.id)}"]`,
                                  ) ?? false)
                            }
                          >
                            {actions}
                            {readWrite?.pending && <p role="status">Saving…</p>}
                            {readWrite?.error && (
                              <p role="alert">{readWrite.error}</p>
                            )}
                          </MenuPopup>
                        </ContextMenuRoot>
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
            {preferences.status === "error" ? (
              <ToastNotice
                title="Saved sidebar preferences couldn’t refresh"
                description="Your conversations are still available."
                tone="warning"
              >
                <Button type="button" size="sm" onClick={preferences.reload}>
                  Retry
                </Button>
              </ToastNotice>
            ) : preferences.status !== "ready" ? (
              <p className={styles.preferenceNotice}>
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
