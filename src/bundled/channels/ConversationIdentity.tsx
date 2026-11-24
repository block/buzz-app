import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { selectProfiles } from "../../features/relay/profile-selection";
import {
  conversationOthers,
  conversationPeople,
  identityProfileLimit,
  isSoloConversation,
  openToPosting,
} from "../../features/relay/conversation-people";
import { avatarMedia } from "../../shared/avatar-source";
import {
  ChatCircleIcon,
  EyeIcon,
  HashIcon,
  LockIcon,
} from "../../shared/design-system/icons";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import styles from "./Channels.module.css";

export {
  conversationOthers,
  conversationPeople,
  isSoloConversation,
  openToPosting,
};

type Presence = "online" | "away" | "offline" | undefined;

/**
 * Who a conversation's icon shows: its people, the way the relay knows it.
 * Agents brought in never change that; they show only when no other person
 * is in it. A member whose profile hasn't loaded counts as a person.
 */
export function identityMembers(
  others: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
): readonly string[] {
  const people = others.filter((key) => !profiles.get(key)?.isAgent);
  return people.length ? people : others;
}

/** What a named conversation's icon says: whether anyone besides you (not
 * counting agents) is in it or may join and post, and whether anyone in the
 * community can read it. Visibility the relay hasn't confirmed reads as
 * private. */
export type ConversationMark =
  | "solo-private"
  | "solo-view-only"
  | "group-private"
  | "group-public"
  /** A member's profile is still loading and the conversation has no known
   * mark yet: no icon, rather than a lock that swaps away. */
  | "pending";
export function conversationMark(
  channel: Pick<ChannelSummary, "visibility" | "joinRole">,
  people: readonly string[],
): ConversationMark {
  const open = channel.visibility === "public";
  return openToPosting(channel)
    ? "group-public"
    : people.length
      ? open
        ? "group-public"
        : "group-private"
      : open
        ? "solo-view-only"
        : "solo-private";
}
// The icon says who's in it. Every solo conversation shares one; whether
// others can read it shows beside the name (see `ViewOnlyMark`).
const SoloIcon = ChatCircleIcon;
const markIcons = {
  "solo-private": SoloIcon,
  "solo-view-only": SoloIcon,
  "group-private": LockIcon,
  "group-public": HashIcon,
} as const;
/** A named conversation's mark, for a row or a tile. */
export function ConversationMarkIcon({
  mark,
  size,
}: {
  mark: ConversationMark;
  size: number;
}) {
  if (mark === "pending") return null;
  const Icon = markIcons[mark];
  return <Icon size={size} data-conversation-mark={mark} />;
}

export const VIEW_ONLY_LABEL = "Others in this community can read this";
export const viewOnlyDescriptionId = (channelId: string) =>
  `view-only-${channelId}`;

/** Beside a solo conversation others can read. Pointer users get the hint;
 * the row describes itself by `viewOnlyDescriptionId`. A tile shows it as a
 * corner badge, whose name hint is the tile's own. */
export function ViewOnlyMark({
  channelId,
  tile = false,
}: {
  channelId: string;
  tile?: boolean;
}) {
  const mark = (
    <span
      className={tile ? styles.viewOnlyBadge : styles.viewOnlyMarker}
      data-conversation-view-only=""
      aria-hidden="true"
    >
      <EyeIcon size={tile ? 12 : 16} />
    </span>
  );
  return (
    <>
      {tile ? mark : <Tooltip content={VIEW_ONLY_LABEL}>{mark}</Tooltip>}
      <span id={viewOnlyDescriptionId(channelId)} hidden>
        {VIEW_ONLY_LABEL}
      </span>
    </>
  );
}

/**
 * The members a conversation's icon shows, and their profiles. A DM's page
 * supplies its people's profiles, so a DM row never acquires them itself.
 */
export function useConversationIdentity(
  session: RelaySession,
  channel: ChannelSummary,
  given: ReadonlyMap<string, Profile> | undefined,
) {
  const others = conversationOthers(channel, session.viewer);
  const dm = channel.channelType === "dm";
  const wanted = dm
    ? ""
    : (others.length <= identityProfileLimit ? others : others.slice(0, 3))
        .slice()
        .sort()
        .join(":");
  const queries = wanted ? session.profiles : undefined;
  const selection = useMemo(
    () =>
      queries && wanted
        ? selectProfiles(queries, wanted.split(":"))
        : noSelection,
    [queries, wanted],
  );
  const selected = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  useEffect(() => {
    if (!queries || !wanted) return;
    const missing = wanted
      .split(":")
      .filter((key) => !queries.snapshot().has(key));
    if (missing.length) void queries.ensure(missing).catch(() => {});
  }, [queries, wanted]);
  const profiles = (dm ? given : selected) ?? noProfiles;
  const members = useMemo(
    () =>
      others.length <= identityProfileLimit
        ? identityMembers(others, profiles)
        : others,
    [others, profiles],
  );
  // The people besides you: agents never count. Past the profile limit every
  // member counts, since a conversation that size has people in it.
  const people = useMemo(
    () => conversationPeople(others, profiles),
    [others, profiles],
  );
  // Until every member's profile has loaded, an agent would count as a
  // person. Keep the last known mark meanwhile, or none, never a guess.
  const loading =
    !dm &&
    !openToPosting(channel) &&
    others.length <= identityProfileLimit &&
    others.some((key) => !profiles.has(key));
  const computed = conversationMark(channel, people);
  if (!loading) knownMarks.set(channel.id, computed);
  const mark = loading ? (knownMarks.get(channel.id) ?? "pending") : computed;
  return { members, profiles, mark };
}

/** Each conversation's last mark worked out from loaded profiles. */
const knownMarks = new Map<string, ConversationMark>();

// Stands in while a row has no channel yet; a DM loads no profiles.
const noChannel = { id: "", name: "", channelType: "dm" } as ChannelSummary;

/** Whether a conversation is solo and others in the community can read it. */
export function useViewOnly(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const { mark } = useConversationIdentity(
    session,
    channel ?? noChannel,
    undefined,
  );
  return !!channel && channel.channelType !== "dm" && mark === "solo-view-only";
}

/** A conversation's icon in a sidebar row. A named conversation shows its
 * own picture, else its mark. A DM shows the one member's face, the number of
 * members, or the chat bubble when it's with no one else yet. */
export function ConversationRowIdentity({
  members,
  profiles,
  fallback,
  picture,
  session,
  presence,
  mark,
}: {
  /** A named conversation's mark; DMs have none. */
  mark?: ConversationMark | undefined;
  members: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  /** The conversation's name, for a face whose profile hasn't loaded. */
  fallback: string;
  /** A named conversation's own picture, chosen by its owners. */
  picture?: string | undefined;
  session: RelaySession;
  presence?: Presence;
}) {
  if (picture)
    return (
      <span className={styles.dmAvatar} data-dm-identity="">
        <Avatar
          src={avatarMedia(picture, session.media)}
          alt=""
          fallback={fallback}
          size="fill"
        />
      </span>
    );
  if (mark) return <ConversationMarkIcon mark={mark} size={16} />;
  const one = members.length === 1 ? profiles.get(members[0] ?? "") : undefined;
  if (members.length === 1)
    return (
      <span className={styles.dmAvatar} data-dm-identity="">
        <Avatar
          src={avatarMedia(one?.picture, session.media)}
          alt=""
          fallback={one?.name ?? fallback}
          size="fill"
          shape={one?.isAgent ? "squircle" : "circle"}
          statusBadge={presence}
        />
      </span>
    );
  if (members.length > 1)
    return (
      <span
        className={styles.dmCount}
        data-dm-identity=""
        data-dm-participant-count=""
        title={`${members.length} other participants`}
        aria-hidden="true"
      >
        {members.length}
      </span>
    );
  return <ChatCircleIcon size={16} />;
}

/** The same identity as a large tile: its picture, its mark, a face, a
 * cluster of up to three faces, or the chat bubble. */
export function ConversationTileIdentity({
  members,
  profiles,
  fallback,
  picture,
  session,
  presence,
  mark,
}: {
  mark?: ConversationMark | undefined;
  members: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  fallback: string;
  picture?: string | undefined;
  session: RelaySession;
  presence?: Presence;
}) {
  if (picture)
    return (
      <Avatar
        src={avatarMedia(picture, session.media)}
        alt=""
        fallback={fallback}
        size="fill"
      />
    );
  if (mark)
    return (
      <Avatar
        alt=""
        fallback={fallback}
        fallbackContent={<ConversationMarkIcon mark={mark} size={20} />}
        fallbackSurface="accent"
        size="fill"
      />
    );
  if (members.length > 1)
    return (
      <AvatarStack
        size="cluster"
        items={members.slice(0, 3).map((member) => {
          const profile = profiles.get(member);
          return {
            id: member,
            name: profile?.name ?? "Member",
            src: avatarMedia(profile?.picture, session.media),
            shape: profile?.isAgent ? "squircle" : "circle",
          };
        })}
      />
    );
  if (members.length === 1) {
    const one = profiles.get(members[0] ?? "");
    return (
      <Avatar
        src={avatarMedia(one?.picture, session.media)}
        alt=""
        fallback={one?.name ?? fallback}
        size="fill"
        shape={one?.isAgent ? "squircle" : "circle"}
        statusBadge={presence}
        statusBadgeSize="small"
      />
    );
  }
  return (
    <Avatar
      alt=""
      fallback={fallback}
      fallbackContent={<ChatCircleIcon size={20} />}
      fallbackSurface="accent"
      size="fill"
    />
  );
}

const noProfiles: ReadonlyMap<string, Profile> = new Map();
const noSelection = {
  snapshot: () => noProfiles,
  subscribe: () => () => {},
};
