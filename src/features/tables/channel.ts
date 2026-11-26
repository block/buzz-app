import { bytesToHex } from "nostr-tools/utils";

type ChannelEvent = Readonly<{
  created_at: number;
  tags: readonly (readonly string[])[];
}>;
export type ReadEvents = (
  filters: readonly Readonly<Record<string, unknown>>[],
) => Promise<readonly ChannelEvent[]>;

/** An agent's tables channel: a UUID-shaped digest of its key, so every
 * session finds the same one. */
export const tablesChannel = (agent: string) =>
  digestId(`buzz.tables:channel:${agent}`);

export async function digestId(seed: string) {
  const hex = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    ),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The channel's relay metadata and roster, as `read` sees them. */
export async function channelState(read: ReadEvents, h: string) {
  const [meta, roster] = await Promise.all([
    read([{ kinds: [39000], "#d": [h] }]),
    read([{ kinds: [39002], "#d": [h] }]),
  ]);
  const newest = (events: readonly ChannelEvent[]) =>
    [...events].sort((a, b) => b.created_at - a.created_at)[0];
  const info = newest(meta);
  const members = newest(roster);
  return {
    exists: !!info,
    private: !!info?.tags.some(([k]) => k === "private"),
    rosterKnown: !!members,
    members: (members?.tags ?? [])
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => `${t[1]}:${t[3] || "member"}`)
      .sort(),
  };
}

export type ChannelState = Awaited<ReturnType<typeof channelState>>;

/** Why the channel is not private with `agent` as its only member and
 * owner, or `undefined` when it is. */
export function channelProblem(state: ChannelState, agent: string) {
  return state.private &&
    state.members.length === 1 &&
    state.members[0] === `${agent}:owner`
    ? undefined
    : `private: ${state.private}; members: ${state.members.join(", ") || "unknown"}`;
}
