import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { Profile } from "../../features/relay/contracts";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { IdentityRow } from "../../shared/identity/IdentityRow";
import { formatPublicKey } from "../../shared/identity/public-key";
import { shortKey } from "./ui";

/**
 * Profiles of the connected community. Staff often aren't members of the
 * community a row comes from, so a missing name falls back to the short key.
 */
export const ProfilesContext = createContext<ProfileQueries | null>(null);

const NONE: ReadonlyMap<string, Profile> = new Map();
const noop = () => () => {};

/** Resolves display names for `pubkeys`; the result names any key as text. */
export function useNames(pubkeys: readonly (string | null | undefined)[]) {
  const profiles = useContext(ProfilesContext);
  const snapshot = useSyncExternalStore(
    profiles?.subscribe ?? noop,
    profiles?.snapshot ?? (() => NONE),
  );
  const ids = pubkeys.filter((key): key is string => !!key);
  const wanted = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the joined ids
  useEffect(() => {
    if (profiles && ids.length)
      profiles.ensure(ids, "background").catch(() => {});
  }, [profiles, wanted]);
  return {
    profile: (pubkey: string) => snapshot.get(pubkey),
    /** "Name (npub…xyz)", or the short key alone when no name is known. */
    text(pubkey: string) {
      const name = snapshot.get(pubkey)?.name?.trim();
      return name ? `${name} (${shortKey(pubkey)})` : shortKey(pubkey);
    },
  };
}

const fullKey = (pubkey: string) => {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
};

/** Inline name for text that sits inside another control; full npub on hover. */
export function PersonName({
  pubkey,
  keyLabel,
}: {
  pubkey: string;
  keyLabel?: string | undefined;
}) {
  const { profile } = useNames([pubkey]);
  const name = profile(pubkey)?.name?.trim();
  const label = keyLabel ?? shortKey(pubkey);
  return (
    <span title={fullKey(pubkey)}>
      {name ? (
        <>
          {name} <span className="text-secondary">({label})</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** A person with avatar, short key and a preview that copies the full npub. */
export function Person({
  pubkey,
  keyLabel,
  detail,
}: {
  pubkey: string;
  keyLabel?: string | undefined;
  detail?: string | undefined;
}) {
  const { profile } = useNames([pubkey]);
  const found = profile(pubkey);
  const label = keyLabel ?? formatPublicKey(pubkey);
  // An invalid key has no label and is never echoed.
  if (!label) return <>—</>;
  return (
    <IdentityRow
      pubkey={pubkey}
      name={found?.name?.trim() || label}
      picture={found?.picture}
      isAgent={!!found?.isAgent}
      keyLabel={label}
      detail={detail}
    />
  );
}
