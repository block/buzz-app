/** A table kept as one small SQLite file in a NIP-AR artifact, encrypted
 * with NIP-44 under a random per-table key. Each member receives that key
 * NIP-44 encrypted to them, so a grant opens exactly one table. */
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

export const TABLE_FILE = "buzz.table";
export const TABLE_KEY = "buzz.table-key";
/** NIP-44 v2 encrypts at most this many plaintext bytes. */
export const NIP44_PLAINTEXT_BYTES = 65_535;

/** `bytes` encrypted under `key`; refused when the encoded file exceeds what
 * NIP-44 can carry, rather than truncated. */
export function sealTable(key: Uint8Array, bytes: Uint8Array) {
  const encoded = base64(bytes);
  if (encoded.length > NIP44_PLAINTEXT_BYTES)
    throw new Error(
      `This table is too large to save: its file is ${bytes.length} bytes, and at most ${Math.floor((NIP44_PLAINTEXT_BYTES * 3) / 4)} fit.`,
    );
  return encrypt(encoded, key);
}

export function openTable(key: Uint8Array, content: string) {
  return fromBase64(decrypt(content, key));
}

export function newTableKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The table key for `member`, encrypted by `granter`. */
export function wrapKey(granter: Uint8Array, member: string, key: Uint8Array) {
  return encrypt(bytesToHex(key), getConversationKey(granter, member));
}

export function unwrapKey(
  member: Uint8Array,
  granter: string,
  wrapped: string,
) {
  const hex = decrypt(wrapped, getConversationKey(member, granter));
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Invalid table key");
  return hexToBytes(hex);
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
