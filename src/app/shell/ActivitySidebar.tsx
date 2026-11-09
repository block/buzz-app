/**
 * PROTOTYPE: Activity as the primary navigation. The sidebar lists
 * conversations, newest first, with their latest event as the preview, under
 * two scopes grouped by who is in the conversation: Solo (you and agents) and
 * Team (you and people). Each scope has its own views, so the header keeps one
 * shape: Solo is All / Working / Waiting; Team is Channels / Threads / Direct,
 * Direct being DMs and mentions of you, everything addressed to you.
 * Rows open in the Messages page, so a thread opens beside its channel with
 * its root revealed there: list | channel | thread.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { Navigation } from "../../features/navigation/controller";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import { useChannelList } from "../../features/relay/react";
import { useUnreadState } from "../../bundled/channels/UnreadBadge";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import { messagePreview } from "../../features/notifications/content";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { ConversationRow } from "../../features/messages/ConversationRow";
import {
  Filter2Icon,
  LockIcon,
  MessageReplyIcon,
} from "../../shared/design-system/icons/index";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Switch } from "../../shared/design-system/ui/Switch";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { readView, writeView } from "../../shared/view-state";
import styles from "./ActivitySidebar.module.css";
import { useLatestMessages, type LatestMessage } from "./activity-previews";
import { useIdentityNames } from "../../features/identity-names/react";
import { dmLabel } from "../../bundled/inbox/dm-label";

export type ActivityScope = "solo" | "team";
type SoloView = "all" | "working" | "waiting";
type TeamView = "channels" | "threads" | "direct";
export type ActivityView = {
  scope: ActivityScope;
  solo: SoloView;
  team: TeamView;
  unread: boolean;
};
type View = ActivityView;

const scopes = [
  { value: "solo", label: "Solo" },
  { value: "team", label: "Team" },
] as const;
const soloViews = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
] as const;
const teamViews = [
  { value: "channels", label: "Channels" },
  { value: "threads", label: "Threads" },
  { value: "direct", label: "Direct" },
] as const;
const viewKey = "activity-sidebar:view:v4";

function readSavedView(scope: string): View {
  const saved = readView<Partial<View> | null>(scope, viewKey, null);
  return {
    scope: saved?.scope === "team" ? "team" : "solo",
    solo:
      saved?.solo === "working" || saved?.solo === "waiting"
        ? saved.solo
        : "all",
    team:
      saved?.team === "threads" || saved?.team === "direct"
        ? saved.team
        : "channels",
    unread: saved?.unread === true,
  };
}

/** What kind of conversation a channel is: a DM lists under Team's Direct. */
type Kind = "solo" | "team" | "dm";
const kindOf = (channel: ChannelSummary): Kind | undefined =>
  channel.channelType === "solo"
    ? "solo"
    : channel.channelType === "dm"
      ? "dm"
      : channel.channelType === "stream" ||
          channel.channelType === "forum" ||
          channel.channelType === undefined
        ? "team"
        : undefined;

const listed = (channel: ChannelSummary) =>
  !channel.archived && !channel.huddle && !channel.metadataPending;

/** The view that lists a destination, so opening one from elsewhere shows it;
 * undefined when the current view already can. A Team channel keeps the Team
 * view, since Direct lists its mentions. */
export function activityViewFor(
  channels: readonly ChannelSummary[] | undefined,
  id: string,
  view: View,
): View | undefined {
  const channel = channels?.find((entry) => entry.id === id);
  const kind = channel ? kindOf(channel) : undefined;
  if (kind === "solo")
    return view.scope === "solo" ? undefined : { ...view, scope: "solo" };
  if (kind === "dm")
    return view.scope === "team" && view.team === "direct"
      ? undefined
      : { ...view, scope: "team", team: "direct" };
  if (kind === "team")
    return view.scope === "team" ? undefined : { ...view, scope: "team" };
  return undefined;
}

export function useActivityView(scope: string) {
  const [view, setView] = useState(() => readSavedView(scope));
  useEffect(() => {
    writeView(scope, viewKey, view);
  }, [scope, view]);
  return [view, setView] as const;
}

/** The scope, in the sidebar's segmented control. */
export function ActivityScopeTabs({
  view,
  onChange,
}: {
  view: View;
  onChange(view: View): void;
}) {
  return (
    <Tabs
      label="Activity scope"
      variant="segmented"
      size="sm"
      value={view.scope}
      items={scopes}
      onValueChange={(scope) => onChange({ ...view, scope })}
    />
  );
}

/** Below this width the views and a labelled Unread switch no longer fit on
 * one row, so Unread folds into a filter menu. */
const unreadSwitchMinWidth = 300;

/** True while the element is at least `min` pixels wide. Without a
 * ResizeObserver (tests) it stays wide. */
function useWiderThan(min: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWide(element.clientWidth >= min);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [min]);
  return [ref, wide] as const;
}

/** Under the scope, one row in every scope, as Inbox's filter bar: the views
 * as underline tabs, then Unread at the right end. The scope above is the one
 * filled control, so the two levels never read as two equal trays. */
export function ActivityFilters({
  view,
  onChange,
}: {
  view: View;
  onChange(view: View): void;
}) {
  const [ref, wide] = useWiderThan(unreadSwitchMinWidth);
  const setUnread = (unread: boolean) => onChange({ ...view, unread });
  const showLabel = view.unread ? "Showing unread" : "Showing all";
  return (
    <div className={styles.filters} ref={ref}>
      <div className={`text-body-sm ${styles.views}`}>
        {view.scope === "team" ? (
          <Tabs
            label="Team view"
            variant="panel"
            value={view.team}
            items={teamViews}
            onValueChange={(team) => onChange({ ...view, team })}
          />
        ) : (
          <Tabs
            label="Solo view"
            variant="panel"
            value={view.solo}
            items={soloViews}
            onValueChange={(solo) => onChange({ ...view, solo })}
          />
        )}
      </div>
      {wide ? (
        <Switch
          label="Unread"
          checked={view.unread}
          onCheckedChange={setUnread}
        />
      ) : (
        <MenuRoot>
          <MenuTrigger
            render={
              <IconButton
                size="sm"
                variant={view.unread ? "subtle" : "ghost"}
                aria-label={showLabel}
                title={showLabel}
                icon={<Filter2Icon aria-hidden="true" size={16} />}
              />
            }
          />
          <MenuPopup aria-label="Show">
            <MenuRadioGroup
              value={view.unread ? "unread" : "all"}
              onValueChange={(value) => setUnread(value === "unread")}
            >
              <MenuRadioItem value="all" closeOnClick>
                All conversations
              </MenuRadioItem>
              <MenuRadioItem value="unread" closeOnClick>
                Unread only
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuPopup>
        </MenuRoot>
      )}
    </div>
  );
}

export function ActivitySidebar({
  session,
  navigator,
  scope,
  target,
  view,
}: {
  session: RelaySession;
  navigator: Navigation;
  /** Navigation scope of this community. */
  scope: NavigationScope;
  target: OpenTarget;
  view: View;
}) {
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  useEffect(() => {
    if (list.status !== "ready") return;
    void session.unread.ensure();
    void session.inboxFeed.ensure();
  }, [session, list.status]);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const selectedChannel =
    target.kind === "conversation" ? target.channelId : undefined;
  const selectedThread =
    target.kind === "conversation" ? target.threadRootId : undefined;

  const open = (
    channelId: string,
    options: { messageId?: string; threadRootId?: string } = {},
  ) =>
    void navigator.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      // A thread opens beside its channel, its root revealed there.
      ...(options.threadRootId
        ? { threadRootId: options.threadRootId, context: "channel" as const }
        : {}),
    });

  const unreadOnly = view.unread;
  const filter = view.scope === "team" ? view.team : view.solo;
  const flat = filter === "threads";
  const direct = filter === "direct";
  const kind: Kind = view.scope === "solo" ? "solo" : direct ? "dm" : "team";
  const working = useWorkingChannels(session);
  const scoped = list.channels.filter(
    (channel) => listed(channel) && kindOf(channel) === kind,
  );
  const fetched = useLatestMessages(
    session,
    scoped.map((channel) => channel.id),
  );
  // inbox changes re-render this list, which reads unread evidence directly.
  void inbox;
  const inboxAt = new Map<string, number>();
  for (const item of inbox.items)
    inboxAt.set(
      item.channelId,
      Math.max(inboxAt.get(item.channelId) ?? 0, item.createdAt),
    );
  /** Newest top-level message, from live evidence or the per-channel read. */
  const latestOf = (channel: ChannelSummary): LatestMessage | undefined => {
    const live = session.unread.snapshot({
      kind: "channel",
      channelId: channel.id,
    }).latestTopLevel;
    const read = fetched.get(channel.id) ?? undefined;
    return !live
      ? read
      : !read || live.createdAt >= read.createdAt
        ? live
        : read;
  };
  // Solo's Working: an agent is on it. Waiting: no agent is, and the agent
  // spoke last, so it is your move: it finished, or it is asking you.
  const channels =
    filter === "working"
      ? scoped.filter((channel) => working.has(channel.id))
      : filter === "waiting"
        ? scoped.filter((channel) => {
            const author = latestOf(channel)?.authorId;
            return (
              !working.has(channel.id) && !!author && author !== session.viewer
            );
          })
        : scoped;
  // Team ranks by what is relevant to you: top-level messages, threads you
  // are in, and your Activity (mentions, replies). Other people's thread
  // chatter does not move a channel. Solo chats and DMs rank by any message.
  const recency = (channel: ChannelSummary) => {
    const latest = latestOf(channel)?.createdAt ?? 0;
    if (kind !== "team")
      return Math.max(
        latest,
        channel.lastActivityAt ?? 0,
        session.unread.snapshot({ kind: "channel", channelId: channel.id })
          .latestMessage?.createdAt ?? 0,
      );
    const threads = session.unread.activity(channel.id).items ?? [];
    return Math.max(
      latest,
      inboxAt.get(channel.id) ?? 0,
      ...threads.map((item) => item.createdAt),
    );
  };
  const sorted = channels
    .map((channel) => ({ channel, at: recency(channel) }))
    .sort(
      (a, b) => b.at - a.at || a.channel.name.localeCompare(b.channel.name),
    );
  const byId = new Map(sorted.map((entry) => [entry.channel.id, entry]));
  const teamIds = new Set(
    list.channels
      .filter((channel) => listed(channel) && kindOf(channel) === "team")
      .map((channel) => channel.id),
  );
  const channelsById = new Map(list.channels.map((c) => [c.id, c]));
  const shownEvents = (
    flat
      ? threadEvents(inbox.items, [...teamIds], session, teamIds)
      : direct
        ? mentionEvents(inbox.items, teamIds)
        : []
  ).filter((event) => !unreadOnly || event.unread);
  // Direct interleaves DMs and mentions by time; other lists hold one kind.
  const eventsByKey = new Map(shownEvents.map((event) => [event.key, event]));
  const entries = flat
    ? []
    : [
        ...sorted.map((entry) => ({
          key: `c:${entry.channel.id}`,
          at: entry.at,
        })),
        ...shownEvents.map((event) => ({
          key: `e:${event.key}`,
          at: event.createdAt,
        })),
      ].sort((a, b) => b.at - a.at);
  const order = useFrozenOrder(entries.map((entry) => entry.key).join("\n"));

  const ids = [
    session.viewer ?? "",
    ...shownEvents.slice(0, 100).map((event) => event.authorId),
    ...channels.flatMap((channel) => [
      // A DM's title names its people.
      ...(channel.channelType === "dm"
        ? (channel.participants?.slice(0, 8) ?? [])
        : []),
      ...(channel.channelType === "solo"
        ? (channel.members ?? []).filter((key) => key !== session.viewer)
        : []),
      latestOf(channel)?.authorId ?? "",
      ...(kind === "team"
        ? [newestThread(session, channel)?.authorId ?? ""]
        : []),
    ]),
  ].filter(Boolean);
  const profileKey = [...new Set(ids)].sort().join(":");
  useEffect(() => {
    if (profileKey && list.status === "ready")
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey, list.status]);
  const resolveName = useIdentityNames(session.names);
  const nameOf = (id: string) =>
    resolveName(id, profiles.get(id)?.name ?? formatPublicKey(id) ?? "Someone");

  /** A thread or mention: a message, opened where it lives. */
  const eventRow = (event: ActivityEvent) => {
    const channel = channelsById.get(event.channelId);
    const name = nameOf(event.authorId);
    return (
      <li key={event.key}>
        <ConversationRow
          selected={
            selectedChannel === event.channelId &&
            !!event.rootId &&
            selectedThread === event.rootId
          }
          onClick={() =>
            open(event.channelId, {
              messageId: event.messageId,
              ...(event.rootId ? { threadRootId: event.rootId } : {}),
            })
          }
          avatar={
            <PersonAvatar
              session={session}
              profile={profiles.get(event.authorId)}
              name={name}
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
            channel ? `${event.rootId ? "in " : ""}${channelText(channel)}` : ""
          }
          time={shortTime(event.createdAt)}
          preview={messagePreview(event.preview)}
          state={event.unread ? "unread" : "read"}
          onMarkRead={() => void markEventRead(session, event)}
        />
      </li>
    );
  };

  return (
    <div className={styles.activity} data-activity-sidebar="">
      <ul className={styles.rows} aria-label="Conversations">
        {flat
          ? shownEvents.map((event) => eventRow(event))
          : order.map((key) => {
              if (key.startsWith("e:")) {
                const event = eventsByKey.get(key.slice(2));
                return event ? eventRow(event) : null;
              }
              const id = key.slice(2);
              const entry = byId.get(id);
              if (!entry) return null;
              return (
                <ChannelRow
                  key={key}
                  session={session}
                  channel={entry.channel}
                  at={entry.at}
                  latest={latestOf(entry.channel)}
                  team={kind === "team"}
                  working={working.has(id)}
                  profiles={profiles}
                  nameOf={nameOf}
                  resolveName={resolveName}
                  unreadOnly={unreadOnly}
                  selected={selectedChannel === id && !selectedThread}
                  onOpen={() => open(id)}
                />
              );
            })}
      </ul>
      {list.status === "ready" &&
        !shownEvents.length &&
        (flat || !channels.length) && (
          <p className={`text-body-sm text-subtle ${styles.empty}`}>
            {filter === "threads"
              ? "No thread activity yet."
              : filter === "direct"
                ? "No DMs or mentions yet."
                : filter === "working"
                  ? "No agent is working right now."
                  : filter === "waiting"
                    ? "Nothing is waiting on you."
                    : "Nothing here yet."}
          </p>
        )}
    </div>
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

/** One row in Threads or Direct: a message, opened where it lives. */
type ActivityEvent = Readonly<{
  key: string;
  channelId: string;
  rootId?: string | undefined;
  messageId: string;
  authorId: string;
  preview: string;
  createdAt: number;
  unread: boolean;
}>;

const rootOf = (item: InboxItem) =>
  item.rootId ?? (item.thread ? item.messageId : undefined);
const itemUnread = (item: InboxItem) => item.unreadCount > 0 || item.manual;
const newestFirst = (a: ActivityEvent, b: ActivityEvent) =>
  b.createdAt - a.createdAt;

/** Every active thread in Team channels, one row each, at its latest reply. */
function threadEvents(
  items: readonly InboxItem[],
  channelIds: readonly string[],
  session: RelaySession,
  team: ReadonlySet<string>,
): ActivityEvent[] {
  const byRoot = new Map<string, ActivityEvent>();
  const add = (event: ActivityEvent) => {
    const key = `${event.channelId}:${event.rootId}`;
    const held = byRoot.get(key);
    if (!held || held.createdAt < event.createdAt)
      byRoot.set(key, {
        ...event,
        key,
        unread: event.unread || !!held?.unread,
      });
    else if (event.unread && !held.unread)
      byRoot.set(key, { ...held, unread: true });
  };
  for (const id of channelIds)
    for (const thread of session.unread.activity(id).items ?? [])
      add({
        key: "",
        channelId: id,
        rootId: thread.rootId,
        messageId: thread.latestMessageId,
        authorId: thread.authorId,
        preview: thread.preview,
        createdAt: thread.createdAt,
        unread: thread.unreadCount > 0,
      });
  for (const item of items) {
    const root = rootOf(item);
    if (!root || !team.has(item.channelId)) continue;
    add({
      key: "",
      channelId: item.channelId,
      rootId: root,
      messageId: item.messageId,
      authorId: item.authorId,
      preview: item.preview,
      createdAt: item.createdAt,
      unread: itemUnread(item),
    });
  }
  return [...byRoot.values()].sort(newestFirst);
}

/** Mentions of you in Team channels, in a thread or not. */
function mentionEvents(
  items: readonly InboxItem[],
  team: ReadonlySet<string>,
): ActivityEvent[] {
  return items
    .flatMap((item) => (item.mention ? [item.mention] : []))
    .filter((item) => team.has(item.channelId))
    .map((item) => ({
      key: item.id,
      channelId: item.channelId,
      rootId: rootOf(item),
      messageId: item.messageId,
      authorId: item.authorId,
      preview: item.preview,
      createdAt: item.createdAt,
      unread: itemUnread(item),
    }))
    .sort(newestFirst);
}

/** Channels an agent is working in: a working turn, or typing that isn't
 * yours. Read as a primitive so unrelated activity doesn't re-render. */
function useWorkingChannels(session: RelaySession): ReadonlySet<string> {
  const agents = useSyncExternalStore(session.agentActivity.subscribe, () => {
    const snapshot = session.agentActivity.snapshot();
    const ids = new Set<string>();
    for (const turn of snapshot.turns)
      if (turn.state === "working" && turn.channelId) ids.add(turn.channelId);
    for (const entry of snapshot.typing) ids.add(entry.channelId);
    return [...ids].sort().join(",");
  });
  const typing = useSyncExternalStore(session.typing.subscribe, () => {
    const ids = new Set<string>();
    for (const entry of session.typing.snapshot())
      if (entry.pubkey !== session.viewer) ids.add(entry.channelId);
    return [...ids].sort().join(",");
  });
  return useMemo(
    () => new Set([agents, typing].join(",").split(",").filter(Boolean)),
    [agents, typing],
  );
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

function ChannelRow({
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
  onOpen(): void;
}) {
  const dm = channel.channelType === "dm";
  const state = useUnreadState(session, channel.id, dm);
  const threadUnread = (state.activity.items ?? []).some(
    (item) => item.unreadCount > 0,
  );
  const unread = state.unread || threadUnread;
  if (unreadOnly && !unread && !selected) return null;
  const Icon = channelIcon(channel);
  const peer = dm ? channel.participants?.[0] : undefined;
  const others = (channel.members ?? []).filter(
    (key) => key !== session.viewer,
  );
  const solo = channel.channelType === "solo";
  // The latest event: a thread reply you're in, when it is newer.
  const thread = team ? newestThread(session, channel) : undefined;
  const replyIsNewest = !!thread && thread.createdAt > (latest?.createdAt ?? 0);
  const latestAuthor = replyIsNewest ? thread.authorId : latest?.authorId;
  // No sender: the avatar says who, yours included.
  const preview = replyIsNewest
    ? messagePreview(thread.preview)
    : latest
      ? messagePreview(latest.content)
      : channel.preview
        ? messagePreview(channel.preview)
        : "";
  // Who the row shows, on every surface: whoever posted last, you included.
  // Before any message is known: a DM's person, a Solo chat's agent, or in
  // Team the channel's icon.
  const face =
    latestAuthor ??
    (peer
      ? peer
      : solo
        ? (others.find((key) => profiles.get(key)?.isAgent) ?? others[0])
        : undefined);
  const name = nameOf;
  return (
    <li data-activity-row={channel.id}>
      <ConversationRow
        aria-current={selected ? "page" : undefined}
        selected={selected}
        onClick={onOpen}
        avatar={
          face ? (
            <PersonAvatar
              session={session}
              profile={profiles.get(face)}
              name={name(face)}
            />
          ) : (
            <Avatar
              size="fill"
              alt=""
              shape="squircle"
              fallback={channel.name}
              fallbackContent={<Icon size={16} aria-hidden="true" />}
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
            : solo
              ? channel.name
              : channelText(channel)
        }
        time={at ? shortTime(at) : ""}
        preview={preview}
        state={working ? "working" : unread ? "unread" : "read"}
        onMarkRead={() =>
          void session.unread.markChannelRead(channel.id).catch(() => {})
        }
      />
    </li>
  );
}

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
async function markEventRead(session: RelaySession, event: ActivityEvent) {
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

function PersonAvatar({
  session,
  profile,
  name,
}: {
  session: RelaySession;
  profile: Profile | undefined;
  name: string;
}) {
  return (
    <Avatar
      size="fill"
      alt=""
      fallback={name}
      src={avatarMedia(profile?.picture, session.media)}
      shape={profile?.isAgent ? "squircle" : "circle"}
    />
  );
}
