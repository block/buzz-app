import type { Contribution } from "../../plugins/contributions";
import type {
  SendDraft,
  SendTransform,
  SendTransformContext,
} from "../conversation/contracts";

/** The message `winner` sends instead, or `null` when it consumed the draft.
 * Throws, naming the plugin, to block the send. Settles when the send is
 * aborted even if the plugin ignores `signal`; a late result is discarded. */
export async function transformSend(
  winner: Contribution<SendTransform>,
  draft: SendDraft,
  context: SendTransformContext,
): Promise<SendDraft | null> {
  const { signal } = context;
  signal.throwIfAborted();
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    const result: unknown = await Promise.race([
      (async () => winner.transform(draft, context))(),
      aborted,
    ]);
    signal.throwIfAborted();
    const sent = sendDraft(result);
    if (!sent) throw new Error(`${winner.title} returned an invalid message.`);
    return sent.text.trim() ? sent : null;
  } catch (reason) {
    if (signal.aborted) throw reason;
    throw new Error(
      `${winner.pluginId}: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function sendDraft(value: unknown): SendDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { text, mentions } = value as Record<string, unknown>;
  if (typeof text !== "string" || !Array.isArray(mentions)) return undefined;
  // Read each field once: a getter or Proxy must not change after validation.
  const copies = mentions.map((item: unknown) => {
    const { pubkey, name } = (item ?? {}) as Record<string, unknown>;
    return { pubkey, name };
  });
  const valid = copies.every(
    (item) =>
      typeof item.pubkey === "string" &&
      /^[0-9a-f]{64}$/.test(item.pubkey) &&
      typeof item.name === "string",
  );
  // Recipients need a message: Buzz never publishes one without text.
  if (!valid || (!text.trim() && copies.length)) return undefined;
  return {
    text,
    mentions: [
      ...new Map(
        (copies as { pubkey: string; name: string }[]).map((item) => [
          item.pubkey,
          item,
        ]),
      ).values(),
    ],
  };
}

type Recipient = Readonly<{ pubkey: string; name: string }>;

/**
 * The recipients a transform returned, held to the rules of typed mentions:
 * at most 32, each new one admitted by the composer, and named from host data
 * (`nameOf`), never by the plugin, so a prompt cannot show one person's name
 * for another's key. Someone the send already addressed keeps their name.
 * Throws, naming the plugin, when the send must not go out. `mayAdd` is false
 * where a send cannot take anyone new (a Solo chat).
 */
export function transformRecipients(
  winner: Pick<Contribution<SendTransform>, "pluginId">,
  returned: readonly Recipient[],
  typed: readonly Recipient[],
  rules: {
    mayAdd: boolean;
    admitted(pubkey: string): boolean;
    nameOf(pubkey: string): string | undefined;
  },
): Recipient[] {
  const fail = (why: string) => new Error(`${winner.pluginId}: ${why}`);
  if (returned.length > 32)
    throw fail("tagged more than 32 recipients, the most a message can have.");
  return returned.map(({ pubkey }) => {
    const own = typed.find((person) => person.pubkey === pubkey);
    if (own) return { pubkey, name: own.name };
    if (!rules.mayAdd)
      throw fail(
        "tried to tag someone you did not choose. A Solo chat sends only to the agents you choose.",
      );
    const name = rules.admitted(pubkey) ? rules.nameOf(pubkey) : undefined;
    if (!name) throw fail("tagged someone who can't be tagged here.");
    return { pubkey, name };
  });
}
