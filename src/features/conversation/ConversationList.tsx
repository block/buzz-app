/**
 * Shared conversation inventory for a section's list.
 * The session owns message projections; this list owns filtering and ordering.
 * Hosts choose how rows open and which conversation remains selected.
 */
import {
  createContext,
  useContext,
  useCallback,
  type ReactNode,
  type RefCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import { useChannelList } from "../../features/relay/react";
import { useUnreadState } from "../../bundled/channels/UnreadBadge";
import {
  conversationIndex,
  useConversationEvent,
  useConversationKeys,
  useConversationRecord,
  type ConversationEvent,
  type ConversationQuery,
} from "./conversation-index";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import { ChannelAvatar } from "../channels/ChannelAvatar";
import { messagePreview } from "../../features/notifications/content";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { ConversationRow } from "../../features/messages/ConversationRow";
import {
  AtIcon,
  Filter2Icon,
  HashIcon,
  LockIcon,
  MessageReplyIcon,
  UsersIcon,
  ChatCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  SmileyIcon,
} from "../../shared/design-system/icons/index";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { HeaderIcon } from "../../shared/design-system/ui/HeaderIcon";
import { Header } from "../../shared/design-system/ui/Header";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuPopup,
  MenuGroupLabel,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  readView,
  writeView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import styles from "./ConversationList.module.css";
import feedStyles from "./FeedList.module.css";
import {
  useVisibleChannelPreviews,
  type LatestMessage,
} from "./latest-previews";
import { useIdentityNames } from "../../features/identity-names/react";
import { dmLabel } from "./dm-label";
import { reactionRows } from "./reaction-rows";
import type { ReadTarget } from "../relay/read-state-model";
import { ReactionRow } from "./ReactionRow";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

export type ActivityView = {
  filter:
    | "all"
    | "threads"
    | "dms"
    | "mentions"
    | "channels"
    | "working"
    | "waiting"
    | "reactions";
  unread: boolean;
  sort?: "recent" | "alpha";
};
type View = ActivityView;

export const conversationViews = [
  {
    value: "all",
    label: "All",
    icon: <ChatCircleIcon size={20} aria-hidden="true" />,
  },
  {
    value: "threads",
    label: "Threads",
    icon: <MessageReplyIcon size={20} aria-hidden="true" />,
  },
  {
    value: "dms",
    label: "DMs",
    icon: <UsersIcon size={20} aria-hidden="true" />,
  },

  {
    value: "mentions",
    label: "Mentions",
    icon: <AtIcon size={20} aria-hidden="true" />,
  },
  {
    value: "channels",
    label: "Channels",
    icon: <HashIcon size={20} aria-hidden="true" />,
  },
  {
    value: "working",
    label: "Working",
    icon: <CircleNotchIcon size={20} aria-hidden="true" />,
  },
  {
    value: "waiting",
    label: "Waiting",
    icon: <ClockIcon size={20} aria-hidden="true" />,
  },
  {
    value: "reactions",
    label: "Reactions",
    icon: <SmileyIcon size={20} aria-hidden="true" />,
  },
] as const;
/** Working and Waiting describe agents' chats, so only Solo offers them. */
const agentView = (filter: View["filter"]) =>
  filter === "working" || filter === "waiting";
/** DMs, Mentions and Channels describe Team's conversations; Solo has none. */
const teamView = (filter: View["filter"]) =>
  filter === "dms" || filter === "mentions" || filter === "channels";
const viewsFor = (agentViews: boolean) =>
  conversationViews.filter(
    (item) => !(agentViews ? teamView : agentView)(item.value),
  );
/** The view a list without the agent views shows for a saved one. */
export const withoutAgentViews = (view: ActivityView): ActivityView =>
  agentView(view.filter) ? { ...view, filter: "all" } : view;
/** The view Solo's list shows for a saved one. */
export const withoutTeamViews = (view: ActivityView): ActivityView =>
  teamView(view.filter) ? { ...view, filter: "all" } : view;
const viewKey = "activity-sidebar:view:v5";

function readSavedView(scope: string): View {
  const saved = readView<Partial<View> | null>(scope, viewKey, null);
  return {
    ...(saved?.sort === "alpha" && { sort: "alpha" as const }),
    filter:
      saved?.filter === "threads" ||
      saved?.filter === "dms" ||
      saved?.filter === "mentions" ||
      saved?.filter === "channels" ||
      saved?.filter === "working" ||
      saved?.filter === "waiting" ||
      saved?.filter === "reactions"
        ? saved.filter
        : // Direct was DMs and mentions together.
          (saved?.filter as string | undefined) === "direct"
          ? "dms"
          : "all",
    unread: saved?.unread === true,
  };
}

/** All keeps Solo in its own collection; explicit agent/direct views may include it. */
export function includeMessagesChannel(
  channel: ChannelSummary,
  view: ActivityView,
) {
  return view.filter !== "all" || channel.channelType !== "solo";
}

/** Conversation identity follows the roster, never the most recent sender. */
const conversationPeople = (
  channel: ChannelSummary,
  viewer: string | undefined,
) =>
  [
    ...new Set(
      channel.channelType === "dm"
        ? (channel.participants ?? channel.members ?? [])
        : (channel.members ?? []),
    ),
  ]
    .filter((id) => id !== viewer)
    .slice(0, 3);

export function useActivityView(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(scope, listener),
    [scope],
  );
  const snapshot = useCallback(() => viewRevision(scope, viewKey), [scope]);
  const revision = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [saved, setSaved] = useState(() => ({
    scope,
    revision,
    view: readSavedView(scope),
  }));
  let view = saved.view;
  if (saved.scope !== scope || saved.revision !== revision) {
    view = readSavedView(scope);
    setSaved({ scope, revision, view });
  }
  const setView = useCallback(
    (view: View) => {
      writeView(scope, viewKey, view);
      // A failed save still leaves this control usable in memory.
      setSaved({ scope, revision: viewRevision(scope, viewKey), view });
    },
    [scope],
  );
  return [view, setView] as const;
}

/** The collection host supplies its existing draft action to the list heading. */
export const CollectionCreationAction = createContext<ReactNode>(null);

/** Collection controls share one menu; compact sidebar controls keep Show only. */
export function ConversationFiltersMenu({
  view,
  onChange,
  sort = false,
  views = false,
  agentViews = false,
  label,
  variant = "glass",
}: {
  view: View;
  onChange(view: View): void;
  sort?: boolean;
  views?: boolean;
  agentViews?: boolean;
  label?: string;
  variant?: "glass" | "ghost";
}) {
  const showLabel =
    label ??
    (sort
      ? "Filter and sort conversations"
      : view.unread
        ? "Showing unread"
        : "Showing all");
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            size="sm"
            variant={variant}
            shape="round"
            aria-label={showLabel}
            title={showLabel}
            icon={<Filter2Icon aria-hidden="true" size={16} />}
          />
        }
      />
      <MenuPopup
        aria-label={sort ? "Filter and sort conversations" : "Show"}
        size="compact"
      >
        {views && (
          <>
            <MenuRadioGroup
              aria-label="Conversation view"
              value={view.filter}
              onValueChange={(filter) => {
                const choice = conversationViews.find(
                  (item) => item.value === filter,
                );
                if (choice) onChange({ ...view, filter: choice.value });
              }}
            >
              <MenuGroupLabel>View</MenuGroupLabel>
              {viewsFor(agentViews).map(({ value, label }) => (
                <MenuRadioItem key={value} value={value} closeOnClick>
                  {label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        )}
        <MenuRadioGroup
          aria-label="Show conversations"
          value={view.unread ? "unread" : "all"}
          onValueChange={(value) =>
            onChange({ ...view, unread: value === "unread" })
          }
        >
          {sort && <MenuGroupLabel>Show</MenuGroupLabel>}
          <MenuRadioItem value="all" closeOnClick>
            All conversations
          </MenuRadioItem>
          <MenuRadioItem value="unread" closeOnClick>
            Unread only
          </MenuRadioItem>
        </MenuRadioGroup>
        {sort && (
          <>
            <MenuSeparator />
            <MenuRadioGroup
              aria-label="Conversation sort order"
              value={view.sort ?? "recent"}
              onValueChange={(value) => {
                if (value === "recent" || value === "alpha")
                  onChange({ ...view, sort: value });
              }}
            >
              <MenuGroupLabel>Sort</MenuGroupLabel>
              <MenuRadioItem value="recent" closeOnClick>
                Recent activity
              </MenuRadioItem>
              <MenuRadioItem value="alpha" closeOnClick>
                A–Z
              </MenuRadioItem>
            </MenuRadioGroup>
          </>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}

/** Small-button views of one combined conversation inventory. */
export function ActivityFilters({
  view,
  onChange,
  creationAction,
  layout = "sidebar",
  title,
  agentViews = false,
}: {
  view: View;
  onChange(view: View): void;
  creationAction?: ReactNode;
  layout?: "sidebar" | "collection";
  title?: string;
  agentViews?: boolean;
}) {
  const tabs = (
    <Tabs
      label="Conversation view"
      variant="buttons"
      leadingAction={
        layout === "sidebar" ? (
          creationAction
        ) : (
          <ConversationFiltersMenu view={view} onChange={onChange} sort />
        )
      }
      trailingAction={
        layout === "sidebar" ? (
          <ConversationFiltersMenu view={view} onChange={onChange} />
        ) : undefined
      }
      value={view.filter}
      items={viewsFor(agentViews)}
      onValueChange={(filter) => onChange({ ...view, filter })}
    />
  );
  return layout === "collection" ? (
    <CollectionFilters
      title={
        title ??
        (view.filter === "all"
          ? "Team"
          : (conversationViews.find((item) => item.value === view.filter)
              ?.label ?? "Team"))
      }
      actions={creationAction}
    >
      {tabs}
    </CollectionFilters>
  ) : (
    <div className={styles.filters} data-layout={layout}>
      {tabs}
    </div>
  );
}

/** One collection heading and aligned view strip for Messages and Activity. */
export function CollectionFilters({
  title,
  icon,
  actions,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const collectionCreation = useContext(CollectionCreationAction);
  return (
    <div className={styles.filters} data-layout="collection">
      <Header
        title={title}
        icon={icon ? <HeaderIcon>{icon}</HeaderIcon> : undefined}
        level={2}
        actions={actions ?? collectionCreation}
      />
      {children}
    </div>
  );
}

export type ConversationListEntry = {
  key: string;
  label: string;
  at: number;
  target: Extract<OpenTarget, { kind: "conversation" }>;
};

type Layout = "sidebar" | "feed" | "navigation";
type Open = (
  channelId: string,
  options?: { messageId?: string; threadRootId?: string },
) => void;
const noRows: ConversationQuery = { filter: "reactions", unread: false };

export function ConversationList({
  session,
  navigator,
  scope,
  target,
  view,
  onOpen,
  isOpen,
  includeAuthor,
  layout = "sidebar",
  includeChannel,
  wrapRow,
}: {
  session: RelaySession;
  navigator: Navigation;
  /** Navigation scope of this community. */
  scope: NavigationScope;
  target: OpenTarget;
  view: View;
  onOpen?:
    | ((target: {
        channelId: string;
        messageId?: string;
        threadId?: string;
      }) => boolean)
    | undefined;
  includeAuthor?: ((authorId: string) => boolean) | undefined;
  /** A sheet host owns selection while its page route remains active. */
  isOpen?:
    | ((target: { channelId: string; threadId?: string }) => boolean)
    | undefined;
  layout?: Layout;
  includeChannel?: ((channel: ChannelSummary) => boolean) | undefined;
  /** Keep host-owned row context actions around the shared feed renderer. */
  wrapRow?:
    | ((entry: ConversationListEntry, row: ReactNode) => ReactNode)
    | undefined;
}) {
  const index = conversationIndex(session);
  useEffect(() => session.channels.ensureList(), [session]);
  const ready = useSyncExternalStore(
    session.channels.subscribeList,
    () => session.channels.list().status === "ready",
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const selectedChannel =
    target.kind === "conversation" ? target.channelId : undefined;
  const selectedThread =
    target.kind === "conversation" ? target.threadRootId : undefined;
  const isSelected = (channelId: string, threadId?: string) =>
    isOpen
      ? isOpen({ channelId, ...(threadId ? { threadId } : {}) })
      : selectedChannel === channelId && selectedThread === threadId;

  const openNow: Open = (channelId, options = {}) => {
    if (
      onOpen?.({
        channelId,
        ...(options.messageId && { messageId: options.messageId }),
        ...(options.threadRootId && { threadId: options.threadRootId }),
      })
    )
      return;
    void navigator.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      // A thread opens on its own; its header offers the channel beside it.
      ...(options.threadRootId
        ? { threadRootId: options.threadRootId, context: "thread" as const }
        : {}),
    });
  };
  // Rows keep one handler for as long as they are mounted.
  const opener = useRef(openNow);
  useLayoutEffect(() => {
    opener.current = openNow;
  });
  const open = useCallback<Open>(
    (channelId, options) => opener.current(channelId, options),
    [],
  );

  const unreadOnly = view.unread;
  const filter = view.filter;
  // This render's question. Its functions close over this render's selection
  // and names, so the index answers it afresh.
  const query: ConversationQuery = {
    filter,
    unread: unreadOnly,
    sort: view.sort,
    include: includeChannel,
    includeAuthor,
    // Opening a conversation quiets its row at once; Unread keeps it listed.
    keep: (channelId) => isSelected(channelId),
    label: (channel) => channelLabel(channel, profiles, resolveName),
  };
  const keys = useConversationKeys(session, query);
  const order = useFrozenOrder(keys.join("\n"));
  // Waiting and a sender filter judge the latest author of every candidate,
  // shown or not, so each needs its preview.
  const authors = filter === "waiting" || !!includeAuthor;
  const candidates = useConversationKeys(
    session,
    !authors
      ? noRows
      : filter === "waiting" || filter === "working"
        ? {
            filter: "all",
            unread: false,
            include: (channel) =>
              channel.channelType === "solo" &&
              (!includeChannel || includeChannel(channel)),
          }
        : { filter, unread: false, include: includeChannel },
  );
  const { observe: previewRef } = useVisibleChannelPreviews(
    session,
    candidates.flatMap((key) => (key.startsWith("c:") ? [key.slice(2)] : [])),
  );

  // The people these rows name and picture.
  const people = useSyncExternalStore(index.subscribe, () => {
    const ids = new Set<string>(session.viewer ? [session.viewer] : []);
    let events = 0;
    for (const key of index.view(query)) {
      if (key.startsWith("e:")) {
        const event = events++ < 100 ? index.event(key.slice(2)) : undefined;
        if (event) ids.add(event.authorId);
        continue;
      }
      const record = index.record(key.slice(2));
      if (!record) continue;
      const { channel, kind } = record;
      if (kind === "dm")
        for (const id of channel.participants ?? []) ids.add(id);
      if (kind !== "team")
        for (const id of conversationPeople(channel, session.viewer))
          ids.add(id);
      if (record.latest?.authorId) ids.add(record.latest.authorId);
      if (record.thread) ids.add(record.thread.authorId);
    }
    return [...ids].sort().join(":");
  });
  useEffect(() => {
    if (people && ready)
      void session.profiles
        .ensure(people.split(":"), "background")
        .catch(() => {});
  }, [session, people, ready]);
  const nameOf = useCallback(
    (id: string) =>
      resolveName(
        id,
        profiles.get(id)?.name ?? formatPublicKey(id) ?? "Someone",
      ),
    [resolveName, profiles],
  );

  if (filter === "reactions")
    return (
      <div className={styles.activity} data-activity-sidebar="">
        <ReactionList
          session={session}
          layout={layout}
          includeChannel={includeChannel}
          includeAuthor={includeAuthor}
          profiles={profiles}
          resolveName={resolveName}
          isSelected={(channelId, messageId) =>
            target.kind === "conversation" &&
            target.channelId === channelId &&
            target.messageId === messageId
          }
          onOpen={open}
        />
      </div>
    );
  return (
    <div className={styles.activity} data-activity-sidebar="">
      <ul
        className={layout === "feed" ? feedStyles.list : styles.rows}
        aria-label="Conversations"
      >
        {order.map((key) =>
          key.startsWith("e:") ? (
            <EventRow
              key={key}
              id={key.slice(2)}
              session={session}
              scope={scope}
              layout={layout}
              profiles={profiles}
              nameOf={nameOf}
              unreadOnly={unreadOnly}
              isSelected={isSelected}
              onOpen={open}
              wrapRow={wrapRow}
            />
          ) : (
            <IndexedRow
              key={key}
              id={key.slice(2)}
              previewRef={previewRef}
              wrapRow={wrapRow}
              scope={scope}
              layout={layout}
              session={session}
              profiles={profiles}
              nameOf={nameOf}
              resolveName={resolveName}
              unreadOnly={unreadOnly}
              selected={isSelected(key.slice(2))}
              onOpen={open}
            />
          ),
        )}
      </ul>
      {ready && !keys.length && (
        <EmptyState
          frame="none"
          icon={conversationViews.find((item) => item.value === filter)?.icon}
          title={
            unreadOnly
              ? "All caught up"
              : filter === "threads"
                ? "No thread activity yet"
                : filter === "dms"
                  ? "No DMs yet"
                  : filter === "mentions"
                    ? "No mentions yet"
                    : filter === "working"
                      ? "No agent is working right now"
                      : filter === "waiting"
                        ? "Nothing is waiting on you"
                        : "Nothing here yet"
          }
          description={unreadOnly ? "Nothing unread in this view." : undefined}
        />
      )}
    </div>
  );
}

const channelLabel = (
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
  resolveName: ReturnType<typeof useIdentityNames>,
) =>
  channel.channelType === "dm"
    ? dmLabel(channel.participants, profiles, resolveName, channel.name)
    : channel.name;

/** A conversation's row, drawn from its own record in the index. */
const IndexedRow = memo(function IndexedRow({
  id,
  ...row
}: { id: string } & Omit<
  Parameters<typeof ChannelActivityRow>[0],
  "channel" | "at" | "latest" | "team" | "working" | "label"
>) {
  const record = useConversationRecord(row.session, id);
  return record ? (
    <ChannelActivityRow
      {...row}
      label={channelLabel(record.channel, row.profiles, row.resolveName)}
      channel={record.channel}
      at={record.at}
      latest={record.latest}
      team={record.kind === "team"}
      working={record.working}
    />
  ) : null;
});

/** A thread or mention: a message, opened where it lives. */
function EventRow({
  id,
  session,
  scope,
  layout,
  profiles,
  nameOf,
  unreadOnly,
  isSelected,
  onOpen,
  wrapRow,
}: {
  id: string;
  session: RelaySession;
  scope: NavigationScope;
  layout: Layout;
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  unreadOnly: boolean;
  isSelected(channelId: string, threadId?: string): boolean;
  onOpen: Open;
  wrapRow?:
    | ((entry: ConversationListEntry, row: ReactNode) => ReactNode)
    | undefined;
}) {
  const notify = useToastNotification();
  const event = useConversationEvent(session, id);
  const channel = useConversationRecord(
    session,
    event?.channelId ?? "",
  )?.channel;
  if (!event) return null;
  const name = nameOf(event.authorId);
  const profile = profiles.get(event.authorId);
  const content = (
    <ConversationRow
      layout={layout}
      selected={!!event.rootId && isSelected(event.channelId, event.rootId)}
      onClick={() =>
        onOpen(event.channelId, {
          messageId: event.messageId,
          ...(event.rootId ? { threadRootId: event.rootId } : {}),
        })
      }
      onPointerEnter={() => session.channels.prepare?.(event.channelId)}
      onFocus={() => session.channels.prepare?.(event.channelId)}
      avatar={
        <Avatar
          size="fill"
          alt=""
          fallback={name}
          src={avatarMedia(profile?.picture, session.media)}
          shape={profile?.isAgent ? "squircle" : "circle"}
        />
      }
      placeIcon={
        event.rootId ? (
          <MessageReplyIcon size={14} aria-label="Thread" />
        ) : (
          privateIcon(channel)
        )
      }
      place={
        layout === "navigation"
          ? `${channel ? `${channelText(channel)} · ` : ""}${messagePreview(event.preview)}`
          : channel
            ? `${event.rootId ? "in " : ""}${channelText(channel)}`
            : ""
      }
      time={shortTime(event.createdAt)}
      preview={messagePreview(event.preview)}
      state={event.unread ? "unread" : "read"}
      onMarkRead={() =>
        void markEventRead(session, event).then(() => {
          if (unreadOnly) offerUndo(notify, session, eventTarget(event));
        })
      }
    />
  );
  return (
    <li className={layout === "feed" ? feedStyles.item : undefined}>
      {wrapRow
        ? wrapRow(
            {
              key: `e:${event.key}`,
              label: `${channel?.name ?? name} · ${messagePreview(event.preview)}`,
              at: event.createdAt,
              target: {
                version: 1,
                kind: "conversation",
                scope,
                channelId: event.channelId,
                messageId: event.messageId,
                ...(event.rootId && {
                  threadRootId: event.rootId,
                  context: "thread" as const,
                }),
              },
            },
            content,
          )
        : content}
    </li>
  );
}

/** Sidebar-width recency, as the Activity card abbreviates it. */
export function shortTime(unixSeconds: number, nowSeconds = Date.now() / 1000) {
  const age = Math.max(0, nowSeconds - unixSeconds);
  if (age < 60) return "now";
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  if (age < 604800) return `${Math.floor(age / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Keeps rows where they are while the pointer or keyboard is in the list, so a
 * new message doesn't move a row out from under a click. New rows go at the end.
 */
function useFrozenOrder(key: string) {
  const [frozen, setFrozen] = useState(false);
  const held = useRef<readonly string[]>([]);
  useEffect(() => {
    const thaw = () => setFrozen(false);
    const onPointer = (event: PointerEvent) =>
      setFrozen(
        event.target instanceof Element &&
          !!event.target.closest("[data-activity-sidebar]"),
      );
    const onFocus = () =>
      setFrozen(!!document.activeElement?.closest("[data-activity-sidebar]"));
    document.addEventListener("pointerover", onPointer);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("blur", thaw);
    return () => {
      document.removeEventListener("pointerover", onPointer);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("blur", thaw);
    };
  }, []);
  return useMemo(() => {
    const next = key ? key.split("\n") : [];
    if (!frozen) {
      held.current = next;
      return next;
    }
    const present = new Set(next);
    const kept = held.current.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    held.current = [...kept, ...next.filter((id) => !keptSet.has(id))];
    return held.current;
  }, [frozen, key]);
}

/** Renders again only when its own conversation's evidence or state changes. */
export const ChannelActivityRow = memo(function ChannelActivityRow({
  previewRef,
  wrapRow,
  scope,
  label,
  layout,
  session,
  channel,
  at,
  latest,
  team,
  working,
  profiles,
  nameOf,
  resolveName,
  unreadOnly,
  selected,
  onOpen,
}: {
  previewRef?: RefCallback<HTMLLIElement> | undefined;
  /** A stable host wrapper; the row describes itself to it. */
  wrapRow?:
    | ((entry: ConversationListEntry, row: ReactNode) => ReactNode)
    | undefined;
  /** With wrapRow: where this row opens and what the host calls it. */
  scope?: NavigationScope | undefined;
  label?: string | undefined;
  layout: "sidebar" | "feed" | "navigation";
  session: RelaySession;
  channel: ChannelSummary;
  at: number;
  latest: LatestMessage | undefined;
  team: boolean;
  /** An agent is on it: the typing dots take the state slot. */
  working: boolean;
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  resolveName: ReturnType<typeof useIdentityNames>;
  unreadOnly: boolean;
  selected: boolean;
  onOpen(channelId: string): void;
}) {
  const notify = useToastNotification();
  const dm = channel.channelType === "dm";
  const state = useUnreadState(session, channel.id, dm);
  const threadUnread = (state.activity.items ?? []).some(
    (item) => item.unreadCount > 0,
  );
  const unread = state.unread || threadUnread;
  if (unreadOnly && !unread && !selected) return null;
  const solo = channel.channelType === "solo";
  const people = dm || solo ? conversationPeople(channel, session.viewer) : [];
  // The latest event: a thread reply you're in, when it is newer.
  const thread = team ? newestThread(session, channel) : undefined;
  const replyIsNewest = !!thread && thread.createdAt > (latest?.createdAt ?? 0);
  const preview = replyIsNewest
    ? messagePreview(thread.preview)
    : latest
      ? messagePreview(latest.content)
      : channel.preview
        ? messagePreview(channel.preview)
        : "";
  const poster =
    dm || solo ? undefined : replyIsNewest ? thread.authorId : latest?.authorId;
  const content = (
    <ConversationRow
      layout={layout}
      aria-current={selected ? "page" : undefined}
      selected={selected}
      onClick={() => onOpen(channel.id)}
      onPointerEnter={() => session.channels.prepare?.(channel.id)}
      onFocus={() => session.channels.prepare?.(channel.id)}
      avatar={
        people.length ? (
          <AvatarStack
            size={layout === "navigation" ? "compact" : "cluster"}
            items={people.map((id) => ({
              id,
              name: nameOf(id),
              src: avatarMedia(profiles.get(id)?.picture, session.media),
              shape: profiles.get(id)?.isAgent ? "squircle" : "circle",
            }))}
          />
        ) : poster ? (
          // A channel shows who posted last, not its initials.
          <Avatar
            size="fill"
            alt=""
            shape={profiles.get(poster)?.isAgent ? "squircle" : "circle"}
            fallback={nameOf(poster)}
            src={avatarMedia(profiles.get(poster)?.picture, session.media)}
          />
        ) : !dm && !solo ? (
          <ChannelAvatar size="fill" shape="squircle" name={channel.name} />
        ) : (
          <Avatar
            size="fill"
            alt=""
            shape="squircle"
            fallback={channel.name}
            fallbackContent={<UsersIcon size={16} aria-hidden="true" />}
          />
        )
      }
      placeIcon={privateIcon(channel)}
      place={
        dm
          ? dmLabel(
              channel.participants,
              profiles,
              resolveName,
              channel.name || "Direct message",
            )
          : solo || layout === "navigation"
            ? channel.name
            : channelText(channel)
      }
      time={at ? shortTime(at) : ""}
      preview={preview}
      state={working ? "working" : unread ? "unread" : "read"}
      onMarkRead={() =>
        void session.unread.markChannelRead(channel.id).then(
          () => {
            // Under Unread the row leaves the list, so its read can be undone.
            if (unreadOnly && !selected)
              offerUndo(notify, session, {
                kind: "channel",
                channelId: channel.id,
              });
          },
          () => {},
        )
      }
    />
  );
  return (
    <li
      ref={previewRef}
      data-activity-row={channel.id}
      className={layout === "feed" ? feedStyles.item : undefined}
    >
      {wrapRow && scope
        ? wrapRow(
            {
              key: `c:${channel.id}`,
              label: label ?? channel.name,
              at,
              target: {
                version: 1,
                kind: "conversation",
                scope,
                channelId: channel.id,
              },
            },
            content,
          )
        : content}
    </li>
  );
});

/** The newest thread you're in, in a Team channel: its latest reply. */
function newestThread(session: RelaySession, channel: ChannelSummary) {
  let newest:
    | NonNullable<
        ReturnType<RelaySession["unread"]["activity"]>["items"]
      >[number]
    | undefined;
  for (const item of session.unread.activity(channel.id).items ?? [])
    if (!newest || item.createdAt > newest.createdAt) newest = item;
  return newest;
}

/** Only a private channel needs a glyph; its name carries no "#". */
function privateIcon(channel: ChannelSummary | undefined) {
  return channel &&
    channel.channelType !== "dm" &&
    channel.channelType !== "solo" &&
    channelIcon(channel) === LockIcon ? (
    <LockIcon size={14} aria-label="Private channel" />
  ) : undefined;
}

/** A thread row reads through its latest reply; a top-level mention reads
 * just that message. */
const eventTarget = (event: ConversationEvent): ReadTarget =>
  event.rootId
    ? { kind: "thread", channelId: event.channelId, rootId: event.rootId }
    : {
        kind: "message",
        channelId: event.channelId,
        messageId: event.messageId,
      };

/** Unread again on this device; saved read state is not rewound. */
function offerUndo(
  notify: ReturnType<typeof useToastNotification>,
  session: RelaySession,
  target: ReadTarget,
) {
  notify("Marked as read", "success", {
    label: "Undo",
    onClick: () =>
      void session.unread
        .markUnreadLocal(target)
        .catch(() => notify("Couldn't mark unread", "error")),
  });
}

/** Reactions to your messages: context, never unread and never marked read. */
function ReactionList({
  session,
  layout,
  includeChannel,
  includeAuthor,
  profiles,
  resolveName,
  isSelected,
  onOpen,
}: {
  session: RelaySession;
  layout: Layout;
  includeChannel?: ((channel: ChannelSummary) => boolean) | undefined;
  includeAuthor?: ((authorId: string) => boolean) | undefined;
  profiles: ReadonlyMap<string, Profile>;
  resolveName: ReturnType<typeof useIdentityNames>;
  isSelected(channelId: string, messageId: string): boolean;
  onOpen(
    channelId: string,
    options: { messageId?: string; threadRootId?: string },
  ): void;
}) {
  const reactions = session.inboxFeed.reactions;
  const feed = useSyncExternalStore(
    reactions.subscribe,
    reactions.snapshot,
    reactions.snapshot,
  );
  useEffect(() => {
    void reactions.ensure();
  }, [reactions]);
  const channels = new Map(
    useChannelList(session.channels).channels.map((channel) => [
      channel.id,
      channel,
    ]),
  );
  const rows = reactionRows(
    feed.items.filter((item) => {
      const channel = channels.get(item.channelId);
      return (
        !!channel &&
        !channel.archived &&
        !channel.huddle &&
        !channel.metadataPending &&
        (!includeChannel || includeChannel(channel))
      );
    }),
    includeAuthor,
  );
  return (
    <>
      <ul
        className={layout === "feed" ? feedStyles.list : styles.rows}
        aria-label="Reactions"
      >
        {rows.map((item) => (
          <li
            key={item.id}
            className={layout === "feed" ? feedStyles.item : undefined}
          >
            <ReactionRow
              item={item}
              session={session}
              profiles={profiles}
              name={resolveName}
              channel={channels.get(item.channelId)}
              selected={isSelected(item.channelId, item.message.id)}
              onClick={() =>
                onOpen(item.channelId, {
                  messageId: item.message.id,
                  ...(item.message.threadRootId && {
                    threadRootId: item.message.threadRootId,
                  }),
                })
              }
            />
          </li>
        ))}
      </ul>
      {!rows.length && (
        <p className={`text-body-sm text-subtle ${styles.empty}`}>
          {feed.status === "error"
            ? (feed.error ?? "Couldn't load reactions.")
            : feed.status === "ready"
              ? "No reactions yet."
              : "Loading reactions…"}
        </p>
      )}
    </>
  );
}

async function markEventRead(session: RelaySession, event: ConversationEvent) {
  try {
    await (event.rootId
      ? session.unread.markThrough(
          { kind: "thread", channelId: event.channelId, rootId: event.rootId },
          event.messageId,
        )
      : session.unread.markMessageRead(event.channelId, event.messageId));
  } catch {
    // The reply isn't in retained evidence yet: read the message itself.
    await session.unread
      .markMessageRead(event.channelId, event.messageId)
      .catch(() => {});
  }
}
