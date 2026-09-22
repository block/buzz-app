import type { ChannelMessage } from "../relay/contracts";

/** Figma 809:12505. Sessions keep their existing, separate product copy. */
export function composerPlaceholder(
  destination: "channel" | "thread" | "dm",
  hasMessages: boolean,
  channelName = "",
) {
  if (destination === "thread") return "Reply in thread";
  if (destination === "dm")
    return hasMessages ? "Message..." : "Start a new message";
  return `Send a message in #${channelName}`;
}

/** Local pending/failed attempts and membership notices are not sent messages. */
export function hasSentMessage(rows: readonly ChannelMessage[]) {
  return rows.some(
    (row) =>
      !row.membership &&
      (!row.delivery || row.delivery === "accepted" || row.delivery === "seen"),
  );
}
