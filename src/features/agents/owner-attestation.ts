import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "nostr-tools/utils";
import type { EventData } from "../relay/events";

const KEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const CLAUSE = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;

/** NIP-OA owner of a signature-verified event, or undefined. Provenance only:
 * the event stays authored by `event.pubkey`; the owner is never an author. */
export async function attestedOwner(
  event: Pick<EventData, "pubkey" | "kind" | "created_at" | "tags">,
): Promise<string | undefined> {
  const tags = event.tags.filter((tag) => tag[0] === "auth");
  const [, owner, conditions, sig] = tags[0] ?? [];
  if (
    tags.length !== 1 ||
    tags[0]?.length !== 4 ||
    !owner ||
    conditions === undefined ||
    !sig ||
    !KEY.test(owner) ||
    !SIG.test(sig) ||
    owner === event.pubkey ||
    !satisfied(conditions, event)
  )
    return undefined;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `nostr:agent-auth:${event.pubkey}:${conditions}`,
      ),
    );
    return schnorr.verify(
      hexToBytes(sig),
      new Uint8Array(digest),
      hexToBytes(owner),
    )
      ? owner
      : undefined;
  } catch {
    return undefined;
  }
}

function satisfied(
  conditions: string,
  event: Pick<EventData, "kind" | "created_at">,
) {
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const [, name, digits] = CLAUSE.exec(clause) ?? [];
    if (!name || !digits) return false;
    const value = Number(digits);
    if (name === "kind=") return value <= 65535 && event.kind === value;
    if (value > 4294967295) return false;
    return name === "created_at<"
      ? event.created_at < value
      : event.created_at > value;
  });
}
