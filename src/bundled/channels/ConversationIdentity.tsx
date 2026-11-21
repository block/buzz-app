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

/**
 * Who a conversation is with, besides you. Every conversation is drawn the
 * same way from this, whatever kind it is: a name changes its label, never
 * its icon.
 */
export function conversationOthers(
  channel: Pick<ChannelSummary, "channelType" | "participants" | "members">,
  viewer: string | undefined,
): readonly string[] {
  if (channel.channelType === "dm") return channel.participants ?? none;
  return channel.members?.filter((key) => key !== viewer) ?? none;
}

/** A conversation's icon in a sidebar row: the one other member's face, the
 * number of others, or the chat bubble when it's with no one else yet. */
export function ConversationRowIdentity({
  channel,
  session,
  profile,
  presence,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  /** The one other member's profile, when the caller already holds it. */
  profile?: Profile | undefined;
  presence?: Presence;
}) {
  const others = conversationOthers(channel, session.viewer);
  const other = useOtherProfile(session, channel, others, profile);
  if (others.length === 1)
    return (
      <span className={styles.dmAvatar} data-dm-identity="">
        <Avatar
          src={avatarMedia(other?.picture, session.media)}
          alt=""
          fallback={other?.name ?? channel.name}
          size="fill"
          shape={other?.isAgent ? "squircle" : "circle"}
          statusBadge={presence}
        />
      </span>
    );
  if (others.length > 1)
    return (
      <span
        className={styles.dmCount}
        data-dm-identity=""
        data-dm-participant-count=""
        title={`${others.length} other participants`}
        aria-hidden="true"
      >
        {others.length}
      </span>
    );
  return <ChatCircleIcon size={16} />;
}

/** The same identity as a large tile: a face, a cluster of up to three
 * faces, or the chat bubble. */
export function ConversationTileIdentity({
  channel,
  session,
  profile,
  presence,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  profile?: Profile | undefined;
  presence?: Presence;
}) {
  const others = conversationOthers(channel, session.viewer);
  const other = useOtherProfile(session, channel, others, profile);
  if (others.length > 1)
    return <GroupTile people={others.slice(0, 3)} session={session} />;
  if (others.length === 1)
    return (
      <Avatar
        src={avatarMedia(other?.picture, session.media)}
        alt=""
        fallback={other?.name ?? channel.name}
        size="fill"
        shape={other?.isAgent ? "squircle" : "circle"}
        statusBadge={presence}
        statusBadgeSize="small"
      />
    );
  return (
    <Avatar
      alt=""
      fallback={channel.name}
      fallbackContent={<ChatCircleIcon size={20} />}
      fallbackSurface="accent"
      size="fill"
    />
  );
}

/** The lone other member's profile, loaded if it isn't yet. A DM's page
 * supplies its person's profile, so a DM row never acquires one itself. */
function useOtherProfile(
  session: RelaySession,
  channel: Pick<ChannelSummary, "channelType">,
  others: readonly string[],
  given: Profile | undefined,
) {
  const key =
    channel.channelType !== "dm" && others.length === 1 && !given
      ? others[0]
      : undefined;
  const queries = key ? session.profiles : undefined;
  const selection = useMemo(
    () => (queries && key ? selectProfiles(queries, [key]) : noSelection),
    [queries, key],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const found = key ? profiles.get(key) : undefined;
  useEffect(() => {
    if (queries && key && !found) void queries.ensure([key]).catch(() => {});
  }, [queries, key, found]);
  return given ?? found;
}

const noProfiles: ReadonlyMap<string, Profile> = new Map();
const noSelection = {
  snapshot: () => noProfiles,
  subscribe: () => () => {},
};

function GroupTile({
  people,
  session,
}: {
  people: readonly string[];
  session: RelaySession;
}) {
  // Follow only the people drawn; anyone else's profile arriving renders nothing.
  const key = people.join(":");
  const selection = useMemo(
    () => selectProfiles(session.profiles, key.split(":")),
    [session.profiles, key],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  return (
    <AvatarStack
      size="cluster"
      items={people.map((person) => {
        const profile = profiles.get(person);
        return {
          id: person,
          name: profile?.name ?? "Member",
          src: avatarMedia(profile?.picture, session.media),
          shape: profile?.isAgent ? "squircle" : "circle",
        };
      })}
    />
  );
}

const none: readonly never[] = [];
