import { npubEncode } from "nostr-tools/nip19";

export type NamingIdentity = {
  pubkey: string;
  name: string;
  isAgent?: boolean;
  ownerPubkey?: string;
};

/** Display policy only. Neither a readable owner nor a key suffix grants authority. */
export function resolveIdentityNames(
  identities: readonly NamingIdentity[],
  viewer?: string,
  candidates?: readonly string[],
) {
  viewer = viewer?.toLowerCase();
  const unique = new Map(
    identities.map((row) => [
      row.pubkey.toLowerCase(),
      { ...row, ownerPubkey: row.ownerPubkey?.toLowerCase() },
    ]),
  );
  const selected =
    candidates && new Set(candidates.map((key) => key.toLowerCase()));
  const rows = [...unique]
    .filter(([key]) => !selected || selected.has(key))
    .map(([key, identity]) => {
      const mine =
        !!viewer && (key === viewer || identity.ownerPubkey === viewer);
      return {
        key,
        identity,
        base: identity.name.trim(),
        label: identity.name.trim(),
        priority: identity.isAgent ? (mine ? 2 : 3) : key === viewer ? 0 : 1,
        mine,
        length: 0,
        suffix: undefined as string | undefined,
      };
    });
  // Recheck finished labels, including collisions with literal names and suffixes.
  for (;;) {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.label) ?? [];
      group.push(row);
      groups.set(row.label, group);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    if (!collisions.length) break;
    for (const group of collisions) {
      const best = Math.min(...group.map((row) => row.priority));
      const winner = group.filter((row) => row.priority === best);
      const changing = group.filter(
        (row) => winner.length !== 1 || row !== winner[0],
      );
      let qualified = false;
      for (const row of changing) {
        const owner = row.identity.ownerPubkey
          ? unique.get(row.identity.ownerPubkey)?.name.trim()
          : undefined;
        const readable =
          row.identity.isAgent && !row.length
            ? !row.mine && owner
              ? `${owner}’s ${row.identity.name.trim()}`
              : group.some((other) => !other.identity.isAgent)
                ? `${row.identity.name.trim()} (agent)`
                : row.base
            : row.base;
        if (readable !== row.base) {
          row.base = readable;
          row.label = readable;
          qualified = true;
        }
      }
      if (qualified) continue;
      for (const row of changing) {
        row.length = row.length ? row.length + 1 : 4;
        row.suffix = npubEncode(row.key).slice(-row.length);
        row.label = `${row.base} · ${row.suffix}`;
      }
    }
  }
  return new Map(
    rows.map((row) => [row.key, { name: row.label, qualifier: row.suffix }]),
  );
}
