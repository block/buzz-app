// The owner tools' host side: read-only operations the app runs with its
// signed-in human's own session, for that human's agent, in the agent's own
// community. Every call resolves the binding again and checks it once more
// before returning anything, so a sign-out, account switch or reconnect during
// a call returns nothing.
import type {
  OwnerAccess,
  OwnerChannel,
  OwnerExecution,
  OwnerRole,
} from "../../buzz-mcp/client";
import { memberAuthority } from "../channel-members/administration-protocol";
import { communityDestination } from "../communities/destination";
import type { ChannelSummary } from "../relay/contracts";
import {
  lifecycleChannelId,
  lifecycleOffer,
} from "../relay/channel-lifecycle-protocol";
import type { RelaySession } from "../relay/session";

/** Whether this build lets agents read with their owner's access in
 * `community`: its exact canonical origin is in the build's list. */
export function ownerMcpEnabled(community: string | null | undefined) {
  if (!community) return false;
  try {
    return (import.meta.env.VITE_BUZZ_OWNER_MCP_COMMUNITIES ?? "")
      .split(" ")
      .includes(communityDestination(community).url);
  } catch {
    return false;
  }
}

export type OwnerSession = Pick<
  RelaySession,
  "relayAuthor" | "channels" | "readRemote" | "names" | "profiles"
>;
/** The owner's live session for the agent's community, as the host binds it
 * now. `signal` aborts when that binding is replaced. */
export type OwnerBinding = Readonly<{
  viewer: string;
  origin: string;
  session: OwnerSession;
  signal: AbortSignal;
}>;

const unavailable = () =>
  new Error(
    "Your owner's Buzz is not connected to this community as them, so owner tools are unavailable now.",
  );
const changed = () =>
  new Error(
    "Your owner's connection changed during the call, so nothing was returned. Try again.",
  );

/** `agent`'s owner reads. `bind` answers the owner's current binding for the
 * agent's community, or undefined when it may not be used now. */
export function createOwnerAccess(
  agent: Readonly<{ pubkey: string; owner: string }>,
  bind: () => OwnerBinding | undefined,
): OwnerAccess {
  const current = () => {
    const binding = bind();
    if (!binding || binding.signal.aborted || binding.viewer !== agent.owner)
      throw unavailable();
    return binding;
  };
  /** Runs `read` on the current binding; its answer only while the binding
   * still holds. */
  async function run<T>(
    signal: AbortSignal | undefined,
    read: (binding: OwnerBinding, signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    signal?.throwIfAborted();
    const binding = current();
    const bound = signal
      ? AbortSignal.any([signal, binding.signal])
      : binding.signal;
    let result: T;
    try {
      result = await read(binding, bound);
    } catch (error) {
      signal?.throwIfAborted();
      throw binding.signal.aborted ? changed() : error;
    }
    signal?.throwIfAborted();
    const now = bind();
    if (
      binding.signal.aborted ||
      now?.session !== binding.session ||
      now.viewer !== binding.viewer
    )
      throw changed();
    current();
    return result;
  }
  const execution = (binding: OwnerBinding): OwnerExecution => ({
    agent: agent.pubkey,
    owner: binding.viewer,
    community: binding.origin,
  });
  /** The relay-signed metadata, admin list and roster, read fresh. */
  const authority = async (
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ) => {
    const { session, viewer } = binding;
    const relayAuthor = session.relayAuthor;
    if (!relayAuthor) throw unavailable();
    const events = await session.readRemote(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong" as const,
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      { signal, priority: "foreground" },
    );
    signal.throwIfAborted();
    if (!events.some((event) => event.kind === 39000))
      throw new Error(
        `Channel ${id} was not found or your owner cannot see it.`,
      );
    return memberAuthority(events, id, viewer, relayAuthor);
  };
  /** Channel `id` as the owner's session knows it; never a system channel,
   * which `list()` never shows either. */
  const known = (session: OwnerSession, id: string) => {
    const item =
      session.channels.list().channels.find((each) => each.id === id) ??
      session.channels.get?.(id);
    if (!item || item.channelType === "system")
      throw new Error(
        `Channel ${id} is not in your owner's channels; owner_channel_list lists them.`,
      );
    return item;
  };
  const channelId = (id: string) => {
    try {
      return lifecycleChannelId(id);
    } catch {
      throw new Error("channel must be a channel ID.");
    }
  };

  return Object.freeze({
    channels: (signal?: AbortSignal) =>
      run(signal, (binding) => {
        const { channels } = binding.session;
        const list = channels.list();
        // Asks the owner's session to finish its list; reads only.
        if (list.status !== "ready") channels.ensureList();
        return {
          execution: execution(binding),
          channels: list.channels.map((item) =>
            ownerChannel(item, binding.viewer),
          ),
          partial: list.status !== "ready" || list.coverage === "partial",
          ...(list.error ? { error: list.error } : {}),
        };
      }),
    channel: (id: string, signal?: AbortSignal) =>
      run(signal, async (binding, bound) => {
        const summary = known(binding.session, channelId(id));
        const rights = await authority(binding, id, bound);
        const role = rights.roles[binding.viewer];
        const offer = lifecycleOffer(summary, binding.viewer, false);
        return {
          execution: execution(binding),
          channel: {
            ...ownerChannel(summary, binding.viewer),
            role: role ?? null,
            members: Object.keys(rights.roles).length,
            ...(summary.description
              ? { description: summary.description }
              : {}),
            ...(summary.joinRole ? { joinRole: summary.joinRole } : {}),
            ...(summary.ttlSeconds ? { ttlSeconds: summary.ttlSeconds } : {}),
            ...(summary.creator ? { creator: summary.creator } : {}),
            ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
          },
          capabilities: {
            manageRoles: rights.canManage,
            removeMembers: rights.canRemove,
            archive: !!role && !!offer?.canArchive,
            unarchive: !!role && !!offer?.canUnarchive,
            delete: !!role && !!offer?.canDelete,
          },
        };
      }),
    members: (
      id: string,
      page: Readonly<{ offset: number; limit: number }>,
      signal?: AbortSignal,
    ) =>
      run(signal, async (binding, bound) => {
        known(binding.session, channelId(id));
        const rights = await authority(binding, id, bound);
        const roster = Object.entries(rights.roles);
        const shown = roster.slice(page.offset, page.offset + page.limit);
        const keys = shown.map(([pubkey]) => pubkey);
        const { session } = binding;
        if (keys.length) await session.profiles.ensure(keys, "foreground");
        bound.throwIfAborted();
        const members = roster.map(([pubkey]) => pubkey);
        return {
          execution: execution(binding),
          channel: id,
          total: roster.length,
          members: shown.map(([pubkey, role]) => {
            const name =
              session.names.resolve(pubkey, undefined, members) ??
              session.profiles.snapshot().get(pubkey)?.name;
            return { pubkey, role, ...(name ? { name } : {}) };
          }),
        };
      }),
  });
}

function ownerChannel(item: ChannelSummary, viewer: string): OwnerChannel {
  const type = item.channelType;
  const role: OwnerRole | null | undefined =
    item.viewerRole ??
    (item.members
      ? item.members.includes(viewer)
        ? "member"
        : null
      : undefined);
  return {
    id: item.id,
    name: item.name,
    type:
      type === "stream" || type === "forum" || type === "dm" || type === "solo"
        ? type
        : "unknown",
    visibility: item.private
      ? "private"
      : item.visibility === "public"
        ? "open"
        : (item.visibility ?? "unknown"),
    archived: !!item.archived,
    ...(role !== undefined ? { role } : {}),
    ...(item.cached ? { cached: true as const } : {}),
    ...(item.members ? { members: item.members.length } : {}),
  };
}
