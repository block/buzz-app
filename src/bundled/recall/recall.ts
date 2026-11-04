// recall: a turn in, a few quoted excerpts (or nothing) out.
//
//   find ──► choose ──► pack
//
// find gathers candidates the audience may see, choose asks the owner's decisions provider which ones help,
// pack fences what survives into a bounded block. Any failure yields nothing; the turn proceeds unchanged.
import { find } from "./find.ts";
import { choose } from "./choose.ts";
import { pack } from "./pack.ts";
import type { Deps, Turn } from "./types.ts";

export async function recall(
  turn: Turn,
  deps: Deps,
): Promise<string | undefined> {
  // Copy history while this turn owns the lease; inference happens in the background.
  const observing = deps.semantic?.observe(turn).catch(() => () => {});
  try {
    const candidates = await find(turn, deps.settings(), deps.semantic);
    if (!candidates.length) return undefined;
    const kept = await choose(candidates, turn, deps);
    return kept.length ? pack(kept) : undefined;
  } catch {
    return undefined; // a revoked lease or a failed read: this turn goes without recall
  } finally {
    if (observing) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<undefined>((resolve) => {
          timer = setTimeout(
            () => resolve(undefined),
            Math.max(0, turn.deadline - 100 - deps.now()),
          );
        });
        const commit = await Promise.race([observing, expired]);
        commit?.();
      } catch {
        // Optional indexing must not discard a completed recall answer.
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
