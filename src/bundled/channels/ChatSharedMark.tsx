import { useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ownSolo } from "../../features/solo/labels";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";

/** The person whose Solo chat another member is viewing. Absent in the
 * viewer's own chats and until the creator's profile is known. */
export function useSoloOwner(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const creator = channel?.creator;
  if (
    channel?.channelType !== "solo" ||
    !creator ||
    ownSolo(channel, session.viewer)
  )
    return undefined;
  const profile = profiles.get(creator);
  if (!profile || profile.nameIsFallback) return undefined;
  return {
    name: profile.name,
    picture: avatarMedia(profile.picture, session.media),
  };
}

export const soloOwnerLabel = (owner: { name: string }) =>
  `${owner.name}’s chat`;

export function SoloOwnerAvatar({
  owner,
}: {
  owner: { name: string; picture?: string | undefined };
}) {
  return (
    <Avatar src={owner.picture} alt="" fallback={owner.name} size="compact" />
  );
}
