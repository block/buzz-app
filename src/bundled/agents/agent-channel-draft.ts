import {
  mentionDraft,
  type MentionDraft,
  type MentionRecipient,
} from "../../features/messages/mention-draft";
import { readView, writeView } from "../../shared/view-state";

/** Explicit Use in channel intent only. Preserve all existing prose and exact recipients. */
export function appendAgentMention(
  value: unknown,
  recipient: MentionRecipient,
): MentionDraft {
  const draft = mentionDraft(value);
  if (!/^[a-f0-9]{64}$/.test(recipient.pubkey) || !recipient.name.trim())
    throw new Error("This agent has no valid mention identity.");
  if (draft.recipients.some((item) => item.pubkey === recipient.pubkey))
    return draft;
  if (draft.recipients.length >= 32)
    throw new Error(
      "This draft already has 32 recipients. Open the channel and remove one first.",
    );
  const prefix = draft.text && !/\s$/.test(draft.text) ? " " : "";
  const start = draft.text.length + prefix.length;
  const text = `${draft.text}${prefix}@${recipient.name} `;
  if (text.length > 16000)
    throw new Error(
      "This draft is too long to add a mention. Open the channel and shorten it first.",
    );
  return mentionDraft({
    text,
    recipients: [
      ...draft.recipients,
      { ...recipient, start, end: text.length - 1 },
    ],
  });
}
export function prepareAgentDraft(
  scope: string,
  channelId: string,
  recipient: MentionRecipient,
) {
  const key = `draft:${channelId}`;
  // Unlike ordinary composer restoration, failed reads must not become an empty
  // draft here: this action is only allowed to append to existing user intent.
  let previous: unknown;
  try {
    previous = JSON.parse(
      localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`) ??
        '""',
    );
    if (
      typeof previous !== "string" &&
      (!previous ||
        typeof previous !== "object" ||
        !("text" in previous) ||
        typeof previous.text !== "string")
    )
      throw new Error();
  } catch {
    throw new Error(
      "Could not read the existing draft. Open the channel and select the agent from the @ picker instead.",
    );
  }
  const next = appendAgentMention(previous, recipient);
  writeView(scope, key, next);
  if (JSON.stringify(readView(scope, key, null)) !== JSON.stringify(next))
    throw new Error(
      "Could not save the mention draft. Open the channel and select the agent from the @ picker instead.",
    );
}
