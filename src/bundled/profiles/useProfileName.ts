import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useProfileGeneration } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { formatPublicKey } from "../../shared/identity/public-key";

/** The name to show for `pubkey`, loading its profile in the background. */
export function useProfileName(session: RelaySession, pubkey: string): string {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    void session.profiles.ensure([pubkey], "background").catch(() => {});
  }, [session, pubkey, profileGeneration]);
  const identityName = useIdentityNames(session.names);
  return identityName(
    pubkey,
    profiles.get(pubkey)?.name ?? formatPublicKey(pubkey) ?? pubkey,
  );
}
