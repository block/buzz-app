import { npubEncode, decode } from "nostr-tools/nip19";

/** Public identity locator, not a relay hint or an authority claim. */
export function profileTarget(pubkey: string): string | undefined {
  return /^[a-f0-9]{64}$/i.test(pubkey)
    ? `nostr:${npubEncode(pubkey.toLowerCase())}`
    : undefined;
}
export function profileKey(target: string): string | undefined {
  if (!/^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(target))
    return undefined;
  try {
    const decoded = decode(target.slice(6));
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
