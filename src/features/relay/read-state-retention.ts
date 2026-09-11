import {
  mergeReadStates,
  READ_STATE_KEYS,
  type ReadState,
} from "./read-state-model";

/** Frontier hints are bounded recent activity, not an everlasting receipt log (NIP-RS).
 * Local interaction order wins over event time so reading old history still synchronizes.
 * Every override group and its direct frontier is protected; pressure can never lose a floor.
 */
export function retainReadState(
  states: readonly ReadState[],
  recent: Readonly<Record<string, number>>,
  clientId: string,
  maxBytes = 96 * 1024,
): ReadState {
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
  const encoder = new TextEncoder();
  let used = encoder.encode(
    JSON.stringify({ v: 1, client_id: clientId, contexts: {} }),
  ).byteLength;
  let keys = 0;
  const retained = new Map<string, number>();
  const take = (key: string, value: number) => {
    const cost =
      encoder.encode(JSON.stringify(key)).byteLength +
      1 +
      String(value).length +
      (keys ? 1 : 0);
    if (used + cost > maxBytes || keys >= READ_STATE_KEYS) return false;
    used += cost;
    keys++;
    return true;
  };
  const frontierKey = (key: string) =>
    /^(ov_|esc:)/.test(key) ? `esc:${key}` : key;
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
  for (const [key, value] of [...frontiers].sort(
    ([a, av], [b, bv]) =>
      (recent[b] ?? 0) - (recent[a] ?? 0) || bv - av || a.localeCompare(b),
  )) {
    if (!retained.has(key) && take(frontierKey(key), value))
      retained.set(key, value);
  }
  return Object.freeze({
    frontiers: Object.freeze(Object.fromEntries(retained)),
    overrides: protectedState.overrides,
  });
}
export function retainReadOrder(
  state: ReadState,
  recent: Readonly<Record<string, number>>,
) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(recent).filter(([key]) =>
        Object.hasOwn(state.frontiers, key),
      ),
    ),
  );
}
