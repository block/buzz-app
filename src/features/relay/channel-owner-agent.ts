import { attestedOwner } from "../agents/owner-attestation";
import { newer, type RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import { retryRead } from "./read-retry";

/** Owner keys from an administrator record already validated with its roster. */
export function channelOwnerKeys(admins: RelayEvent | undefined) {
  return (
    admins?.tags.flatMap(([name, pubkey, role]) =>
      name === "p" && role === "owner" && pubkey ? [pubkey] : [],
    ) ?? []
  );
}

/** Local evidence of the viewer's relationship to an active owner-role agent.
 * The relay still checks its persisted ownership mapping on every write. */
export async function ownsChannelOwnerAgent(
  reader: RelayReader,
  owners: readonly string[],
  viewer: string,
  signal: AbortSignal,
  assertAccess: () => void,
) {
  for (let start = 0; start < owners.length; start += 4) {
    const batch = owners.slice(start, start + 4);
    const profiles = await retryRead(
      (signal) =>
        reader.read(
          batch.map((pubkey) => ({ kinds: [0], authors: [pubkey], limit: 1 })),
          { signal, fresh: true, priority: "foreground" },
        ),
      signal,
    );
    signal.throwIfAborted();
    assertAccess();
    if (
      profiles.some(
        (event) => event.kind !== 0 || !batch.includes(event.pubkey),
      )
    )
      throw new Error("Unexpected channel owner profile response");
    for (const pubkey of batch) {
      const profile = profiles
        .filter((event) => event.pubkey === pubkey)
        .reduce<RelayEvent | undefined>(newer, undefined);
      const owner = profile && (await attestedOwner(profile));
      signal.throwIfAborted();
      assertAccess();
      if (owner === viewer) return true;
    }
  }
  return false;
}
