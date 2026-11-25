import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { proposalSlug, type TableSchema } from "./schema.ts";

/** The NIP-AE `d` tag of `slug` under the pair's conversation key. */
export function memoryAddress(key: Uint8Array, slug: string) {
  return bytesToHex(
    hmac(
      sha256,
      key,
      new TextEncoder().encode(`agent-memory/v1/d-tag\0${slug}`),
    ),
  );
}

/** An owner-signed proposal of `schema` for `agent`, in NIP-AE's envelope
 * with the roles turned around: the owner signs and the agent is `p`. Only
 * a key-owning host calls this; the relay sees ciphertext and an HMAC. */
export function proposeSchema(
  ownerSecret: Uint8Array,
  agent: string,
  table: string,
  schema: TableSchema,
  createdAt: number,
) {
  if (!/^[0-9a-f]{64}$/.test(agent) || agent === getPublicKey(ownerSecret))
    throw new Error("Invalid proposal target");
  const key = getConversationKey(ownerSecret, agent);
  const slug = proposalSlug(table);
  return finalizeEvent(
    {
      kind: 30174,
      created_at: createdAt,
      content: encrypt(
        JSON.stringify({ slug, value: JSON.stringify(schema) }),
        key,
      ),
      tags: [
        ["d", memoryAddress(key, slug)],
        ["p", agent],
      ],
    },
    ownerSecret,
  );
}
