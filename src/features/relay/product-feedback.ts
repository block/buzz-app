/** Private deployment inbox protocol. No channel tag, event view, or NIP-56 report. */
export const PRODUCT_FEEDBACK_KIND = 42000;
export type FeedbackCategory = "bug" | "praise" | "needs-work";

export function feedbackEvent(
  message: string,
  category: FeedbackCategory | null,
) {
  const content = message.trim();
  if (!content || new TextEncoder().encode(content).length > 32 * 1024)
    throw new Error("Feedback must contain text and fit within 32 KiB.");
  return {
    kind: PRODUCT_FEEDBACK_KIND,
    content,
    tags: category ? [["category", category]] : [],
  };
}
