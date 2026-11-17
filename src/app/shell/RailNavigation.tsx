import { TeamViewMenu } from "./TeamViewMenu";
import { RailPinPicker } from "./RailPinPicker";
import { RailEntryArtwork } from "./RailEntryArtwork";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { RelaySession } from "../../features/relay/session";
import {
  RailConversationItem,
  RailOpenConversations,
} from "./RailConversationItem";
import type { NavigationScope } from "../../features/navigation/targets";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import { targetKey } from "../../features/navigation/targets";
import type { Navigation } from "../../features/navigation/controller";
import type { RegisteredPage } from "../../features/pages/service";
import { canMessageAgent } from "../../features/agents/choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { useSavedHiddenDmIds } from "../../bundled/channels/useHiddenDms";
import { resumeSoloDraftTarget } from "../../features/channel-navigation/routes";
import { soloDraftInput } from "../../features/solo/SoloDraft";
import {
  soloNeighbors,
  soloSuccessor,
} from "../../features/channel-navigation/solo-successor";
import { routedSection } from "./list-column";
import type { OpenTarget } from "../../features/navigation/targets";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  sidebarSectionTarget,
  isSidebarSectionRoute,
} from "../../features/channel-navigation/sidebar-section-route";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  ArrowRightIcon,
  AtIcon,
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  HashIcon,
  MessageReplyIcon,
  PinIcon,
  PlusIcon,
  StorefrontIcon,
  UserIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { RailArrangement, RailGroup } from "./RailArrangement";
import { ContributedRailSections } from "../../features/channel-navigation/ContributedRailSections";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import type { SidebarScope } from "../../features/channel-navigation/sidebar-scope-service";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { PageNavigation } from "./PageNavigation";
import { PageIcon } from "./PageIcon";
import { pagePresentation } from "./presentation";
import { RailConversationList } from "./RailConversationList";
import { useRailPins, type RailEntry } from "./rail-pins";
import { personEntries, soloView, useRailModel } from "./rail-model";
import {
  useChannelNavigation,
  type ChannelMenuSurface,
} from "../../features/channel-navigation/ChannelNavigationState";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { ChannelCopyLinkMenuItem } from "../../bundled/channels/ChannelCopyLinkMenuItem";
import { ChannelLifecycleMenu } from "../../bundled/channels/ChannelLifecycleMenu";
import { lifecycleNoun } from "../../bundled/channels/ChannelLifecycleDialog";
import { ChannelReadMenuItem } from "../../bundled/channels/ChannelReadMenuItem";
import styles from "./RailNavigation.module.css";
import {
  useConversationCount,
  conversationIndex,
  type ConversationFilter,
  type ConversationQuery,
} from "../../features/conversation/conversation-index";
import {
  CollectionCreationAction,
  CollectionFilters,
  useActivityView,
  withoutAgentViews,
  type ActivityView,
} from "../../features/conversation/ConversationList";

export function RailNavigation({
  session,
  scope,
  navigator,
  pages,
  selected,
  onSelect,
  creationAction,
  sidebarSections,
  sidebarScope,
  section: pageSection,
  openInSection,
  listedSection,
  compact = false,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  pages: readonly RegisteredPage[];
  selected: string;
  onSelect(
    key: string,
    options?: Pick<NavigationOpenOptions, "focus"> & { section?: string },
  ): void;
  creationAction?: ReactNode;
  sidebarSections?: SidebarSections | undefined;
  /** A plugin's restriction narrows the cards to Solo under its banner. */
  sidebarScope?: SidebarScope | undefined;
  /** Shows this section's full list instead of the cards: the shell's list
   * column renders one beside the cards, under the same `RailDrag`. */
  section?: string | undefined;
  /** Opens a conversation with the list showing the section it was opened from. */
  openInSection?: ((section: string, target: OpenTarget) => void) | undefined;
  /** The section whose list is showing beside the cards. */
  listedSection?: string | undefined;
  compact?: boolean;
}) {
  const partition = `${scope.communityOrigin}:${scope.viewer}`;
  const contributed = useSyncExternalStore(
    sidebarSections?.subscribe ?? noSubscription,
    sidebarSections?.snapshot ?? noSections,
  );
  const restriction = useSyncExternalStore(
    sidebarScope?.subscribe ?? noSubscription,
    () => sidebarScope?.snapshot()[0],
  );
  const channelNavigation = useChannelNavigation();
  const closeMuteMenu = useRef<(() => void) | undefined>(undefined);
  const muteRecovery =
    channelNavigation?.session === session
      ? channelNavigation.muteRecovery
      : undefined;
  useEffect(() => {
    // The cards own what only one rail can answer.
    if (!muteRecovery || pageSection) return;
    const recovery = {
      closeMenu: () => closeMuteMenu.current?.(),
      focus: (channelId: string) =>
        document
          .querySelector<HTMLElement>(
            `#shell-rail [data-rail-channel="${CSS.escape(channelId)}"]`,
          )
          ?.focus(),
    };
    muteRecovery.current = recovery;
    return () => {
      if (muteRecovery.current === recovery) muteRecovery.current = undefined;
    };
  }, [muteRecovery, pageSection]);
  const preferences = useSyncExternalStore(
    session.sidebarPreferences.subscribe,
    session.sidebarPreferences.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const [savedMessageView, setMessageView] = useActivityView(partition);
  // Team offers no agent views; a saved one shows All.
  const messageView = useMemo(
    () => withoutAgentViews(savedMessageView),
    [savedMessageView],
  );
  const { setPinned } = useRailPins(partition);
  // What the rail shows is built once for the session; this only draws it.
  const {
    channels,
    channelsById,
    agents,
    agentEntries,
    entries: modelEntries,
    byId: modelById,
    pins,
    sections: membership,
    soloChats,
    teamChats,
  } = useRailModel(session);
  // Only the shown entry draws the rail. An opening visit's other steps,
  // its start and its settling, change nothing here and render nothing.
  const shownEntry = useSyncExternalStore(
    navigator.subscribe,
    useCallback(() => navigator.snapshot().entry, [navigator]),
  );
  const navigation = { entry: shownEntry };
  const sectionRoute =
    navigation.entry.target.kind === "page"
      ? navigation.entry.target.route?.params
      : undefined;
  const selectedSection = isSidebarSectionRoute(sectionRoute)
    ? sectionRoute.section
    : undefined;
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState<string>();
  const pending = useRef<AbortController>(undefined);
  const pinTrigger = useRef<HTMLButtonElement>(null);
  const hidden = useSavedHiddenDmIds(partition);
  // A new visit cancels a previous person-open attempt.
  useEffect(() => {
    let attempt = navigator.snapshot().attempt.id;
    return navigator.subscribe(() => {
      const next = navigator.snapshot().attempt.id;
      if (next === attempt) return;
      attempt = next;
      pending.current?.abort();
      pending.current = undefined;
      setOpening(undefined);
    });
  }, [navigator]);
  useEffect(() => () => pending.current?.abort(), []);

  // The open picker lists everyone known, not only the people the rail names.
  const everyone = useSyncExternalStore(
    picker ? session.profiles.subscribe : noSubscription,
    () => (picker ? session.profiles.snapshot() : undefined),
  );
  const { entries, byId } = useMemo(() => {
    if (!everyone) return { entries: modelEntries, byId: modelById };
    const entries = [
      ...modelEntries.filter((entry) => !entry.id.startsWith("person:")),
      ...personEntries(
        session,
        scope.viewer,
        everyone,
        new Set(agents.identities.map((agent) => agent.pubkey)),
        resolveName,
      ),
    ];
    return {
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry])),
    };
  }, [
    everyone,
    modelEntries,
    modelById,
    session,
    scope.viewer,
    agents.identities,
    resolveName,
  ]);
  const pinned = new Set(pins.map((pin) => pin.id));
  const togglePin = (entry: RailEntry, nextPinned = !pinned.has(entry.id)) => {
    const saved = setPinned(entry, nextPinned);
    setError(
      saved ? undefined : "Couldn’t save pins on this device. Try again.",
    );
    return saved;
  };
  const open = async (entry: RailEntry) => {
    setError(undefined);
    if (entry.target.kind !== "person") {
      void navigator.open(entry.target);
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setOpening(entry.id);
    try {
      const pubkey = entry.target.pubkey;
      const existing = channels.find(
        (channel) =>
          channel.channelType === "dm" &&
          channel.participants?.length === 1 &&
          channel.participants[0] === pubkey,
      );
      if (
        entry.kind === "agent" &&
        !existing &&
        !session.agentChoices
          .snapshot()
          .selectable.some(
            (agent) => agent.pubkey === pubkey && canMessageAgent(agent),
          )
      )
        throw new Error(
          "This agent is not ready to message in this community.",
        );
      // The former sidebar loaded this projection. With one rail, read it only
      // when a person is opened; its owner retains retry and cancellation rules.
      if (
        existing &&
        session.directMessages.available &&
        session.channelLifecycle.snapshot().status !== "ready"
      )
        await session.channelLifecycle.refreshVisibility(controller.signal);
      const currentVisibility = session.channelLifecycle.snapshot();
      const visible =
        existing &&
        (!session.directMessages.available ||
          (currentVisibility.status === "ready" &&
            !currentVisibility.hidden.includes(existing.id) &&
            !hidden.has(existing.id)));
      const channelId = visible
        ? existing.id
        : await session.directMessages.open([pubkey], controller.signal);
      if (!controller.signal.aborted)
        await navigator.open({
          version: 1,
          kind: "conversation",
          scope,
          channelId,
        });
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Couldn’t open this conversation. Try again.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setOpening(undefined);
      }
    }
  };
  const isSelected = (entry: RailEntry) => {
    const target = navigation.entry.target;
    if (entry.target.kind === "person") {
      const pubkey = entry.target.pubkey;
      return (
        target.kind === "conversation" &&
        channels.some(
          (channel) =>
            channel.id === target.channelId &&
            channel.channelType === "dm" &&
            channel.participants?.length === 1 &&
            channel.participants[0] === pubkey,
        )
      );
    }
    return entry.target.kind === "conversation" &&
      target.kind === "conversation"
      ? entry.target.channelId === target.channelId &&
          (!entry.target.messageId ||
            entry.target.messageId === target.messageId)
      : keyOf(entry.target) === keyOf(target);
  };
  const artwork = (entry: RailEntry, avatarOnly = false, feed = false) => (
    <RailEntryArtwork
      entry={entry}
      avatarOnly={avatarOnly}
      size={feed ? "fill" : "compact"}
      selected={isSelected(entry)}
      session={session}
      channelsById={channelsById}
      resolveName={resolveName}
      identities={agents.identities}
      agentEntries={agentEntries}
    />
  );
  // New returns to an ordinary draft that is already open rather than
  // replacing its editor.
  const newSoloChat = () => {
    const target = navigation.entry.target;
    const destination = resumeSoloDraftTarget(session.scope, target);
    const input = destination === target ? soloDraftInput() : null;
    if (input) input.focus();
    else void navigator.open(destination);
  };
  // Leaving a Solo chat opens the row that takes its place.
  const neighborsRef = channelNavigation?.soloNeighbors;
  useEffect(() => {
    if (!neighborsRef || pageSection) return;
    const shown = soloChats.map((channel) => channel.id);
    const neighbors = (id: string) =>
      soloNeighbors([{ rows: soloChats, shown }], id);
    neighborsRef.current = neighbors;
    return () => {
      if (neighborsRef.current === neighbors) neighborsRef.current = undefined;
    };
  }, [neighborsRef, soloChats, pageSection]);
  // Mute, read state and the link: the rail's row menus show them, and so
  // does the open conversation's header through the published actions.
  const channelActions = (
    channel: ChannelSummary,
    whole: boolean,
    close: () => void,
    focus: () => void,
    surface?: ChannelMenuSurface,
  ) => {
    if (!channelNavigation) return [];
    const intent = channelNavigation.mute.intents.get(channel.id);
    const muted = intent?.pending
      ? intent.muted
      : !!preferences.data?.muted.includes(channel.id);
    return [
      session.sidebarPreferences.muteWritable && preferences.data && (
        <MenuItem
          key="mute"
          onClick={() => {
            closeMuteMenu.current = close;
            channelNavigation.mute.change(channel.id, channel.name, !muted);
            close();
            focus();
          }}
        >
          <MenuIcon>
            {muted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
          </MenuIcon>
          {muted ? "Unmute" : "Mute"}
        </MenuItem>
      ),
      whole && session.unread.sync().capability === "frontier-sync" && (
        <ChannelReadMenuItem
          key="read"
          unread={session.unread}
          channelId={channel.id}
          pending={surface?.pending ?? false}
          closeOnClick={!surface}
          run={
            surface?.runRead ??
            ((action) =>
              action().then(
                () => {},
                () => setError("Read state couldn’t be saved. Try again."),
              ))
          }
        />
      ),
      whole && (
        <ChannelCopyLinkMenuItem key="copy-link" channelId={channel.id} />
      ),
    ];
  };
  const publishActions = useRef(channelActions);
  publishActions.current = channelActions;
  const menuActions =
    channelNavigation?.session === session
      ? channelNavigation.menuActions
      : undefined;
  const intents = channelNavigation?.mute.intents;
  // biome-ignore lint/correctness/useExhaustiveDependencies: mute and read changes republish the header's items.
  useLayoutEffect(() => {
    if (!menuActions || pageSection) return;
    menuActions.publish((channel, surface) =>
      channel.cached
        ? []
        : publishActions.current(
            channel,
            true,
            () => surface.close(),
            () => surface.focus(),
            surface,
          ),
    );
    return () => menuActions.publish(undefined);
  }, [menuActions, pageSection, preferences, intents]);
  // What follows a channel's confirmation: Cancel returns to the control that
  // opened it, and leaving or deleting the open conversation opens the row
  // that takes its place.
  const lifecycleDialog =
    channelNavigation?.session === session
      ? channelNavigation.lifecycleDialog
      : undefined;
  const lifecycleCallbacks = channelNavigation?.lifecycleCallbacks;
  const listed = useRef(channels);
  const lifecycleNeighbors = useRef<{ id: string; ids: string[] }>(undefined);
  listed.current = channels;
  useLayoutEffect(() => {
    if (!lifecycleCallbacks || pageSection || !lifecycleDialog) return;
    const { channel, action, trigger, focusFallback } = lifecycleDialog;
    const solo = channel.channelType === "solo";
    // Captured while it is still listed: completion can arrive after the
    // roster has dropped it.
    const rows = rowsLike(session, channel);
    const at = rows.indexOf(channel.id);
    if (at >= 0)
      lifecycleNeighbors.current = {
        id: channel.id,
        ids: [...rows.slice(at + 1), ...rows.slice(0, at).reverse()],
      };
    const neighbors =
      lifecycleNeighbors.current?.id === channel.id
        ? lifecycleNeighbors.current.ids
        : rows;
    const focus = () =>
      (trigger?.isConnected
        ? trigger
        : focusFallback?.isConnected
          ? focusFallback
          : document.querySelector<HTMLElement>(
              `#shell-rail [data-rail-channel="${CSS.escape(channel.id)}"]`,
            )
      )?.focus({ preventScroll: true });
    const callbacks = {
      close: focus,
      depart: () => {
        // Archive changes visibility, not access or the current destination.
        if (action === "archive" || action === "unarchive") return focus();
        const target = navigator.snapshot().entry.target;
        if (target.kind !== "conversation" || target.channelId !== channel.id)
          return;
        if (solo)
          return void navigator.open(
            soloSuccessor(session.scope, listed.current, neighbors, channel.id),
          );
        const next = neighbors.find(
          (id) =>
            id !== channel.id && listed.current.some((row) => row.id === id),
        );
        void navigator.open(
          next
            ? { version: 1, kind: "conversation", scope, channelId: next }
            : emptyChannels,
        );
      },
    };
    lifecycleCallbacks.current = callbacks;
    return () => {
      if (lifecycleCallbacks.current === callbacks)
        lifecycleCallbacks.current = undefined;
    };
  }, [
    lifecycleCallbacks,
    lifecycleDialog,
    pageSection,
    session,
    scope,
    navigator,
  ]);
  const visited = navigation.entry.target;
  const currentChannel =
    visited.kind === "conversation"
      ? channels.find((channel) => channel.id === visited.channelId)
      : undefined;
  // Where losing the open conversation lands: the row that takes its place,
  // captured while it is still listed, as removal drops it first.
  const openSuccessor = channelNavigation?.openSuccessor;
  const openNeighbors = useRef<{ id: string; ids: string[] }>(undefined);
  useLayoutEffect(() => {
    if (!openSuccessor || pageSection) return;
    if (currentChannel) {
      const rows = rowsLike(session, currentChannel);
      const at = rows.indexOf(currentChannel.id);
      if (at >= 0)
        openNeighbors.current = {
          id: currentChannel.id,
          ids: [...rows.slice(at + 1), ...rows.slice(0, at).reverse()],
        };
    }
    const open = (id: string) => {
      const next = (
        openNeighbors.current?.id === id ? openNeighbors.current.ids : []
      ).find(
        (neighbor) =>
          neighbor !== id && listed.current.some((row) => row.id === neighbor),
      );
      void navigator.open(
        next
          ? { version: 1, kind: "conversation", scope, channelId: next }
          : emptyChannels,
      );
    };
    openSuccessor.current = open;
    return () => {
      if (openSuccessor.current === open) openSuccessor.current = undefined;
    };
  }, [openSuccessor, pageSection, currentChannel, session, scope, navigator]);
  const activeDockSection =
    selectedSection ??
    // A section a person made has no address: its open list marks it.
    (listedSection && listedSection !== "team" && listedSection !== "solo"
      ? listedSection
      : undefined) ??
    (currentChannel?.channelType === "solo" ||
    (sectionRoute &&
      typeof sectionRoute === "object" &&
      "kind" in sectionRoute &&
      sectionRoute.kind === "solo-draft")
      ? "solo"
      : [
            "buzz.channels/channels",
            "buzz.inbox/inbox",
            "buzz.drafts-and-sent/drafts-sent",
          ].includes(selected)
        ? "team"
        : "navigation");
  const current = entries.find(
    (entry) =>
      entry.target.kind !== "person" &&
      keyOf(entry.target) === keyOf(navigation.entry.target),
  ) ?? {
    id: `view:${keyOf(navigation.entry.target)}`,
    label: pages.find((page) => page.key === selected)?.title ?? "Current view",
    kind: "page" as const,
    target: navigation.entry.target,
  };
  const matches = (picker ? entries : [])
    .filter((entry) =>
      `${entry.label} ${entry.kind}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .slice(0, 60);

  /** The cards, or one section's full list for the shell's list column. */
  const view = () => {
    // A list shows one section: the others' rows are not built for it.
    const shown = (id: string, content: () => ReactNode) =>
      pageSection && pageSection !== id ? null : content();
    const row = (entry: RailEntry, avatarOnly = false, feed = false) => {
      const target = entry.target;
      const channel =
        target.kind === "conversation"
          ? channelsById.get(target.channelId)
          : target.kind === "person"
            ? channels.find(
                (channel) =>
                  channel.channelType === "dm" &&
                  channel.participants?.length === 1 &&
                  channel.participants[0] === target.pubkey,
              )
            : undefined;
      const label = (
        <span className={styles.rowLabel}>
          <span>{entry.label}</span>
        </span>
      );
      const props = {
        title: avatarOnly ? undefined : entry.label,
        "aria-label": entry.label,
        selected: isSelected(entry),
        disabled: opening === entry.id,
        onClick: () => void open(entry),
      };
      const control = feed ? (
        <RailConversationItem
          key={entry.id}
          {...props}
          layout="feed"
          session={session}
          channel={channel}
          destination={entry.target}
          avatar={artwork(entry, false, true)}
          place={entry.label}
          preview={
            entry.kind === "agent"
              ? "Agent · Direct message"
              : entry.kind === "person"
                ? "Direct message"
                : entry.kind === "page"
                  ? "App"
                  : target.kind === "conversation" && target.threadRootId
                    ? "Thread"
                    : "Message"
          }
        />
      ) : channel ? (
        <RailConversationItem
          key={entry.id}
          {...props}
          data-rail-channel={channel.id}
          session={session}
          channel={channel}
          destination={entry.target}
          avatar={artwork(entry, avatarOnly)}
          avatarOnly={avatarOnly}
          place={label}
        />
      ) : (
        <NavigationItem
          key={entry.id}
          {...props}
          icon={artwork(entry, avatarOnly)}
          variant={avatarOnly ? "avatar" : "row"}
          label={label}
        />
      );
      return avatarOnly ? (
        <Tooltip
          content={entry.kind === "agent" ? `DM ${entry.label}` : entry.label}
          hint="dock"
        >
          {control}
        </Tooltip>
      ) : (
        control
      );
    };

    const sourceRow = (entry: RailEntry, section: string) => ({
      entry,
      content: row(entry, section === "pins" && pageSection !== section),
    });
    const pageRow = (page: RegisteredPage) => {
      const entry = byId.get(page.key);
      return entry
        ? [
            {
              entry,
              content: (
                <PageNavigation
                  pages={[page]}
                  selected={selected}
                  onSelect={onSelect}
                  previews
                />
              ),
            },
          ]
        : [];
    };

    const plugins = pages.filter(
      (page) =>
        (page.primary || page.key === "buzz.agents/agents") &&
        ![
          "buzz.channels/channels",
          "buzz.inbox/inbox",
          "buzz.drafts-and-sent/drafts-sent",
        ].includes(page.key),
    );
    const teamPageIds = [
      "buzz.inbox/inbox",
      "buzz.drafts-and-sent/drafts-sent",
    ];
    const teamPages = teamPageIds.flatMap((key) =>
      pages.filter((page) => page.key === key),
    );
    let sectionPage: ReactNode;
    if (pageSection === "team" || pageSection === "solo") {
      const defaults = (pageSection === "solo" ? soloChats : channels).flatMap(
        (channel) => {
          const entry = byId.get(`channel:${channel.id}`);
          return entry ? [entry] : [];
        },
      );
      const sectionEntries = membership.entries(pageSection, defaults, byId);
      sectionPage = (
        <RailConversationList
          section={pageSection}
          entries={sectionEntries}
          session={session}
          scope={scope}
          navigator={navigator}
          target={navigation.entry.target}
          renderOther={(entry) => row(entry, false, true)}
        />
      );
    }
    const teamCount = (filter: ConversationFilter) => (
      <TeamCount session={session} filter={filter} />
    );
    const activityPage = teamPages.find(
      (page) => page.key === "buzz.inbox/inbox",
    );
    const teamViews: {
      filter: ConversationFilter;
      label: string;
      icon: ReactElement;
    }[] = [
      { filter: "all", label: "Activity", icon: <ChatCircleIcon size={18} /> },
      { filter: "channels", label: "Channels", icon: <HashIcon size={18} /> },
      {
        filter: "threads",
        label: "Threads",
        icon: <MessageReplyIcon size={18} />,
      },
      { filter: "dms", label: "DMs", icon: <UsersIcon size={18} /> },
      { filter: "mentions", label: "Mentions", icon: <AtIcon size={18} /> },
    ];
    const teamOpen = routedSection(navigation.entry.target) === "team";
    const openTeamView = (filter: ActivityView["filter"]) => {
      setMessageView({ ...messageView, filter });
      void navigator.open(sidebarSectionTarget(scope, "team"));
    };
    const messageCard = shown("team", () => (
      <RailGroup
        id="team"
        title="Team"
        rows={teamChats.flatMap((channel) => {
          if (hidden.has(channel.id)) return [];
          const entry = byId.get(`channel:${channel.id}`);
          return entry ? [sourceRow(entry, "team")] : [];
        })}
        rowsLabel="Recent conversations"
        views={
          <div className={styles.teamViews} data-rail-team-icons="">
            {teamViews.map((item) => (
              <TeamViewMenu
                key={item.filter}
                session={session}
                filter={item.filter}
              >
                <span className={styles.teamView}>
                  <Tooltip content={item.label}>
                    <IconButton
                      variant="ghost"
                      shape="round"
                      aria-label={item.label}
                      icon={item.icon}
                      data-rail-team-view={item.filter}
                      aria-current={
                        teamOpen && messageView.filter === item.filter
                          ? "page"
                          : undefined
                      }
                      aria-pressed={
                        teamOpen && messageView.filter === item.filter
                      }
                      onClick={() => openTeamView(item.filter)}
                    />
                  </Tooltip>
                  <span className={styles.teamCount}>
                    {teamCount(item.filter)}
                  </span>
                </span>
              </TeamViewMenu>
            ))}
            {teamPages
              .filter((page) => page !== activityPage)
              .map((page) => {
                const { icon, image, label } = pagePresentation(page);
                return (
                  <Tooltip key={page.key} content={label}>
                    <IconButton
                      variant="ghost"
                      shape="round"
                      aria-label={label}
                      icon={<PageIcon icon={icon} image={image} size={18} />}
                      data-rail-team-view={page.key}
                      aria-current={selected === page.key ? "page" : undefined}
                      onClick={() => onSelect(page.key)}
                    />
                  </Tooltip>
                );
              })}
          </div>
        }
        pageContent={sectionPage}
        renderOpen={(hidden, open) => (
          <RailOpenConversations
            session={session}
            channels={channels}
            hidden={hidden}
            label="Open Team"
            onClick={open}
          />
        )}
        action={creationAction}
      />
    ));
    return (
      <RailArrangement
        key={partition}
        partition={partition}
        current={byId}
        renderSectionList={(id, title, entries, action) => (
          <RailConversationList
            section={id}
            title={title}
            heading={
              <CollectionFilters title={title} actions={action}>
                {null}
              </CollectionFilters>
            }
            entries={entries}
            session={session}
            scope={scope}
            navigator={navigator}
            target={navigation.entry.target}
            renderOther={(entry) => row(entry, false, true)}
          />
        )}
        pageSection={pageSection}
        compact={!pageSection && compact}
        only={
          restriction && !pageSection
            ? {
                section: "solo",
                banner: (
                  <OwnedContribution
                    entry={restriction}
                    registry={sidebarScope ?? noRestrictions}
                    fallback={null}
                  >
                    {({ banner: Banner }) => <Banner />}
                  </OwnedContribution>
                ),
              }
            : undefined
        }
        selectedSection={activeDockSection}
        openSection={(id) => {
          // A section a person made has no page of its own: open its first
          // conversation beside its list.
          const first =
            id === "team" || id === "solo"
              ? undefined
              : membership
                  .entries(id, [], byId)
                  .find((entry) => entry.target.kind === "conversation");
          if (first?.target.kind === "conversation" && openInSection)
            openInSection(id, first.target);
          else void navigator.open(sidebarSectionTarget(scope, id));
        }}
        isPinned={(entry) => pinned.has(entry.id)}
        onTogglePin={(entry, nextPinned) => {
          if (nextPinned) {
            togglePin(entry, true);
            return;
          }
          // Remove the row and its menu before restoring focus to the rail.
          if (flushSync(() => togglePin(entry, false)))
            (
              pinTrigger.current ?? document.getElementById("main-content")
            )?.focus();
        }}
        renderEntry={(entry, section) => {
          if (section === "pins")
            return row(byId.get(entry.id) ?? entry, pageSection !== section);
          const contribution = contributed.find((section) =>
            entry.id.startsWith(`contributed:${section.key}:`),
          );
          if (contribution && sidebarSections)
            return (
              <ContributedRailSections
                registry={sidebarSections}
                navigator={navigator}
                partition={partition}
                only={contribution.key}
                rowId={entry.id.slice(
                  `contributed:${contribution.key}:`.length,
                )}
                fallbackRow={row(entry)}
                renderSection={({ children }) => children}
              />
            );
          const page = pages.find((page) => page.key === entry.id);
          return page ? (
            <PageNavigation
              pages={[page]}
              selected={selected}
              onSelect={onSelect}
            />
          ) : (
            row(byId.get(entry.id) ?? entry)
          );
        }}
        renderRowActions={(entry, close, focus) => {
          if (channelNavigation?.session !== session) return null;
          const destination = entry.target;
          const channel =
            destination.kind === "conversation"
              ? channelsById.get(destination.channelId)
              : undefined;
          if (!channel) return null;
          // A thread or message row mutes its channel; the rest act on a
          // whole conversation.
          const whole =
            destination.kind === "conversation" &&
            !destination.threadRootId &&
            !destination.messageId;
          return (
            <>
              {channelActions(channel, whole, close, focus)}
              {whole &&
                (!channel.readOnly || channel.viewerRole === "guest") &&
                !channel.cached &&
                !channel.archived && (
                  <ChannelLifecycleMenu
                    channel={channel}
                    session={session}
                    disabled={!!channelNavigation.lifecycleDialog}
                    separator
                    noun={lifecycleNoun(channel)}
                    choose={(action) =>
                      channelNavigation.openLifecycle(channel, action)
                    }
                  />
                )}
            </>
          );
        }}
        sections={[
          {
            id: "navigation",
            title: "Plugins",
            icon: <StorefrontIcon size={22} />,
            content: shown("navigation", () => (
              <RailGroup
                id="navigation"
                title="Plugins"
                unlimited
                trailingEntryId={pluginCatalog.id}
                rows={[
                  ...plugins.flatMap(pageRow),
                  {
                    entry: pluginCatalog,
                    content: (
                      <NavigationItem
                        label="Open Plugins"
                        data-rail-view-more=""
                        aria-label="Open Plugins"
                        icon={<ArrowRightIcon size={18} />}
                        onClick={() =>
                          onSelect("settings", { section: "plugins" })
                        }
                      />
                    ),
                  },
                ]}
              ></RailGroup>
            )),
          },
          {
            id: "pins",
            title: "Pins",
            icon: <PinIcon size={22} />,
            content: shown("pins", () => (
              <RailGroup
                id="pins"
                title="Pins"
                rows={pins.map((pin) =>
                  sourceRow(byId.get(pin.id) ?? pin, "pins"),
                )}
                action={
                  <IconButton
                    size="sm"
                    variant={pageSection ? "glass" : "ghost"}
                    aria-label="Add pin"
                    ref={pinTrigger}
                    icon={<PlusIcon size={16} strokeWidth={2} />}
                    onClick={() => {
                      setQuery("");
                      setPicker(true);
                    }}
                  />
                }
              >
                {!pins.length && (
                  <NavigationItem
                    label="Pin a chat, person, or channel"
                    icon={<PinIcon size={18} />}
                    onClick={() => {
                      setQuery("");
                      setPicker(true);
                    }}
                  />
                )}
              </RailGroup>
            )),
          },
          {
            id: "team",
            title: "Team",
            icon: <ChatCircleIcon size={22} />,
            content: messageCard,
          },
          {
            id: "solo",
            title: "Solo",
            icon: <UserIcon size={22} />,
            content: shown("solo", () => (
              <RailGroup
                id="solo"
                title="Solo"
                renderOpen={(hidden, open) => (
                  <RailOpenConversations
                    session={session}
                    channels={channels}
                    hidden={hidden}
                    label="Open Solo"
                    onClick={open}
                  />
                )}
                rows={soloChats.flatMap((channel) => {
                  const entry = byId.get(`channel:${channel.id}`);
                  return entry ? [sourceRow(entry, "solo")] : [];
                })}
                pageContent={sectionPage}
                action={
                  <IconButton
                    size="sm"
                    variant={pageSection ? "glass" : "ghost"}
                    aria-label="New Solo chat"
                    icon={<PlusIcon size={16} strokeWidth={2} />}
                    onClick={() => newSoloChat()}
                  />
                }
              >
                {!soloChats.length && (
                  <p className={styles.note}>No Solo chats yet.</p>
                )}
              </RailGroup>
            )),
          },
          ...contributed.map((section) => ({
            id: section.key,
            title: section.title,
            icon: <>{section.icon}</>,
            content: sidebarSections && (
              <ContributedRailSections
                registry={sidebarSections}
                navigator={navigator}
                partition={partition}
                only={section.key}
                fullPage={pageSection === section.key}
                renderSection={({ label, action, items, note }) => (
                  <RailGroup
                    id={section.key}
                    title={label}
                    action={action}
                    rows={items.map((item) => ({
                      entry: {
                        id: `contributed:${section.key}:${item.id}`,
                        label: item.label,
                        kind: "page",
                        target: item.target,
                      },
                      content: item.content,
                    }))}
                  >
                    {note}
                  </RailGroup>
                )}
              />
            ),
          })),
        ]}
      />
    );
  };
  return (
    <>
      {pageSection ? (
        <CollectionCreationAction
          value={
            <IconButton
              aria-label="New message"
              title="New message"
              icon={<PlusIcon size={20} aria-hidden="true" />}
              onClick={() =>
                pageSection === "solo"
                  ? newSoloChat()
                  : void navigator.open({
                      version: 1,
                      kind: "page",
                      pluginId: "buzz.channels",
                      pageId: "channels",
                      scope,
                      route: { version: 1, params: "compose" },
                    })
              }
            />
          }
        >
          {view()}
        </CollectionCreationAction>
      ) : (
        view()
      )}

      {error && !picker && (
        <p role="alert" className={styles.note}>
          {error}
        </p>
      )}
      <RailPinPicker
        open={picker}
        onOpenChange={setPicker}
        query={query}
        onQuery={setQuery}
        error={error}
        current={current}
        matches={matches}
        pinned={pinned}
        artwork={artwork}
        onPin={(entry) => {
          if (togglePin(entry)) setPicker(false);
        }}
      />
    </>
  );
}

/** Unread rows in one Team view; nothing when all are read. It follows the
 * conversations themselves, not the visit the rail is showing. */
const TeamCount = memo(function TeamCount({
  session,
  filter,
}: {
  session: RelaySession;
  filter: ConversationFilter;
}) {
  const count = useConversationCount(session, unreadIn[filter]);
  return count ? (
    <span
      className={styles.teamUnreadMark}
      role="img"
      aria-label={`${count} unread conversation${count === 1 ? "" : "s"}`}
    />
  ) : null;
});
const unreadIn = Object.fromEntries(
  (["all", "threads", "dms", "mentions", "channels"] as const).map((filter) => [
    filter,
    // Team's views: All keeps Solo in its own collection.
    { filter, unread: true, home: "team" },
  ]),
) as Record<ConversationFilter, ConversationQuery>;
/** Entries and visits keep their targets, so each is serialized once. */
const targetKeys = new WeakMap<object, string>();
const emptyChannels = {
  version: 1,
  kind: "page",
  pluginId: "buzz.channels",
  pageId: "channels",
  route: { version: 1, params: "empty" },
} as const;

/** The rows of a channel's own kind, in order: every list showing it also
 * shows them. */
function rowsLike(session: RelaySession, channel: ChannelSummary) {
  return conversationIndex(session)
    .keys(
      channel.channelType === "solo"
        ? soloView
        : {
            filter: channel.channelType === "dm" ? "dms" : "channels",
            unread: false,
            home: "team",
          },
    )
    .flatMap((key) => (key.startsWith("c:") ? [key.slice(2)] : []));
}

function keyOf(target: Exclude<RailEntry["target"], { kind: "person" }>) {
  let key = targetKeys.get(target);
  if (key === undefined) {
    key = targetKey(target);
    targetKeys.set(target, key);
  }
  return key;
}
const noSubscription = () => () => {};
const noRestrictions = { snapshot: () => [] as const };
const pluginCatalog: RailEntry = {
  id: "settings:plugins",
  label: "Plugins",
  kind: "page",
  target: { version: 1, kind: "settings", section: "plugins" },
};
const emptySections: readonly import("../../features/channel-navigation/sidebar-sections-service").RegisteredSidebarSection[] =
  [];
const noSections = () => emptySections;
