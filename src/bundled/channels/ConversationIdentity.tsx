import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { selectProfiles } from "../../features/relay/profile-selection";
import { avatarMedia } from "../../shared/avatar-source";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import styles from "./Channels.module.css";

type Presence = "online" | "away" | "offline" | undefined;

/** Everyone in a conversation besides you, agents included. */
export function conversationOthers(
  channel: Pick<ChannelSummary, "channelType" | "participants" | "members">,
  viewer: string | undefined,
): readonly string[] {
  if (channel.channelType === "dm") return channel.participants ?? none;
  return channel.members?.filter((key) => key !== viewer) ?? none;
}

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

/** Past this many others, a conversation's icon is a count; telling its
 * agents apart isn't worth loading every member's profile. */
const identityProfileLimit = 32;

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
  return { members, profiles };
}

/** A conversation's icon in a sidebar row: the one member's face, the
 * number of members, or the chat bubble when it's with no one else yet. */
export function ConversationRowIdentity({
  members,
  profiles,
  fallback,
  session,
  presence,
}: {
  members: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  /** The conversation's name, for a face whose profile hasn't loaded. */
  fallback: string;
  session: RelaySession;
  presence?: Presence;
}) {
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

/** The same identity as a large tile: a face, a cluster of up to three
 * faces, or the chat bubble. */
export function ConversationTileIdentity({
  members,
  profiles,
  fallback,
  session,
  presence,
}: {
  members: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  fallback: string;
  session: RelaySession;
  presence?: Presence;
}) {
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
const none: readonly never[] = [];
