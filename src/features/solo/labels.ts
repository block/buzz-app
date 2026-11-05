import type { ChannelSummary } from "../relay/contracts.ts";

/** Presentation provenance in the relay's existing NIP-CL labels, never access. */
export const SOLO_NAMED_LABEL = "buzz.session.named";
/** NIP-CL label marking a Solo chat: a channel whose owner talks with
 * their agents at top level. Every member and agent reads it from channel
 * metadata. Presentation and composition only; ordinary channel permissions
 * remain the access authority. Conversion to a channel clears it. */
export const SOLO_LABEL = "buzz.solo";

export const SOLO_ACCESS_DISCLOSURE =
  "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.";

export function soloShareDisclosure(multiple = false): string {
  return `Everyone in this community can read ${multiple ? "each chat’s" : "its"} full history, Canvas, workspace folders, and agent instructions.`;
}

/** Switching an open Solo chat to Private never removes its members. */
export function soloRetainedAccessWarning(
  base: Pick<ChannelSummary, "visibility" | "joinRole">,
  mayHaveGuestMembers = true,
): string {
  if (base.visibility !== "public") return "";
  if (base.joinRole !== "guest")
    return "People who already joined remain members and keep their access until you remove them in People.";
  return mayHaveGuestMembers
    ? "People who joined while it was View only are members and keep reading until you remove them in People."
    : "";
}

export function soloLabels(labels: readonly string[] | undefined): boolean {
  return !!labels?.includes(SOLO_LABEL);
}

/** The viewer's own Solo chat: the relay-signed roster makes them its owner.
 * Anyone else in a shared Solo chat sees its flat treatment and finds it where
 * it was shared. An unknown role is not ownership. */
export function ownSolo(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        viewerRole?: ChannelSummary["viewerRole"];
      }>
    | undefined,
): boolean {
  return channel?.channelType === "solo" && channel.viewerRole === "owner";
}

/** Who owns a Solo chat, for presentation: its creator while still an owner,
 * else the roster's first owner, or the creator for an older chat whose roster
 * names none. Never access. */
export function soloOwner(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        owners?: readonly string[] | undefined;
        creator?: string | undefined;
      }>
    | undefined,
): string | undefined {
  if (channel?.channelType !== "solo") return undefined;
  const { owners, creator } = channel;
  if (!owners?.length) return creator;
  return creator && owners.includes(creator) ? creator : owners[0];
}

export function soloChatLinkName(channel: { id: string; name: string }) {
  // Unnamed chats still carry their starting title from the first prompt.
  return channel.name.trim() || channel.id.slice(0, 8);
}

/** A Solo chat the viewer chose: their own, or one they joined as a viewer.
 * Solo chats add people only as members, so a viewer role is treated as
 * joined. It is not proof: a legacy invitation could admit a Guest, and that
 * invitee is accepted as chosen too (docs/solo/sharing.md). Someone else adding
 * the viewer as a member is not their choice, and an unknown role is neither. */
export function chosenSolo(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        viewerRole?: ChannelSummary["viewerRole"];
      }>
    | undefined,
): boolean {
  return (
    ownSolo(channel) ||
    (channel?.channelType === "solo" && channel.viewerRole === "guest")
  );
}

/** Someone else's Solo chat the viewer didn't choose: reachable from where it
 * was shared, never listed, and only a mention earns attention. */
export function quietSolo(channel: Parameters<typeof chosenSolo>[0]): boolean {
  return channel?.channelType === "solo" && !chosenSolo(channel);
}

/** The sidebar's Solo inventory: the unarchived chats the viewer chose;
 * unknown metadata never implies Solo or a choice. */
export function eligibleSolo(channel: ChannelSummary) {
  return !channel.archived && chosenSolo(channel);
}
