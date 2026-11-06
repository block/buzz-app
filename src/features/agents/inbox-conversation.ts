import { channelVisibility } from "../relay/channel-details-protocol";
import { channelIdentity } from "../relay/channel-labels";
import { soloChannelMetadata } from "../relay/discovery";
import type { RelaySession } from "../relay/session";

const unavailable = () =>
  new Error(
    "Inbox requires a verified private DM or Solo chat with only your owner and you. Please retry there.",
  );

function exactMembers(
  members: readonly string[] | undefined,
  owner: string,
  bestie: string,
) {
  const keys = new Set(members);
  return (
    owner !== bestie && keys.size === 2 && keys.has(owner) && keys.has(bestie)
  );
}

/** Current session evidence also fences an older finite response: newer live
 * membership or visibility changes must not be overwritten by an allowed read. */
export function privateInboxConversation(
  session: RelaySession,
  channel: string,
  owner: string,
  bestie: string,
) {
  const current =
    session.channels.get?.(channel) ??
    session.channels.list().channels.find(({ id }) => id === channel);
  return (
    !!current &&
    !current.cached &&
    !current.pending &&
    !current.metadataPending &&
    !current.archived &&
    current.visibility === "private" &&
    (current.channelType === "dm" || current.channelType === "solo") &&
    exactMembers(current.members, owner, bestie)
  );
}

/** Fresh relay-authored metadata AND roster, never model arguments or cached
 * labels alone. Called before loading owner notifications and before release. */
export async function checkInboxConversation(
  session: RelaySession,
  channel: string | undefined,
  owner: string,
  bestie: string,
) {
  const authority = session.relayAuthor;
  if (!channel || !authority || owner === bestie) throw unavailable();
  const events = await session.readRemote(
    [39000, 39002].map((kind) => ({
      kinds: [kind],
      authors: [authority],
      "#d": [channel],
      consistency: "strong" as const,
      limit: 2,
    })),
    { priority: "foreground" },
  );
  const metadata = events.filter(({ kind }) => kind === 39000);
  const rosters = events.filter(({ kind }) => kind === 39002);
  if (events.length !== 2 || metadata.length !== 1 || rosters.length !== 1)
    throw unavailable();
  for (const event of events) {
    const coordinates = event.tags.filter(([name]) => name === "d");
    if (
      event.pubkey !== session.relayAuthor ||
      coordinates.length !== 1 ||
      coordinates[0]?.length !== 2 ||
      coordinates[0][1] !== channel
    )
      throw unavailable();
  }
  const meta = metadata[0];
  const roster = rosters[0];
  if (!meta || !roster) throw unavailable();
  const members = roster.tags.filter(([name]) => name === "p");
  if (
    members.some((entry) => !/^[0-9a-f]{64}$/.test(entry[1] ?? "")) ||
    !exactMembers(
      members.map((entry) => entry[1] ?? ""),
      owner,
      bestie,
    ) ||
    channelVisibility(meta) !== "private" ||
    !(channelIdentity(meta).type === "dm" || soloChannelMetadata(meta)) ||
    !privateInboxConversation(session, channel, owner, bestie)
  )
    throw unavailable();
}
