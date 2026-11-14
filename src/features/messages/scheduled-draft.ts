import type { RelaySession } from "../relay/session";
import type { ScheduledMessage } from "../relay/scheduled-messages";
import { readView, viewRevision, replaceView } from "../../shared/view-state";
import { draftCounts } from "./draft-places";
import type { MentionDraft, DraftRecipient } from "./mention-draft";
import { foldMessages } from "../relay/fold";
import { profileMentionParts } from "./profile-mentions";
import { profileKey } from "../profiles/target";
import { MEDIA_TARGET_TAG } from "../relay/contracts";

export const scheduledDraftKey = (item: ScheduledMessage) =>
  item.destination.threadRootId
    ? `draft:${item.destination.channelId}:thread:${item.destination.threadRootId}`
    : `draft:${item.destination.channelId}`;

/** Save locally before cancelling remotely, so uncertain delivery never loses the draft. */
export async function cancelScheduledToDraft(
  session: RelaySession,
  item: ScheduledMessage,
) {
  const service = session.scheduledMessages;
  if (!service) throw new Error("Scheduled delivery is unavailable.");
  const event = service.event(item.id, item.revision),
    key = scheduledDraftKey(item),
    previous = viewRevision(session.scope, key);
  if (previous === undefined)
    throw new Error(
      "Draft storage is unavailable. The message is still scheduled.",
    );
  // A local composer draft cannot encode these delivery bindings yet.
  const parent = event.tags.find(
    ([name, , , marker]) => name === "e" && marker === "reply",
  )?.[1];
  if (
    event.tags.some(([name]) =>
      ["imeta", "model", "effort", MEDIA_TARGET_TAG].includes(name ?? ""),
    ) ||
    (parent && parent !== item.destination.threadRootId)
  )
    throw new Error(
      "This message has attachments or delivery settings that drafts cannot preserve yet. It is still scheduled; edit or send it from Scheduled.",
    );
  if (
    event.content.trim().startsWith("/") &&
    !event.tags.some(([name]) => name === "p")
  )
    throw new Error(
      "This message starts with a command and cannot be restored safely. It is still scheduled.",
    );
  const prior = readView<unknown>(session.scope, key, "");
  if (draftCounts(session, key, prior))
    throw new Error(
      "There is already a draft in this conversation. Send or clear it before saving this message to drafts.",
    );
  const row = foldMessages(
    item.destination.channelId,
    session.relayAuthor ?? "",
    [event],
    { includeReplies: true },
  )[0];
  if (!row)
    throw new Error(
      "This message could not be restored. It is still scheduled.",
    );
  const profiles = session.profiles.snapshot();
  let recipients: DraftRecipient[] = [];
  let text = "";
  for (const part of profileMentionParts(
    { ...row, content: event.content },
    profiles,
    session.agentLibrary.snapshot().identities,
  )) {
    const start = text.length;
    text += part.text;
    const pubkey = part.target ? profileKey(part.target) : undefined;
    if (pubkey && row.mentions.includes(pubkey))
      recipients.push({
        pubkey,
        name: part.text.slice(1),
        start,
        end: text.length,
      });
  }
  for (const pubkey of row.mentions.filter(
    (id) => !recipients.some((recipient) => recipient.pubkey === id),
  )) {
    const name = profiles.get(pubkey)?.name ?? pubkey.slice(0, 12),
      prefix = `@${name} `;
    recipients = recipients.map((recipient) => ({
      ...recipient,
      start: recipient.start + prefix.length,
      end: recipient.end + prefix.length,
    }));
    recipients.unshift({ pubkey, name, start: 0, end: prefix.length - 1 });
    text = prefix + text;
  }
  const draft: MentionDraft = { text, recipients };
  if (replaceView(session.scope, key, previous, draft) !== "saved")
    throw new Error(
      "The draft changed or could not be saved. The message is still scheduled.",
    );
  try {
    await service.cancel(item.id, item.revision);
  } catch {
    throw new Error(
      "Your draft is saved, but cancellation is not confirmed. Refresh Scheduled before sending the draft.",
    );
  }
  return key;
}
