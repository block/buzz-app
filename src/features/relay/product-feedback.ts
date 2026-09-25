import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";
import { attachmentMessage, type UploadedAttachment } from "./attachments";

/** Private deployment inbox protocol. No channel tag, event view, or NIP-56 report. */
export const PRODUCT_FEEDBACK_KIND = 42000;
export type FeedbackCategory = "bug" | "praise" | "needs-work";

export function feedbackEvent(
  message: string,
  category: FeedbackCategory | null,
  attachments: readonly UploadedAttachment[] = [],
  origin?: string,
) {
  const payload = attachments.length
    ? attachmentMessage(message, attachments, origin)
    : { content: message.trim(), tags: [] as string[][] };
  const { content } = payload;
  const tags = [...(category ? [["category", category]] : []), ...payload.tags];
  const input = { kind: PRODUCT_FEEDBACK_KIND, content, tags };
  if (
    !message.trim() ||
    !content ||
    byteSize(input) > OUTBOX_INPUT_MAX_BYTES ||
    new TextEncoder().encode(JSON.stringify(tags)).length > 64 * 1024
  )
    throw new Error("Feedback must contain text and fit within relay limits.");
  return input;
}
