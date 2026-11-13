import { RailPinPicker } from "./RailPinPicker";
import { RailEntryArtwork } from "./RailEntryArtwork";
import { railSections } from "./rail-sections";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
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
import { useAgentChoices } from "../../features/agents/use-choices";
import { canMessageAgent } from "../../features/agents/choices";
import { archiveHides } from "../../features/relay/identity-archives";
import { dmLabel } from "../../features/conversation/dm-label";
import { useIdentityNames } from "../../features/identity-names/react";
import { useSavedHiddenDmIds } from "../../bundled/channels/useHiddenDms";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import { routedSection } from "./list-column";
import type { OpenTarget } from "../../features/navigation/targets";
import {
  sidebarSectionTarget,
  isSidebarSectionRoute,
} from "../../features/channel-navigation/sidebar-section-route";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  ArrowRightIcon,
  AtIcon,
  ChatCircleIcon,
  HashIcon,
  MessageReplyIcon,
  PinIcon,
  PlusIcon,
  StorefrontIcon,
  UserIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { useRailLayout } from "./rail-layout";
import { RailArrangement, RailGroup } from "./RailArrangement";
import { ContributedRailSections } from "../../features/channel-navigation/ContributedRailSections";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import { PageNavigation } from "./PageNavigation";
import { RailConversationList } from "./RailConversationList";
import { useRailPins, type RailEntry } from "./rail-pins";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import styles from "./RailNavigation.module.css";
import {
  ConversationList,
  CollectionCreationAction,
  CollectionFilters,
  includeMessagesChannel,
  useActivityView,
  withoutAgentViews,
  type ActivityView,
} from "../../features/conversation/ConversationList";

export function RailNavigation({
  session,
  scope,
  navigator: directNavigator,
  pages,
  selected,
  onSelect,
  creationAction,
  sidebarSections,
  list: listColumn,
  listNavigator = directNavigator,
  openInSection,
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
  /** The section the shell's list column shows, rendered into its slot. */
  list?: { section: string; slot: Element | null } | undefined;
  /** Opens from the list column, which keep that column as it is. */
  listNavigator?: Navigation;
  /** Opens a conversation with the list showing the section it was opened from. */
  openInSection?: ((section: string, target: OpenTarget) => void) | undefined;
  compact?: boolean;
}) {
  const partition = `${scope.communityOrigin}:${scope.viewer}`;
  const contributed = useSyncExternalStore(
    sidebarSections?.subscribe ?? noSubscription,
    sidebarSections?.snapshot ?? noSections,
  );
  const channelNavigation = useChannelNavigation();
  const closeMuteMenu = useRef<(() => void) | undefined>(undefined);
  const muteRecovery =
    channelNavigation?.session === session
      ? channelNavigation.muteRecovery
      : undefined;
  useEffect(() => {
    if (!muteRecovery) return;
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
  }, [muteRecovery]);
  const preferences = useSyncExternalStore(
    session.sidebarPreferences.subscribe,
    session.sidebarPreferences.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const { layout: railLayout, reset: resetPlacement } =
    useRailLayout(partition);
  const [savedMessageView, setMessageView] = useActivityView(partition);
  // Team offers no agent views; a saved one shows All.
  const messageView = useMemo(
    () => withoutAgentViews(savedMessageView),
    [savedMessageView],
  );
  const { pins, setPinned } = useRailPins(partition);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useAgentChoices(session, true, true);
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
  );
  const navigation = useSyncExternalStore(
    directNavigator.subscribe,
    directNavigator.snapshot,
  );
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new visit cancels a previous person-open attempt.
  useEffect(() => {
    pending.current?.abort();
    pending.current = undefined;
    setOpening(undefined);
  }, [navigation.attempt.id]);
  useEffect(() => () => pending.current?.abort(), []);

  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          !channel.archived && !channel.huddle && !channel.metadataPending,
      ),
    [list.channels],
  );
  const channelsById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  );
  const channelEntries = useMemo(
    (): RailEntry[] =>
      channels.map((channel) => {
        const dm = channel.channelType === "dm";
        const other = dm ? channel.participants?.[0] : undefined;
        return {
          id: `channel:${channel.id}`,
          label: dm
            ? dmLabel(channel.participants, profiles, resolveName, channel.name)
            : channel.name,
          kind: dm
            ? "person"
            : channel.channelType === "solo"
              ? "chat"
              : "channel",
          picture: other ? profiles.get(other)?.picture : undefined,
          target: {
            version: 1,
            kind: "conversation",
            scope,
            channelId: channel.id,
          },
        };
      }),
    [channels, profiles, resolveName, scope],
  );
  const agentEntries = useMemo(
    (): RailEntry[] =>
      agents.selectable.filter(canMessageAgent).map((agent) => ({
        id: `agent:${agent.pubkey}`,
        label: agent.managedName ?? agent.name,
        picture: agent.avatar,
        kind: "agent",
        target: { kind: "person", pubkey: agent.pubkey },
      })),
    [agents.selectable],
  );
  const people = useMemo((): RailEntry[] => {
    void archives;
    // Only pinned people need labels while the picker is closed.
    const pinnedPeople = new Set(pins.map((pin) => pin.id));
    const knownAgents = new Set(agents.identities.map((agent) => agent.pubkey));
    return (
      picker
        ? [...profiles]
        : pins.flatMap((pin) => {
            if (pin.target.kind !== "person") return [];
            const profile = profiles.get(pin.target.pubkey);
            return profile ? [[pin.target.pubkey, profile] as const] : [];
          })
    )
      .filter(
        ([key, profile]) =>
          (picker || pinnedPeople.has(`person:${key}`)) &&
          key !== scope.viewer &&
          !profile.isAgent &&
          !profile.nameIsFallback &&
          !knownAgents.has(key) &&
          !archiveHides(session.archives, key, scope.viewer),
      )
      .map(([pubkey, profile]) => ({
        id: `person:${pubkey}`,
        label: resolveName(pubkey, profile.name),
        kind: "person",
        picture: profile.picture,
        target: { kind: "person", pubkey },
      }));
  }, [
    picker,
    pins,
    profiles,
    agents.identities,
    session.archives,
    archives,
    scope.viewer,
    resolveName,
  ]);
  const pageEntries = useMemo(
    (): RailEntry[] =>
      pages.map((page) => ({
        id: page.key,
        label: page.title === "Channels" ? "Team" : page.title,
        kind: "page",
        target: {
          version: 1,
          kind: "page",
          pluginId: page.pluginId,
          pageId: page.id,
          scope,
        },
      })),
    [pages, scope],
  );
  const entries = useMemo(
    () => [...channelEntries, ...agentEntries, ...people, ...pageEntries],
    [channelEntries, agentEntries, people, pageEntries],
  );
  const byId = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const pinned = new Set(pins.map((pin) => pin.id));
  const togglePin = (entry: RailEntry, nextPinned = !pinned.has(entry.id)) => {
    const saved = resetPlacement(entry.id) && setPinned(entry, nextPinned);
    setError(
      saved ? undefined : "Couldn’t save pins on this device. Try again.",
    );
    return saved;
  };
  const open = async (entry: RailEntry, navigator: Navigation) => {
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
      : targetKey(entry.target) === targetKey(target);
  };
  const artwork = (entry: RailEntry, avatarOnly = false, feed = false) => (
    <RailEntryArtwork
      entry={entry}
      avatarOnly={avatarOnly}
      size={feed ? "fill" : "compact"}
      selected={isSelected(entry)}
      session={session}
      channelsById={channelsById}
      profiles={profiles}
      resolveName={resolveName}
      identities={agents.identities}
      agentEntries={agentEntries}
    />
  );
  const soloChats = useMemo(
    () =>
      channels
        .filter((channel) => channel.channelType === "solo")
        .sort(
          (a, b) =>
            (b.lastActivityAt ?? b.createdAt ?? b.updatedAt ?? 0) -
              (a.lastActivityAt ?? a.createdAt ?? a.updatedAt ?? 0) ||
            a.id.localeCompare(b.id),
        ),
    [channels],
  );
  const visited = navigation.entry.target;
  const currentChannel =
    visited.kind === "conversation"
      ? channels.find((channel) => channel.id === visited.channelId)
      : undefined;
  const activeDockSection =
    selectedSection ??
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
        ? "messages"
        : "navigation");
  const current = entries.find(
    (entry) =>
      entry.target.kind !== "person" &&
      targetKey(entry.target) === targetKey(navigation.entry.target),
  ) ?? {
    id: `view:${targetKey(navigation.entry.target)}`,
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
  const view = (pageSection: string | undefined, list?: ReactNode) => {
    const navigator = pageSection ? listNavigator : directNavigator;
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
        onClick: () => void open(entry, navigator),
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
      content: row(
        entry,
        (section === "pins" || section === "agents") && pageSection !== section,
      ),
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
    if (pageSection === "messages" || pageSection === "solo") {
      const membership = railSections(
        railLayout,
        contributed.map((section) => ({
          id: section.key,
          title: section.title,
        })),
      );
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
    /** Unread conversations in one Team view; nothing when all are read. */
    const teamCount = (filter: ActivityView["filter"]) => {
      const counted = { ...messageView, filter, unread: true };
      return (
        <ConversationList
          session={session}
          navigator={navigator}
          scope={scope}
          target={navigation.entry.target}
          view={counted}
          // A list keeps its open row under Unread only; a count does not.
          isOpen={() => false}
          includeChannel={(channel) => includeMessagesChannel(channel, counted)}
          renderEntries={(items) =>
            items.length ? (
              <CountBadge
                count={items.length}
                label={`${items.length} unread conversation${items.length === 1 ? "" : "s"}`}
              />
            ) : null
          }
        />
      );
    };
    const activityPage = teamPages.find(
      (page) => page.key === "buzz.inbox/inbox",
    );
    const activityEntry = activityPage && byId.get(activityPage.key);
    const teamViews: {
      filter: ActivityView["filter"];
      label: string;
      icon: ReactElement;
    }[] = [
      {
        filter: "threads",
        label: "Threads",
        icon: <MessageReplyIcon size={18} />,
      },
      { filter: "dms", label: "DMs", icon: <UsersIcon size={18} /> },
      { filter: "mentions", label: "Mentions", icon: <AtIcon size={18} /> },
      { filter: "channels", label: "Channels", icon: <HashIcon size={18} /> },
    ];
    const teamOpen = routedSection(navigation.entry.target) === "messages";
    const messageCard = (
      <RailGroup
        id="messages"
        title="Team"
        rows={[
          ...(activityEntry
            ? [
                {
                  entry: activityEntry,
                  content: (
                    <NavigationItem
                      label="Activity"
                      icon={<ChatCircleIcon size={18} />}
                      trailing={teamCount("all")}
                      selected={selected === "buzz.inbox/inbox"}
                      onClick={() => onSelect("buzz.inbox/inbox")}
                    />
                  ),
                },
              ]
            : []),
          ...teamPages.filter((page) => page !== activityPage).flatMap(pageRow),
        ]}
        leadingEntryIds={["buzz.inbox/inbox"]}
        views={teamViews.map((item) => (
          <NavigationItem
            key={item.filter}
            label={item.label}
            icon={item.icon}
            trailing={teamCount(item.filter)}
            data-rail-team-view={item.filter}
            selected={teamOpen && messageView.filter === item.filter}
            onClick={() => {
              setMessageView({ ...messageView, filter: item.filter });
              void directNavigator.open(
                sidebarSectionTarget(scope, "messages"),
              );
            }}
          />
        ))}
        pageContent={sectionPage}
        // Drafts and sent stays under the views, ahead of what a person adds.
        sortEntries={(a, b) =>
          Number(b.id === "buzz.drafts-and-sent/drafts-sent") -
          Number(a.id === "buzz.drafts-and-sent/drafts-sent")
        }
        action={creationAction}
      />
    );
    return (
      <RailArrangement
        key={partition}
        partition={partition}
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
        list={list}
        compact={!pageSection && compact}
        selectedSection={activeDockSection}
        openSection={(id) => {
          // A section a person made has no page of its own: open its first
          // conversation beside its list.
          const first =
            id === "messages" || id === "solo"
              ? undefined
              : railSections(
                  railLayout,
                  contributed.map((section) => ({
                    id: section.key,
                    title: section.title,
                  })),
                )
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
          if (section === "pins" || section === "agents")
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
          if (
            channelNavigation?.session !== session ||
            !session.sidebarPreferences.muteWritable ||
            !preferences.data
          )
            return null;
          const destination = entry.target;
          const channel =
            destination.kind === "conversation"
              ? channelsById.get(destination.channelId)
              : undefined;
          if (!channel) return null;
          const intent = channelNavigation.mute.intents.get(channel.id);
          const muted = intent?.pending
            ? intent.muted
            : preferences.data.muted.includes(channel.id);
          return (
            <MenuItem
              disabled={intent?.pending}
              onClick={() => {
                closeMuteMenu.current = close;
                channelNavigation.mute.change(channel.id, channel.name, !muted);
                close();
                focus();
              }}
            >
              {muted ? "Unmute" : "Mute"}
            </MenuItem>
          );
        }}
        sections={[
          {
            id: "navigation",
            title: "Plugins",
            icon: <StorefrontIcon size={22} />,
            content: (
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
            ),
          },
          {
            id: "pins",
            title: "Pins",
            icon: <PinIcon size={22} />,
            content: (
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
                {!pins.length &&
                  !railLayout.placements.some(
                    (item) => item.section === "pins",
                  ) && (
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
            ),
          },
          {
            id: "messages",
            title: "Team",
            icon: <ChatCircleIcon size={22} />,
            content: messageCard,
          },
          {
            id: "solo",
            title: "Solo",
            icon: <UserIcon size={22} />,
            content: (
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
                    onClick={() =>
                      void navigator.open(soloDraftTarget(session.scope))
                    }
                  />
                }
              >
                {!soloChats.length && (
                  <p className={styles.note}>No Solo chats yet.</p>
                )}
              </RailGroup>
            ),
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
      {view(
        undefined,
        listColumn?.slot &&
          createPortal(
            <CollectionCreationAction
              value={
                <IconButton
                  aria-label="New message"
                  title="New message"
                  icon={<PlusIcon size={20} aria-hidden="true" />}
                  onClick={() =>
                    void listNavigator.open(
                      listColumn.section === "solo"
                        ? soloDraftTarget(session.scope)
                        : {
                            version: 1,
                            kind: "page",
                            pluginId: "buzz.channels",
                            pageId: "channels",
                            scope,
                            route: { version: 1, params: "compose" },
                          },
                    )
                  }
                />
              }
            >
              {view(listColumn.section)}
            </CollectionCreationAction>,
            listColumn.slot,
          ),
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

const noSubscription = () => () => {};
const pluginCatalog: RailEntry = {
  id: "settings:plugins",
  label: "Plugins",
  kind: "page",
  target: { version: 1, kind: "settings", section: "plugins" },
};
const emptySections: readonly import("../../features/channel-navigation/sidebar-sections-service").RegisteredSidebarSection[] =
  [];
const noSections = () => emptySections;
