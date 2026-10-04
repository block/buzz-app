import {
  mergeReadStates,
  READ_STATE_KEYS,
  type ReadState,
} from "./read-state-model";

/** The mark that already reads all `key` reads, if any. `frontier` looks up
 * marks that are being kept, plus `key` itself. */
export type CoveredFrontier = (
  key: string,
  frontier: (key: string) => number | undefined,
) => string | undefined;
/** Broader marks first: a channel or thread mark covers many messages, so
 * losing one makes old history unread again. Catch-up marks (`activity:`,
 * `thread-activity:`) come next: only this app reads them, so recent catch-up
 * must never push out a quiet channel's mark. Message marks only cover one. */
const scope = (key: string) =>
  !key.includes(":")
    ? 0
    : key.startsWith("thread:")
      ? 1
      : key.startsWith("activity:") || key.startsWith("thread-activity:")
        ? 2
        : 3;
/** Share of the budget that broad marks may fill before recent use decides.
 * The rest always goes to the most recently used marks, so a new read is never
 * dropped just because old channel or thread marks fill the budget. */
const SCOPED_SHARE = 0.75;
/** Frontier hints are bounded recent activity, not an everlasting receipt log (NIP-RS).
 * Up to `SCOPED_SHARE` of the budget, channel marks outrank thread marks, then
 * catch-up marks, then message marks. The rest goes by local interaction order,
 * which wins over event time so reading old history still synchronizes.
 * Every override group and its direct frontier is protected; pressure can never lose a floor.
 *
 * Marks that `covered` proves redundant are dropped only after the budget has
 * chosen what to keep, and only when their covering mark was kept. The freed
 * space then goes to the next marks in line. A dropped mark gives its recency
 * to its cover, so a smaller limit later (such as the synced one) protects the
 * cover as it would have protected the dropped read.
 */
export function retainRead(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  maxBytes = 96 * 1024,
  covered?: CoveredFrontier,
): { state: ReadState; recent: Readonly<Record<string, number>> } {
  const frontiers = new Map<string, number>();
  let protectedState: ReadState = { frontiers: {}, overrides: {} };
  for (const state of states) {
    for (const [key, value] of Object.entries(state.frontiers))
      frontiers.set(key, Math.max(frontiers.get(key) ?? 0, value));
    protectedState = mergeReadStates(protectedState, {
      frontiers: {},
      overrides: state.overrides,
    });
  }
  // Overrides make inherited ancestry load-bearing (see below); keep everything then.
  const coveredBy = Object.keys(protectedState.overrides).length
    ? undefined
    : covered;
  const encoder = new TextEncoder();
  let used = encoder.encode(
    JSON.stringify({ v: 1, client_id: clientId, contexts: {} }),
  ).byteLength;
  let keys = 0;
  const retained = new Map<string, number>();
  const frontierKey = (key: string) =>
    /^(ov_|esc:)/.test(key) ? `esc:${key}` : key;
  // Separators are counted per entry, so release can return exactly what take spent.
  const cost = (key: string, value: number) =>
    encoder.encode(JSON.stringify(key)).byteLength + 2 + String(value).length;
  const take = (key: string, value: number, share = 1) => {
    const size = cost(key, value);
    if (used + size > maxBytes * share || keys >= READ_STATE_KEYS * share)
      return false;
    used += size;
    keys++;
    return true;
  };
  for (const [key, value] of Object.entries(protectedState.overrides)) {
    for (const [prefix, timestamp] of [
      ["ov_s:", value.set],
      ["ov_c:", value.clear],
      ["ov_b:", value.baseline],
    ] as const)
      if (!take(`${prefix}${key}`, timestamp))
        throw new Error(
          "Read override capacity reached; saved floors retained",
        );
    const frontier = frontiers.get(key);
    if (frontier !== undefined) {
      if (!take(frontierKey(key), frontier))
        throw new Error(
          "Read override capacity reached; saved floors retained",
        );
      retained.set(key, frontier);
    }
  }
  // Encrypted registers do not carry trustworthy ancestry. Preserve every possible
  // inherited channel/thread frontier while any override exists: pruning a parent
  // could otherwise reactivate a child register. Only frontier-only msg hints are free.
  if (Object.keys(protectedState.overrides).length) {
    for (const [key, value] of frontiers) {
      if (retained.has(key) || key.startsWith("msg:")) continue;
      if (!take(frontierKey(key), value))
        throw new Error(
          "Read override ancestry capacity reached; saved floors retained",
        );
      retained.set(key, value);
    }
  }
  const nextRecent: Record<string, number> = { ...recent };
  const byUse = ([a, av]: [string, number], [b, bv]: [string, number]) =>
    (nextRecent[b] ?? 0) - (nextRecent[a] ?? 0) ||
    bv - av ||
    a.localeCompare(b);
  const scoped = [...frontiers].sort(
    (a, b) => scope(a[0]) - scope(b[0]) || byUse(a, b),
  );
  const byRecent = [...frontiers].sort(byUse);
  // A dropped mark and the kept mark that covered it when it was dropped.
  const dropped = new Map<string, string>();
  const keptCover = (key: string, value: number) => {
    const cover = coveredBy?.(key, (other) =>
      other === key ? value : retained.get(other),
    );
    return cover !== undefined && cover !== key && retained.has(cover)
      ? cover
      : undefined;
  };
  // A mark that a kept mark already covers is dropped as it comes up, without
  // taking space, so refilling never admits and then frees the same slot.
  const admit = (key: string, value: number, share = 1) => {
    const cover = keptCover(key, value);
    if (cover !== undefined) {
      dropped.set(key, cover);
      return true;
    }
    if (!take(frontierKey(key), value, share)) return false;
    retained.set(key, value);
    return true;
  };
  const select = () => {
    for (const [key, value] of scoped) {
      if (retained.has(key) || dropped.has(key)) continue;
      // Stop at the first broad mark that does not fit, so a narrower mark
      // never takes the share ahead of it.
      if (!admit(key, value, SCOPED_SHARE)) break;
    }
    for (const [key, value] of byRecent)
      if (!retained.has(key) && !dropped.has(key)) admit(key, value);
  };
  select();
  // A cover admitted after the marks it covers frees them here. Only then can
  // refilling keep more, so repeat until nothing drops.
  let pruned = true;
  while (coveredBy && pruned) {
    pruned = false;
    // Prune against the kept marks only: a cover that did not fit cannot
    // replace anything. Decide on one snapshot so a cover is never pruned
    // after it has already replaced another mark.
    const covers = new Map<string, string>();
    for (const [key, value] of retained) {
      const cover = keptCover(key, value);
      if (cover !== undefined) covers.set(key, cover);
    }
    for (const [key, cover] of covers) {
      // Chains end at a kept mark: scopes only get broader along them.
      let last = cover;
      for (let hops = 0; covers.has(last) && hops < covers.size; hops++)
        last = covers.get(last) as string;
      if (covers.has(last)) continue;
      const value = retained.get(key) as number;
      retained.delete(key);
      dropped.set(key, cover);
      pruned = true;
      used -= cost(frontierKey(key), value);
      keys--;
    }
    if (pruned) select();
  }
  // A dropped mark gives its recency to the kept mark at the end of its chain.
  for (const [key, cover] of dropped) {
    if (nextRecent[key] === undefined) continue;
    let last = cover;
    for (let hops = 0; dropped.has(last) && hops < dropped.size; hops++)
      last = dropped.get(last) as string;
    if (retained.has(last))
      nextRecent[last] = Math.max(nextRecent[last] ?? 0, nextRecent[key]);
  }
  const state = Object.freeze({
    frontiers: Object.freeze(Object.fromEntries(retained)),
    overrides: protectedState.overrides,
  });
  return {
    state,
    recent: Object.freeze(
      Object.fromEntries(
        Object.entries(nextRecent).filter(([key]) => retained.has(key)),
      ),
    ),
  };
}
/** `retainRead` when the caller keeps no recency, such as a publication. */
export function retainReadState(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  maxBytes?: number,
  covered?: CoveredFrontier,
): ReadState {
  return retainRead(states, recent, clientId, maxBytes, covered).state;
}

/** Local-only receipts evicted from the sync journal. Never passed to publication. */
export const READ_RESERVE_KEYS = 5000;
export const READ_RESERVE_BYTES = 512 * 1024;
export function retainLocalRead(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  reserve: Readonly<Record<string, number>> = {},
  covered?: CoveredFrontier,
) {
  const frontiers = new Map(Object.entries(reserve));
  const overrides = new Set(
    states.flatMap((state) => Object.keys(state.overrides)),
  );
  const returning: Record<string, number> = {};
  for (const state of states)
    for (const [key, value] of Object.entries(state.frontiers)) {
      const previous = frontiers.get(key);
      if (previous !== undefined) returning[key] = previous;
      frontiers.set(key, Math.max(previous ?? 0, value));
    }
  // Direct override floors belong in the journal. Possible inherited floors
  // stay protected in the reserve instead of overflowing the smaller journal.
  for (const key of overrides) {
    const value = frontiers.get(key);
    if (value !== undefined) returning[key] = value;
  }
  const kept = retainRead(
    [...states, { frontiers: returning, overrides: {} }],
    recent,
    clientId,
    undefined,
    covered,
  );
  for (const key of Object.keys(kept.state.frontiers)) frontiers.delete(key);
  const encoder = new TextEncoder();
  let bytes = 2;
  const entries: [string, number][] = [];
  const protectedKey = (key: string) =>
    overrides.size > 0 && !key.startsWith("msg:");
  // Keep inherited floors first (a subset of the already bounded reserve), then
  // broad receipts before messages. Event age breaks ties within each scope.
  // Journal recency still controls newly read old history and sync.
  for (const [key, value] of [...frontiers].sort(
    ([a, av], [b, bv]) =>
      Number(protectedKey(b)) - Number(protectedKey(a)) ||
      scope(a) - scope(b) ||
      bv - av ||
      a.localeCompare(b),
  )) {
    const cost =
      encoder.encode(JSON.stringify(key)).byteLength +
      1 +
      String(value).length +
      (entries.length ? 1 : 0);
    if (
      entries.length >= READ_RESERVE_KEYS ||
      bytes + cost > READ_RESERVE_BYTES
    )
      break;
    entries.push([key, value]);
    bytes += cost;
  }
  return { ...kept, reserve: Object.freeze(Object.fromEntries(entries)) };
}
