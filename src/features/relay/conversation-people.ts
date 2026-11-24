import type { ChannelSummary, Profile } from "./contracts";

const none: readonly string[] = [];

/** Everyone in a conversation besides you, agents included. */
export function conversationOthers(
  channel: Pick<ChannelSummary, "channelType" | "participants" | "members">,
  viewer: string | undefined,
): readonly string[] {
  if (channel.channelType === "dm") return channel.participants ?? none;
  return channel.members?.filter((key) => key !== viewer) ?? none;
}

/** Past this many others, every member counts as a person; telling its
 * agents apart isn't worth loading every member's profile. */
export const identityProfileLimit = 32;

/** The people in a conversation besides you: agents never count, and a
 * member whose profile hasn't loaded counts as a person. */
export function conversationPeople(
  others: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
  agents?: ReadonlySet<string>,
): readonly string[] {
  return others.length <= identityProfileLimit
    ? others.filter(
        (key) => !profiles.get(key)?.isAgent && !agents?.has(key),
      )
    : others;
}

/** Whether a member is still unknown: no loaded profile, and not one of the
 * agents this device already knows. */
export function unknownMember(
  key: string,
  profiles: ReadonlyMap<string, Profile>,
  agents?: ReadonlySet<string>,
) {
  return !profiles.has(key) && !agents?.has(key);
}

/** Whether anyone in the community can join and post: Public, not View
 * only. The relay admits Members unless it says Guest. */
export function openToPosting(
  channel: Pick<ChannelSummary, "visibility" | "joinRole">,
) {
  return channel.visibility === "public" && channel.joinRole !== "guest";
}

/** The people rule: a named conversation only you and your agents can post
 * in. No people besides you, and not Public. Without its roster, a chat you
 * started with the older Solo tag counts. */
export function isSoloConversation(
  channel: ChannelSummary,
  viewer: string | undefined,
  profiles: ReadonlyMap<string, Profile>,
  agents?: ReadonlySet<string>,
) {
  if (channel.channelType === "dm" || openToPosting(channel)) return false;
  if (!channel.members?.length)
    return channel.channelType === "solo" && channel.creator === viewer;
  return (
    !!viewer &&
    channel.members.includes(viewer) &&
    !conversationPeople(conversationOthers(channel, viewer), profiles, agents)
      .length
  );
}

/** A conversation's kind by the people rule: one only you and your agents
 * can post in is a chat ("solo"); a chat anyone else can post in is a
 * channel ("stream"). DMs, forums, system channels and huddles keep theirs. */
export function peopleKind(
  channel: ChannelSummary,
  viewer: string | undefined,
  profiles: ReadonlyMap<string, Profile>,
  agents?: ReadonlySet<string>,
): ChannelSummary["channelType"] | "loading" {
  const type = channel.channelType;
  if (
    (type !== "solo" && type !== "stream" && type !== undefined) ||
    channel.huddle
  )
    return type;
  // An agent whose profile hasn't loaded would count as a person.
  const others = conversationOthers(channel, viewer);
  if (
    !openToPosting(channel) &&
    others.length <= identityProfileLimit &&
    others.some((key) => unknownMember(key, profiles, agents))
  )
    return "loading";
  if (isSoloConversation(channel, viewer, profiles, agents)) return "solo";
  return type === "solo" ? "stream" : type;
}
