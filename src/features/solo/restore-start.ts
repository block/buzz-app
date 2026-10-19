import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import {
  attachmentDraft,
  clearAttachmentDraft,
  transferAttachmentDraft,
} from "../messages/attachment-draft";
import { notifyRecovered } from "../messages/composer-recovery";
import { withdraw } from "./withdraw";

/** Where a start keeps its first message's files until the relay confirms
 * the chat, so a refused start can hand them back. */
export function startFilesKey(scope: string, channelId: string) {
  return `${scope}:start:${channelId}`;
}

/** Whether a saved draft holds nothing typed: the composer's automatic agent
 * tag alone counts as empty. */
function blankDraft(saved: unknown) {
  const { text, recipients } = mentionDraft(saved);
  let rest = text;
  for (const { start, end } of [...recipients].sort(
    (a, b) => b.start - a.start,
  ))
    rest = rest.slice(0, start) + rest.slice(end);
  return !rest.trim();
}

/** One draft holding `drafts` in order, a blank line apart, tags kept. */
function joinDrafts(...drafts: readonly MentionDraft[]): MentionDraft {
  let text = "";
  const recipients: MentionDraft["recipients"][number][] = [];
  const sessionCards: string[] = [];
  for (const draft of drafts) {
    if (blankDraft(draft)) continue;
    if (text) text = `${text.trimEnd()}\n\n`;
    const offset = text.length;
    text += draft.text;
    for (const item of draft.recipients)
      recipients.push({
        ...item,
        start: item.start + offset,
        end: item.end + offset,
      });
    sessionCards.push(...(draft.sessionCards ?? []));
  }
  return {
    text,
    recipients,
    ...(sessionCards.length
      ? { sessionCards: [...new Set(sessionCards)] }
      : {}),
  };
}

/** Hands a start that made no chat back to New chat: what the chat held
 * (its first message if it was sent, then later messages, then anything typed
 * there and not sent) joins the New chat draft, and the files join the
 * attachments of whichever New chat composer owns that draft now. The
 * composer's own recovery notice shows them and `reason`. */
export async function restoreStart(
  session: RelaySession,
  {
    scope,
    draftKey,
    channelId,
    create,
    first,
    settings,
    project,
    reason,
  }: {
    scope: string;
    /** The New chat draft's key, such as `solo` or `solo:project:<id>`. */
    draftKey: string;
    channelId: string;
    create: string;
    /** The first message's id and draft, when it was sent. */
    first: { id: string; draft: MentionDraft } | undefined;
    settings: { name: unknown; canvas: unknown; ttlSeconds: unknown };
    project: string;
    reason: Error;
  },
) {
  const outbox = session.outbox;
  // Everything sent in the chat was held for its create: withdraw it all.
  const held = (outbox?.snapshot() ?? []).filter(
    (item) =>
      item.event.id !== create &&
      item.event.tags.some(
        ([tag, value]) => tag === "h" && value === channelId,
      ),
  );
  await Promise.all([
    ...held.map((item) =>
      outbox ? withdraw(outbox, item.event.id).catch(() => {}) : undefined,
    ),
    session.channelWrites.failed(create) &&
      session.channelWrites.discardFailed(create).catch(() => {}),
  ]);
  const later = held
    .filter((item) => item.event.id !== first?.id && item.event.kind === 9)
    .map((item) => mentionDraft(item.event.content));
  const unsent = mentionDraft(
    readView<unknown>(scope, `draft:${channelId}`, null),
  );
  writeView(scope, `draft:${channelId}`, null);
  const restored = joinDrafts(
    ...(first ? [first.draft] : []),
    ...later,
    unsent,
  );
  const key = `${draftKey}:new-draft`;
  const current = readView<unknown>(scope, key, "");
  // A newer draft there keeps its settings and takes the start after its own
  // text.
  const next = blankDraft(current)
    ? restored
    : joinDrafts(mentionDraft(current), restored);
  writeView(scope, key, next);
  if (blankDraft(current)) {
    writeView(scope, `${draftKey}:settings`, settings);
    writeView(scope, `${draftKey}:new-project`, project || null);
  }
  const files = attachmentDraft(session, `${scope}:${key}`, channelId, true);
  let lost = false;
  for (const source of [
    startFilesKey(scope, channelId),
    `${scope}:draft:${channelId}`,
  ]) {
    try {
      transferAttachmentDraft(
        attachmentDraft(session, source, channelId),
        files,
        true,
      );
    } catch (error) {
      lost = true;
      console.warn("Solo start files could not come back", error);
    }
    clearAttachmentDraft(session, source);
  }
  notifyRecovered(session, `${scope}:${key}`, {
    draft: next,
    preparationError: lost
      ? new Error(
          `${reason.message} Some of its files didn't fit in this draft; attach them again.`,
        )
      : reason,
  });
}
