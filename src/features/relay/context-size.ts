/** The tag an agent's message carries with the posting session's context
 * size: the tokens of its last model call, as a decimal count. Signed once
 * with the message and never edited, it stays out of the message text. */
export const CONTEXT_TAG = "buzz:context";

/** The tag for a context of `tokens`, or none when the size is unknown. */
export const contextTags = (tokens: number | undefined): string[][] =>
  tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0
    ? [[CONTEXT_TAG, String(tokens)]]
    : [];
