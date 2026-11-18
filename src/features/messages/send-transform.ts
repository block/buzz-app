import type { Contribution } from "../../plugins/contributions";
import type {
  SendDraft,
  SendTransform,
  SendTransformContext,
} from "../conversation/contracts";

/** The message `winner` sends instead, or `null` when it consumed the draft.
 * Throws to block the send. */
export async function transformSend(
  winner: Contribution<SendTransform>,
  draft: SendDraft,
  context: SendTransformContext,
): Promise<SendDraft | null> {
  const result: unknown = await winner.transform(draft, context);
  context.signal.throwIfAborted();
  const sent = sendDraft(result);
  if (!sent) throw new Error(`${winner.title} returned an invalid message.`);
  return sent.text.trim() ? sent : null;
}

function sendDraft(value: unknown): SendDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { text, mentions = [] } = value as Record<string, unknown>;
  if (typeof text !== "string" || !Array.isArray(mentions)) return undefined;
  const valid = mentions.every((item: unknown) => {
    const { pubkey, name } = (item ?? {}) as Record<string, unknown>;
    return (
      typeof pubkey === "string" &&
      /^[0-9a-f]{64}$/.test(pubkey) &&
      typeof name === "string"
    );
  });
  // Recipients need a message: Buzz never publishes one without text.
  if (!valid || (!text.trim() && mentions.length)) return undefined;
  return {
    text,
    mentions: [
      ...new Map(
        (mentions as SendDraft["mentions"]).map(({ pubkey, name }) => [
          pubkey,
          { pubkey, name },
        ]),
      ).values(),
    ],
  };
}
