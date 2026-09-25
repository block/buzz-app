import { randomUUID } from "node:crypto";

/** Idempotent participant-set command. Keys stay in the broker. */
export async function directMessageEvent(input, viewer, signer, signal) {
  if (
    !input ||
    !Array.isArray(input.pubkeys) ||
    input.pubkeys.length < 1 ||
    input.pubkeys.length > 8 ||
    input.pubkeys.some(
      (value) =>
        typeof value !== "string" ||
        !/^[0-9a-f]{64}$/.test(value) ||
        value === viewer,
    ) ||
    new Set(input.pubkeys).size !== input.pubkeys.length
  )
    throw new Error("Choose between one and eight other people.");
  return signer.signEvent(
    {
      kind: 41010,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...input.pubkeys.map((pubkey) => ["p", pubkey]),
        ["client", randomUUID()],
      ],
    },
    signal,
  );
}

export function directMessageReceipt(text, eventId) {
  const receipt = JSON.parse(text);
  if (
    receipt?.event_id !== eventId ||
    receipt.accepted !== true ||
    typeof receipt.message !== "string" ||
    !receipt.message.startsWith("response:")
  )
    throw new Error("The direct message could not be opened. Try again.");
  const result = JSON.parse(receipt.message.slice(9));
  if (
    typeof result?.channel_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      result.channel_id,
    )
  )
    throw new Error("The relay returned an invalid direct message.");
  return { channelId: result.channel_id };
}
