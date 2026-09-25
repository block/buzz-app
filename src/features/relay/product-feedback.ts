import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";

/** Private deployment inbox protocol. No channel tag, event view, or NIP-56 report. */
export const PRODUCT_FEEDBACK_KIND = 42000;
export type FeedbackCategory = "bug" | "praise" | "needs-work";

export function feedbackEvent(
  message: string,
  category: FeedbackCategory | null,
) {
  const input = {
    kind: PRODUCT_FEEDBACK_KIND,
    content: message.trim(),
    tags: category ? [["category", category]] : [],
  };
  if (!input.content || byteSize(input) > OUTBOX_INPUT_MAX_BYTES)
    throw new Error("Feedback must contain text and fit within relay limits.");
  return input;
}
