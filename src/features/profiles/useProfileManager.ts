import { useIdentityNames } from "../identity-names/react";
import type { RelaySession } from "../relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { useProfileOwner } from "./useProfileOwner";

/** Public attribution for another person's agent, using verified directory evidence. */
export function useProfileManager(
  session: RelaySession | undefined,
  pubkey: string | undefined,
  viewer: string | undefined,
) {
  const owner = useProfileOwner(session, pubkey);
  const identityName = useIdentityNames(session?.names);
  if (!owner || owner.id === viewer) return undefined;
  const name = identityName(
    owner.id,
    owner.profile?.name ?? formatPublicKey(owner.id) ?? owner.id,
  );
  return {
    id: owner.id,
    name,
    picture: avatarMedia(owner.profile?.picture, session?.media),
  };
}
