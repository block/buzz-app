import type {
  Attachment,
  ChannelMessage,
  MessageReaction,
} from "../relay/contracts";
import { validReactionContent } from "../relay/emoji";
import type { Delivery } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia, avatarSource } from "../../shared/avatar-source";

/** One message as a companion window presents it: bounded strings, resolved
 * media sources, no session references. Shared by the Huddle discussion and
 * pop-out windows; the native DTO (`DiscussionRow`) validates the same caps. */
export type CompanionRow = {
  id: string;
  author: string;
  authorId: string;
  channelId: string;
  attachments: (Attachment & {
    source: string | null;
    previewSource: string | null;
  })[];
  picture: string | null;
  /** Original profile URL; picture remains its authorized media source. */
  pictureUrl?: string | null;
  text: string;
  mentions?: readonly string[];
  mentionNames?: Record<string, string>;
  edited?: boolean;
  attachmentSeams?: readonly number[];
  mentionReferences?: readonly string[];
  time: number;
  delivery: Delivery;
  /** Reaction groups as main knows them, bounded for the native DTO: at most
   * 64 groups and 128 events each, the viewer's own events first so a capped
   * list still decides add-versus-remove correctly. */
  reactions?: MessageReaction[];
  /** Some reaction groups or events were left out of this projection. */
  reactionsLimited?: boolean;
  /** What the viewer may do to this message, decided by main with the same
   * predicates as its own menu; absent for rows that take no management. */
  management?: CompanionManagement | undefined;
  /** For messages the viewer may edit: the exact source text and attachment
   * source main expects an edit to build on. */
  editable?: { sourceContent: string; attachmentSourceId: string } | undefined;
  /** The author is an agent (profile hint): View activity may be offered. */
  authorIsAgent?: boolean;
  /** Plugin message actions main would offer for this row, for a labelled
   * handoff to the main window; bound to the contribution instance. */
  actions?: CompanionAction[] | undefined;
};
export type CompanionAction = {
  /** Contribution key and revision: the exact registered instance. */
  key: string;
  revision: string;
  title: string;
};
export type CompanionManagement = {
  unread: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canSendToChannel: boolean;
  canReport: boolean;
};
const MAX_REACTION_GROUPS = 64;
const MAX_REACTION_EVENTS = 128;
/** `messages.remove` takes at most 100 events; a toggle removes every own one. */
const MAX_OWN_REACTION_EVENTS = 100;
const hex = /^[0-9a-f]{64}$/;
export function projectReactions(
  reactions: readonly MessageReaction[],
  viewer: string | undefined,
): Pick<CompanionRow, "reactions" | "reactionsLimited"> {
  let limited = false;
  const groups = reactions.flatMap((group) => {
    if (!validReactionContent(group.content)) return [];
    const emoji =
      group.emoji &&
      group.emoji.shortcode.length <= 64 &&
      bytes(group.emoji.url) <= 8192
        ? { shortcode: group.emoji.shortcode, url: group.emoji.url }
        : undefined;
    if (group.emoji && !emoji) return [];
    const events = group.events.filter(
      (event) => hex.test(event.id) && hex.test(event.authorId),
    );
    const own = events
      .filter((event) => event.authorId === viewer)
      .slice(0, MAX_OWN_REACTION_EVENTS);
    const others = events.filter((event) => event.authorId !== viewer);
    const kept = [...own, ...others].slice(0, MAX_REACTION_EVENTS);
    if (kept.length < events.length) limited = true;
    return [
      {
        content: group.content,
        ...(emoji ? { emoji } : {}),
        events: kept.map(({ id, authorId }) => ({ id, authorId })),
      },
    ];
  });
  if (groups.length > MAX_REACTION_GROUPS) limited = true;
  return {
    reactions: groups.slice(0, MAX_REACTION_GROUPS),
    ...(limited ? { reactionsLimited: true } : {}),
  };
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
// Keep one malformed metadata value from rejecting the entire native view.
// URLs are omitted, never truncated into a different resource.
const bounded = (value: string | undefined, limit: number) =>
  value !== undefined && bytes(value) <= limit ? value : undefined;

export function projectCompanionRow(
  session: Pick<RelaySession, "media" | "viewer">,
  profiles: ReturnType<RelaySession["profiles"]["snapshot"]>,
  r: ChannelMessage,
  channelId: string,
): CompanionRow {
  const profile = profiles.get(r.authorId);
  const pictureUrl = avatarSource(profile?.picture);
  const picture = avatarMedia(pictureUrl, session.media);
  return {
    id: r.id,
    authorId: r.authorId,
    channelId,
    attachments: r.attachments.flatMap((attachment) => {
      const url = bounded(attachment.url, 8192);
      if (!url) return [];
      const mime = bounded(attachment.mime, 256);
      const name = bounded(attachment.name, 4096);
      const blurhash = bounded(attachment.blurhash, 256);
      const previewUrl = bounded(attachment.previewUrl, 8192);
      return [
        {
          url,
          kind: attachment.kind,
          ...(mime !== undefined ? { mime } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(blurhash !== undefined ? { blurhash } : {}),
          ...(previewUrl !== undefined ? { previewUrl } : {}),
          ...(attachment.size !== undefined ? { size: attachment.size } : {}),
          ...(attachment.duration !== undefined
            ? { duration: attachment.duration }
            : {}),
          ...(attachment.dimensions
            ? { dimensions: attachment.dimensions }
            : {}),
          ...(attachment.voiceNote ? { voiceNote: attachment.voiceNote } : {}),
          ...(attachment.waveform ? { waveform: attachment.waveform } : {}),
          source: bounded(session.media(url), 8192) ?? null,
          previewSource: previewUrl
            ? (bounded(session.media(previewUrl), 8192) ?? null)
            : null,
        },
      ];
    }),
    author: (
      profile?.name ||
      formatPublicKey(r.authorId) ||
      "Participant"
    ).slice(0, 1000),
    picture: picture && bytes(picture) <= 8192 ? picture : null,
    pictureUrl: pictureUrl && bytes(pictureUrl) <= 8192 ? pictureUrl : null,
    text: r.content.slice(0, 16000),
    mentions: r.mentions,
    edited: r.edited === true,
    attachmentSeams: r.attachmentSeams ?? [],
    mentionNames: Object.fromEntries(
      [...new Set([...r.mentions, ...(r.mentionReferences ?? [])])].flatMap(
        (key) => {
          const name = profiles.get(key)?.name;
          return name && name.length <= 1000 ? [[key, name]] : [];
        },
      ),
    ),
    mentionReferences: r.mentionReferences ?? [],
    time: r.createdAt,
    delivery: r.authorId === session.viewer ? (r.delivery ?? "seen") : "seen",
    ...projectReactions(r.reactions, session.viewer),
    ...(r.agentEnvelope || profile?.isAgent ? { authorIsAgent: true } : {}),
  };
}
