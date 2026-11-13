import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { attestedOwner } from "../../features/agents/owner-attestation";

/** Review records inherit the relay's private-channel boundary. */
export function reviewChannelMember(
  channel: ChannelSummary,
  viewer: string | undefined,
) {
  return (
    !!viewer &&
    channel.members?.includes(viewer) === true &&
    !channel.cached &&
    !channel.metadataCached &&
    !channel.metadataPending &&
    !channel.pending &&
    !channel.archived &&
    !channel.huddle &&
    channel.visibility === "private" &&
    (channel.channelType === "stream" || channel.channelType === "forum")
  );
}

export function reviewChannel(
  session: RelaySession,
  id: string,
  write = false,
) {
  const list = session.channels.list();
  const channel = list.channels.find((item) => item.id === id);
  if (
    list.status !== "ready" ||
    !channel ||
    !reviewChannelMember(channel, session.viewer) ||
    (write && channel.readOnly)
  )
    throw new Error(
      "Reviews require current membership in a private review channel. Reconnect or choose another channel.",
    );
  return channel;
}

/** Refresh membership at explicit mutations; subscriptions invalidate presentation. */
export async function confirmReviewChannel(
  session: RelaySession,
  channel: string,
  signal: AbortSignal,
) {
  reviewChannel(session, channel, true);
  if (
    !session.channels.refreshRoster ||
    !(await session.channels.refreshRoster(channel, {
      signal,
      consistency: "strong",
    }))
  )
    throw new Error(
      "Could not confirm review channel membership. Reload and try again.",
    );
  const details = await session.channelDetails.load(channel, signal);
  signal.throwIfAborted();
  if (details.visibility !== "private")
    throw new Error("Review configurations require a private channel.");
  return reviewChannel(session, channel, true);
}

/** Display hints and local custody are not ownership evidence. */
export async function reviewAgentOwners(
  session: RelaySession,
  keys: readonly string[],
  signal: AbortSignal,
) {
  const owners = new Map<string, string>();
  if (!session.snapshotRead)
    throw new Error("Agent ownership reads are unavailable.");
  const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const profiles = await session.snapshotRead(
      [
        {
          kinds: [0],
          authors: batch,
          limit: batch.length,
          consistency: "strong",
        },
      ],
      { signal },
    );
    for (const key of batch) {
      const profile = profiles
        .filter((event) => event.kind === 0 && event.pubkey === key)
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        )[0];
      const owner = profile && (await attestedOwner(profile));
      if (owner) owners.set(key, owner);
    }
  }
  signal.throwIfAborted();
  return owners;
}

export async function confirmReviewAgents(
  session: RelaySession,
  channel: string,
  keys: readonly string[],
  signal: AbortSignal,
  delivering = false,
) {
  await confirmReviewChannel(session, channel, signal);
  const owners = await reviewAgentOwners(session, keys, signal);
  const assertCurrent = () => {
    signal.throwIfAborted();
    const current = reviewChannel(session, channel, true);
    for (const key of keys) {
      const owner = owners.get(key);
      if (!owner || !current.members?.includes(owner))
        throw new Error(
          "Each reviewer must have verified ownership by a member of this review channel. Update the lane's agents.",
        );
      if (delivering && !current.members.includes(key))
        throw new Error(
          "The reviewer must also belong to this channel to receive review requests. Ask its owner to add it.",
        );
    }
  };
  assertCurrent();
  return assertCurrent;
}
