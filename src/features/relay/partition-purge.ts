import { purgeOutboxStorage } from "./outbox-storage";
import { relayPartition } from "./partition";
import { createHeadPersistence } from "./persistence";
import { purgeSidebarStorage } from "./sidebar-journal";

/** Clears the relay's durable stores for one partition, each through the
 * caller's `attempt` so an unavailable store neither keeps the others nor goes
 * unreported. The databases stay separate; only this entrypoint is shared. */
export async function purgeRelayPartition(
  origin: string,
  viewer: string,
  attempt: (store: string, work: () => Promise<void>) => Promise<void>,
) {
  const partition = relayPartition(origin, viewer);
  await attempt("channel heads", async () => {
    // Without IndexedDB the cache never existed; the persistence reports it as
    // unavailable rather than empty.
    if (typeof indexedDB === "undefined") return;
    const heads = createHeadPersistence(viewer, origin);
    try {
      await heads.clear();
    } finally {
      heads.close();
    }
  });
  await attempt("read state", () => purgeSidebarStorage(partition));
  await attempt("outbox", () => purgeOutboxStorage(partition));
}
