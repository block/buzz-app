import type { ChannelMessage } from "../relay/contracts";

export const DELIVERY_GRACE_MS = 10_000;
export function deliveryFeedback(
  row: Pick<ChannelMessage, "delivery" | "createdAt" | "deliveryError">,
  now: number,
) {
  if (
    !row.delivery ||
    row.delivery === "seen" ||
    // Only an unconfirmed send waits; a failed one is already known.
    (row.delivery !== "failed" &&
      now < row.createdAt * 1000 + DELIVERY_GRACE_MS)
  )
    return undefined;
  if (row.delivery === "failed")
    // The relay refuses a reply whose thread moved to a named conversation.
    return row.deliveryError?.includes("reply parent not found")
      ? "Couldn’t send. This thread moved to another conversation."
      : "Couldn’t send this message.";
  return row.deliveryError
    ? `Delivery not yet confirmed. ${row.deliveryError}`
    : "Delivery not yet confirmed.";
}
