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
import {
  useConversationEvent,
  useConversationKeys,
  useConversationReaction,
  useConversationRecord,
  type ConversationEvent,
  type ConversationQuery,
  type ConversationRecord,
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
import { ChatIconSlot } from "./ChatIconSlot";
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
import { useVisibleChannelPreviews } from "./latest-previews";
import { useIdentityNames } from "../../features/identity-names/react";
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
  /** Only what people, or only what agents, sent. */
  sender?: "humans" | "agents";
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
    ...((saved?.sender === "humans" || saved?.sender === "agents") && {
      sender: saved.sender,
    }),
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

/** Sets a list's saved view from outside it: an address that names one. */
export function saveActivityView(scope: string, change: (view: View) => View) {
  writeView(scope, viewKey, change(readSavedView(scope)));
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
  from = false,
  label,
  variant = "glass",
}: {
  view: View;
  onChange(view: View): void;
  sort?: boolean;
  views?: boolean;
  agentViews?: boolean;
  /** Offers people or agents only: for lists other people write in. */
  from?: boolean;
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
        {from && (
          <>
            <MenuRadioGroup
              aria-label="From"
              value={view.sender ?? "everyone"}
              onValueChange={(value) => {
                const { sender: _, ...rest } = view;
                onChange(
                  value === "humans" || value === "agents"
                    ? { ...rest, sender: value }
                    : rest,
                );
              }}
            >
              <MenuGroupLabel>From</MenuGroupLabel>
              <MenuRadioItem value="everyone" closeOnClick>
                Anyone
              </MenuRadioItem>
              <MenuRadioItem value="humans" closeOnClick>
                People
              </MenuRadioItem>
              <MenuRadioItem value="agents" closeOnClick>
                Agents
              </MenuRadioItem>
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
          <ConversationFiltersMenu
            view={view}
            onChange={onChange}
            sort
            from={!agentViews}
          />
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
type WrapRow =
  | ((entry: ConversationListEntry, row: ReactNode) => ReactNode)
  | undefined;
/** Rows tell the list whose names and faces they show. */
type Need = (row: string, people: string) => void;
const noRows: ConversationQuery = {
  filter: "all",
  unread: false,
  within: new Set(),
};

export function ConversationList({
  session,
  navigator,
  scope,
  target,
  view,
  home,
  within,
  layout = "sidebar",
  wrapRow,
}: {
  session: RelaySession;
  navigator: Navigation;
  /** Navigation scope of this community. */
  scope: NavigationScope;
  target: OpenTarget;
  view: View;
  /** Team's conversations or Solo's; Team's All is the interleaved feed. */
  home?: ConversationQuery["home"];
  /** Only these conversations: a section's own. Keep it while they are equal. */
  within?: ReadonlySet<string> | undefined;
  layout?: Layout;
  /** Keep host-owned row context actions around the shared feed renderer. */
  wrapRow?: WrapRow;
}) {
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
  const selected = target.kind === "conversation" ? target : undefined;

  // Rows keep one handler for as long as they are mounted.
  const opener = useRef<Open>(() => {});
  useLayoutEffect(() => {
    opener.current = (channelId, options = {}) =>
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
  });
  const open = useCallback<Open>(
    (channelId, options) => opener.current(channelId, options),
    [],
  );

  const { filter, unread: unreadOnly, sender } = view;
  const place = { home, within };
  const keys = useConversationKeys(session, {
    ...place,
    filter,
    unread: unreadOnly,
    sort: view.sort,
    sender,
    // Opening a conversation quiets its row at once; Unread keeps it listed.
    keep:
      unreadOnly && !selected?.threadRootId ? selected?.channelId : undefined,
  });
  const order = useFrozenOrder(keys);
  // Waiting and a sender filter judge the latest author of every candidate,
  // shown or not, so each needs its preview.
  const candidates = useConversationKeys(
    session,
    filter === "waiting"
      ? { filter: "all", unread: false, home: "solo", within }
      : sender
        ? { ...place, filter, unread: false }
        : noRows,
  );
  const { observe: previewRef } = useVisibleChannelPreviews(
    session,
    candidates.flatMap((key) => (key.startsWith("c:") ? [key.slice(2)] : [])),
  );
  const need = useProfiles(session, ready);
  const nameOf = useCallback(
    (id: string) =>
      resolveName(
        id,
        profiles.get(id)?.name ?? formatPublicKey(id) ?? "Someone",
      ),
    [resolveName, profiles],
  );

  return (
    <div className={styles.activity} data-activity-sidebar="">
      <ul
        className={layout === "feed" ? feedStyles.list : styles.rows}
        aria-label={filter === "reactions" ? "Reactions" : "Conversations"}
      >
        {order.map((key) => {
          const id = key.slice(2);
          return key.startsWith("e:") ? (
            <EventRow
              key={key}
              id={id}
              session={session}
              scope={scope}
              layout={layout}
              profiles={profiles}
              nameOf={nameOf}
              unreadOnly={unreadOnly}
              selected={selected}
              onOpen={open}
              need={need}
              wrapRow={wrapRow}
            />
          ) : key.startsWith("r:") ? (
            <ReactionListRow
              key={key}
              id={id}
              sender={sender}
              session={session}
              layout={layout}
              profiles={profiles}
              resolveName={resolveName}
              selected={selected}
              onOpen={open}
              need={need}
            />
          ) : (
            <IndexedRow
              key={key}
              id={id}
              previewRef={previewRef}
              wrapRow={wrapRow}
              scope={scope}
              layout={layout}
              session={session}
              profiles={profiles}
              nameOf={nameOf}
              unreadOnly={unreadOnly}
              selected={selected?.channelId === id && !selected.threadRootId}
              onOpen={open}
              need={need}
            />
          );
        })}
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
                    : filter === "reactions"
                      ? "No reactions yet"
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

/**
 * Loads the profiles the mounted rows show, in one request for all of them.
 * Each row reports its own people, so a message asks again only when it brings
 * someone new.
 */
function useProfiles(session: RelaySession, ready: boolean): Need {
  const rows = useRef(new Map<string, string>());
  const [people, setPeople] = useState("");
  const queued = useRef(false);
  const need = useCallback<Need>(
    (row, ids) => {
      if ((rows.current.get(row) ?? "") === ids) return;
      if (ids) rows.current.set(row, ids);
      else rows.current.delete(row);
      if (queued.current) return;
      queued.current = true;
      queueMicrotask(() => {
        queued.current = false;
        const all = new Set<string>(session.viewer ? [session.viewer] : []);
        for (const ids of rows.current.values())
          for (const id of ids.split(":")) all.add(id);
        setPeople([...all].sort().join(":"));
      });
    },
    [session],
  );
  useEffect(() => {
    if (!people || !ready) return;
    const ids = people.split(":");
    void session.profiles
      .ensure(
        ids.slice(0, session.profiles.limit?.() ?? ids.length),
        "background",
      )
      .catch(() => {});
  }, [session, people, ready]);
  return need;
}
/** Reports a row's people while it is mounted. */
function useNeed(need: Need, row: string, people: string) {
  useEffect(() => {
    need(row, people);
    return () => need(row, "");
  }, [need, row, people]);
}

/** A conversation's row, drawn from its own record in the index. */
const IndexedRow = memo(function IndexedRow({
  id,
  need,
  ...row
}: { id: string; need: Need } & Omit<
  Parameters<typeof ChannelActivityRow>[0],
  "record"
>) {
  const record = useConversationRecord(row.session, id);
  useNeed(
    need,
    `c:${id}`,
    record
      ? [
          ...new Set([
            ...(record.kind === "dm"
              ? (record.channel.participants ?? [])
              : []),
            ...(record.kind === "team"
              ? []
              : conversationPeople(record.channel, row.session.viewer)),
            ...(record.latest?.authorId ? [record.latest.authorId] : []),
            ...(record.thread ? [record.thread.authorId] : []),
          ]),
        ].join(":")
      : "",
  );
  return record ? <ChannelActivityRow {...row} record={record} /> : null;
});

/** A thread or mention: a message, opened where it lives. */
const EventRow = memo(function EventRow({
  id,
  session,
  scope,
  layout,
  profiles,
  nameOf,
  unreadOnly,
  selected,
  onOpen,
  need,
  wrapRow,
}: {
  id: string;
  session: RelaySession;
  scope: NavigationScope;
  layout: Layout;
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  unreadOnly: boolean;
  selected: Extract<OpenTarget, { kind: "conversation" }> | undefined;
  onOpen: Open;
  need: Need;
  wrapRow?: WrapRow;
}) {
  const notify = useToastNotification();
  const event = useConversationEvent(session, id);
  const channel = useConversationRecord(
    session,
    event?.channelId ?? "",
  )?.channel;
  useNeed(need, `e:${id}`, event?.authorId ?? "");
  if (!event) return null;
  const name = nameOf(event.authorId);
  const profile = profiles.get(event.authorId);
  const content = (
    <ConversationRow
      layout={layout}
      selected={
        !!event.rootId &&
        selected?.channelId === event.channelId &&
        selected.threadRootId === event.rootId
      }
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
    <li
      data-activity-event={event.key}
      className={layout === "feed" ? feedStyles.item : undefined}
    >
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
});

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
function useFrozenOrder(keys: readonly string[]) {
  // Either holds the order on its own: focus moving to the reader on a click
  // must not release rows the pointer is still over.
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const frozen = pointed || focused;
  const held = useRef<readonly string[]>([]);
  useEffect(() => {
    const inList = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest("[data-activity-sidebar]");
    const thaw = () => {
      setPointed(false);
      setFocused(false);
    };
    const onPointer = (event: PointerEvent) => setPointed(inList(event.target));
    const onFocus = () => setFocused(inList(document.activeElement));
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
    if (!frozen) {
      held.current = keys;
      return keys;
    }
    const present = new Set(keys);
    const kept = held.current.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    held.current = [...kept, ...keys.filter((id) => !keptSet.has(id))];
    return held.current;
  }, [frozen, keys]);
}

/** Renders again only when its own conversation's record or state changes. */
export const ChannelActivityRow = memo(function ChannelActivityRow({
  previewRef,
  wrapRow,
  scope,
  layout,
  session,
  record,
  profiles,
  nameOf,
  unreadOnly,
  selected,
  onOpen,
}: {
  previewRef?: RefCallback<HTMLLIElement> | undefined;
  /** A stable host wrapper; the row describes itself to it. */
  wrapRow?: WrapRow;
  /** With wrapRow: where this row opens. */
  scope?: NavigationScope | undefined;
  layout: Layout;
  session: RelaySession;
  record: ConversationRecord;
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  unreadOnly: boolean;
  selected: boolean;
  onOpen(channelId: string): void;
}) {
  const notify = useToastNotification();
  const { channel, kind, latest, thread, at, unread, working, label } = record;
  const dm = kind === "dm";
  const solo = kind === "solo";
  const people = dm || solo ? conversationPeople(channel, session.viewer) : [];
  // The latest event: a thread reply you're in, when it is newer.
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
      placeIcon={
        solo ? (
          <ChatIconSlot session={session} channelId={channel.id} />
        ) : (
          privateIcon(channel)
        )
      }
      place={
        dm
          ? label
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
              label,
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

/** A reaction to your message: context, never unread and never marked read. */
const ReactionListRow = memo(function ReactionListRow({
  id,
  sender,
  session,
  layout,
  profiles,
  resolveName,
  selected,
  onOpen,
  need,
}: {
  id: string;
  sender: ConversationQuery["sender"];
  session: RelaySession;
  layout: Layout;
  profiles: ReadonlyMap<string, Profile>;
  resolveName: ReturnType<typeof useIdentityNames>;
  selected: Extract<OpenTarget, { kind: "conversation" }> | undefined;
  onOpen: Open;
  need: Need;
}) {
  const item = useConversationReaction(session, id, sender);
  const channel = useConversationRecord(
    session,
    item?.channelId ?? "",
  )?.channel;
  useNeed(
    need,
    `r:${id}`,
    item
      ? [...new Set(item.events.map((event) => event.pubkey))]
          .slice(0, 3)
          .join(":")
      : "",
  );
  if (!item) return null;
  return (
    <li
      data-activity-reaction={item.id}
      className={layout === "feed" ? feedStyles.item : undefined}
    >
      <ReactionRow
        item={item}
        session={session}
        profiles={profiles}
        name={resolveName}
        channel={channel}
        selected={
          selected?.channelId === item.channelId &&
          selected.messageId === item.message.id
        }
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
  );
});

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
