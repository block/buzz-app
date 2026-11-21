import { finalizeEvent, getPublicKey } from "nostr-tools";
import {
  MEMBERSHIP_BYTES,
  MEMBERSHIP_TYPES,
  membershipIdentity,
} from "./membership-snapshot";

/** Test relay that signs an empty, complete result for the exact received HTTP auth. */
export function membershipDescriptor(key: Uint8Array) {
  return {
    version: 1,
    community_id: "10000000-0000-0000-0000-000000000000",
    pubkey: getPublicKey(key),
    kind: 39008,
    max_channels: 4096,
    max_response_bytes: MEMBERSHIP_BYTES,
  };
}
export async function membershipReply(
  key: Uint8Array,
  viewer: string,
  requestId: string,
  origin: string,
  types: readonly string[] = MEMBERSHIP_TYPES,
) {
  const descriptor = membershipDescriptor(key);
  return {
    membership_snapshot: 1,
    event: finalizeEvent(
      {
        kind: 39008,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["d", requestId],
          ["p", viewer],
        ],
        content: JSON.stringify({
          version: 1,
          community_id: descriptor.community_id,
          host: new URL(origin).host,
          viewer,
          request_id: requestId,
          types,
          complete: true,
          channels: [],
          snapshot_id: await membershipIdentity(
            descriptor.community_id,
            viewer,
            types,
            [],
          ),
        }),
      },
      key,
    ),
  };
}
