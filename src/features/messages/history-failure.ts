import { failureKind, userCopy } from "../relay/user-copy";

/** A refused read whose reason Buzz doesn't recognize still says why. */
const NO_ACCESS = "You don’t have access to this conversation.";

/** Opens Settings → Software updates through a conversation's `onOpenLink`. */
export const UPDATES_LINK = "buzz://settings?section=updates";

export type HistoryFailure = Readonly<{
  text: string;
  /** Offer "Try again": the same read can succeed. */
  retry: boolean;
  /** Offer "Check for updates": this Buzz can't use the answer, and the same
   * read fails again. */
  update: boolean;
}>;

/** What a failed history read (a `WindowFailure`, or nothing) says on the surface that shows it. `context` is
 * the surface's own sentence, such as "Messages didn’t load.", and is the
 * whole text for a connection failure, timeout, unusable answer or unknown
 * failure. A busy Buzz or a refusal adds its reason. */
export function historyFailure(
  error: unknown,
  context: string,
): HistoryFailure {
  const copy = userCopy(error, context);
  const kind = failureKind(error);
  if (kind === "unusable") return { text: context, retry: false, update: true };
  // Refused keeps the helper's text, the context plus a known reason, and
  // otherwise says the conversation isn't open to this account.
  const text =
    kind === "refused"
      ? copy.text === context
        ? `${context} ${NO_ACCESS}`
        : copy.text
      : kind === "busy"
        ? copy.text
        : context;
  return { text, retry: copy.retry, update: false };
}
