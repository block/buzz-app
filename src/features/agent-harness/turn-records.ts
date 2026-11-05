// Buzz messages in a turn's prompt as exact JSON records, the same for every
// runtime. A protection plugin re-encodes them exactly, which is how it finds
// each message to check, and remember, on its own.
import type { EventData } from "../relay/events";

/** JSON with `<` and `>` escaped, so no text in it opens or closes a section. */
export const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

/** A message with its author's name beside its pubkey, so an agent can read
 * who wrote it and write the same name to tag them. A protection plugin checks
 * the name with the rest of the text; it is not part of the signed event. */
export function withAuthor<T extends { id: string; pubkey: string }>(
  message: T,
  author: string | undefined,
) {
  if (!author) return message;
  const { id, pubkey, ...rest } = message;
  return { id, pubkey, author, ...rest };
}

/** The event a turn is for, then what it asks of the agent. */
export const eventBody = (event: EventData, request: string, author?: string) =>
  `${quoted(withAuthor(event, author))}\nRequest: ${quoted(request)}`;

/** Who sent the event in an `eventBody`, and its request; undefined for any
 * other text. */
export function readEventBody(body: string) {
  const match = /^(\{[^\n]*\})\nRequest: ("[^\n]*")$/.exec(body);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const event: unknown = JSON.parse(match[1]);
    const request: unknown = JSON.parse(match[2]);
    const pubkey = (event as { pubkey?: unknown } | null)?.pubkey;
    return typeof pubkey === "string" && typeof request === "string"
      ? { pubkey, request }
      : undefined;
  } catch {
    return undefined;
  }
}
