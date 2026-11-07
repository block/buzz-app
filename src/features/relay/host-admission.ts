import { createLiveAdmission } from "./live.ts";
import { createApiAdmission, type CommunityRefusal } from "./http-admission.ts";

/** In-memory host ownership, not a cross-app quota promise. Capacity eviction
 * never forgets an active stream, queued work or server cooldown. */
export function createHostAdmission() {
  // Kept apart from principals: capacity eviction may replace an idle lane,
  // and a connection listening for refusals must still hear its successor's.
  const refusals = new Map<string, Set<(kind: CommunityRefusal) => void>>();
  const principals = new Map<
    string,
    {
      live: ReturnType<typeof createLiveAdmission>;
      api: ReturnType<typeof createApiAdmission>;
      streams: number;
    }
  >();
  const admission = (endpoint: string, viewer: string) => {
    const key = JSON.stringify([endpoint, viewer]);
    let principal = principals.get(key);
    if (!principal) {
      for (const [id, entry] of principals)
        if (
          !entry.streams &&
          entry.api.idle() &&
          entry.api.presenceIdle() &&
          entry.live.delay() === 0 &&
          entry.live.presenceIdle()
        )
          principals.delete(id);
      if (principals.size >= 64)
        throw new Error("Relay admission owner capacity reached");
      principal = {
        live: createLiveAdmission(),
        api: createApiAdmission((kind) => {
          for (const listener of [...(refusals.get(key) ?? [])]) listener(kind);
        }),
        streams: 0,
      };
      principals.set(key, principal);
    }
    return principal;
  };
  /** Hear every community-wide refusal this principal's requests meet. */
  const observeRefusal = (
    endpoint: string,
    viewer: string,
    listener: (kind: CommunityRefusal) => void,
  ) => {
    const key = JSON.stringify([endpoint, viewer]);
    const listeners = refusals.get(key) ?? new Set();
    refusals.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && refusals.get(key) === listeners)
        refusals.delete(key);
    };
  };
  return Object.assign(admission, { observeRefusal });
}
