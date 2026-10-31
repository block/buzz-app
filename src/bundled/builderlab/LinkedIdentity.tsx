import { useCallback, useSyncExternalStore } from "react";
import type { CommunityReader } from "../../features/communities/service";
import { communityDestination } from "../../features/communities/destination";
import { communityName } from "../../features/communities/names";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { avatarMedia, avatarSource } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";

const noSubscribe = () => () => {};

/** Display the linked key's profile only from the current, matching source. */
export function LinkedIdentity({
  pubkey,
  communities,
  relay,
}: {
  pubkey: string;
  communities: CommunityReader;
  relay: RelayData;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const connection = useRelayConnection(relay);
  const selected = client.memberships.find(
    (item) => item.id === client.selected,
  );
  const matchingViewer = client.status === "ready" && client.viewer === pubkey;
  const session =
    matchingViewer &&
    selected &&
    connection.status === "ready" &&
    connection.viewer === pubkey &&
    connection.origin === communityDestination(selected.id).url
      ? connection.session
      : undefined;
  const profiles = session?.profiles;
  const read = useCallback(
    () => profiles?.snapshot().get(pubkey),
    [profiles, pubkey],
  );
  const communityProfile = useSyncExternalStore(
    profiles?.subscribe ?? noSubscribe,
    read,
    read,
  );
  // Never substitute the local default for a missing selected-community profile.
  const profile = matchingViewer
    ? client.selected
      ? communityProfile
      : client.profile
    : undefined;
  const name =
    profile && (!("nameIsFallback" in profile) || !profile.nameIsFallback)
      ? profile.name.trim()
      : "";
  const source = !matchingViewer
    ? "Profile unavailable for this identity"
    : client.selected
      ? `${communityProfile ? "Profile in" : "Profile unavailable in"} ${selected ? communityName(selected) : "the selected community"}`
      : "Local default profile · Personal space";
  const picture = client.selected
    ? avatarMedia(profile?.picture, session?.media)
    : avatarSource(profile?.picture);
  return (
    <section
      className="flex min-w-0 items-start gap-3"
      aria-label="Linked Buzz profile"
    >
      <Avatar
        src={picture}
        alt=""
        fallback={name || "Buzz identity"}
        size="large"
        shape="squircle"
      />
      <div className="grid min-w-0 gap-1">
        <p className="m-0 text-label">{name || "Buzz identity"}</p>
        <p className="m-0 text-mono text-muted">{formatPublicKey(pubkey, 8)}</p>
        {profile?.about?.trim() && (
          <p className="m-0 text-body-sm text-secondary">
            {profile.about.trim()}
          </p>
        )}
        <p className="m-0 text-caption text-secondary">{source}</p>
      </div>
    </section>
  );
}
