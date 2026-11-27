import { attestedOwner } from "../agents/owner-attestation";
import { readErrorKind } from "./errors";
import { newer, type RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import { retryRead } from "./read-retry";

/** Local evidence of the viewer's relationship to an active owner-role agent.
 * `admins` must already be validated against the signed roster. Undefined
 * means evidence was unavailable. The relay authorizes every write. */
export async function ownsChannelOwnerAgent(
  reader: RelayReader,
  admins: RelayEvent | undefined,
  viewer: string,
  signal: AbortSignal,
  assertAccess: () => void,
): Promise<boolean | undefined> {
  signal.throwIfAborted();
  assertAccess();
  const owners =
    admins?.tags.flatMap(([name, pubkey, role]) =>
      name === "p" && role === "owner" && pubkey ? [pubkey] : [],
    ) ?? [];
  if (!owners.length) return false;
  // Bound all batches together so an optional lookup cannot consume the operation.
  const profileSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  try {
    for (let start = 0; start < owners.length; start += 4) {
      const batch = owners.slice(start, start + 4);
      const profiles = await retryRead(
        (signal) =>
          reader.read(
            batch.map((pubkey) => ({
              kinds: [0],
              authors: [pubkey],
              limit: 1,
            })),
            { signal, fresh: true, priority: "foreground" },
          ),
        profileSignal,
      );
      profileSignal.throwIfAborted();
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
        profileSignal.throwIfAborted();
        assertAccess();
        if (owner === viewer) return true;
      }
    }
    return false;
  } catch (error) {
    signal.throwIfAborted();
    assertAccess();
    // A retired read invalidates the roster too. The caller must start again.
    if (!profileSignal.aborted && readErrorKind(error) === "cancelled")
      throw error;
    return undefined;
  }
}
