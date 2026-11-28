import { useMemo, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { selectProfiles } from "../../features/relay/profile-selection";
import { ChannelAvatar } from "../../features/channels/ChannelAvatar";
import { channelIcon } from "../../features/channels/channel-icon";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";

/**
 * A conversation drawn as its identity, for a card shown as icons: a DM as its
 * person, a group DM as up to three of its people, a channel as its monogram,
 * a Solo chat as the chat bubble its row shows.
 */
export function ChannelSidebarTile({
  channel,
  profile,
  presence,
  session,
}: {
  channel: ChannelSummary;
  profile?: Profile | undefined;
  presence?: "online" | "away" | "offline" | undefined;
  session: RelaySession;
}) {
  const people =
    channel.channelType === "dm" ? (channel.participants ?? []) : [];
  if (people.length > 1)
    return <GroupTile people={people.slice(0, 3)} session={session} />;
  if (channel.channelType === "dm")
    return (
      <Avatar
        src={avatarMedia(profile?.picture, session.media)}
        alt=""
        fallback={channel.name}
        size="fill"
        shape={profile?.isAgent ? "squircle" : "circle"}
        statusBadge={presence}
        statusBadgeSize="small"
      />
    );
  if (channel.channelType === "solo") {
    const Icon = channelIcon(channel);
    return (
      <Avatar
        alt=""
        fallback={channel.name}
        fallbackContent={<Icon size={20} />}
        fallbackSurface="accent"
        size="fill"
      />
    );
  }
  return <ChannelAvatar name={channel.name} size="fill" />;
}

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
