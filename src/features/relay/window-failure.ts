/** What a failed history read rejected with: a `ReadError`, another `Error` or
 * a native string. Map it with `userCopy` (see `historyFailure`); never render
 * it. */
export type WindowFailure = Error | string;

/** A history view keeps the failure itself, so each surface can say what it
 * means. Never empty: a view's `error` also says that a failure happened. */
export function windowFailure(error: unknown): WindowFailure {
  if (error instanceof Error || (typeof error === "string" && error))
    return error;
  return new Error(
    error === undefined || error === null ? "Unknown failure" : String(error),
  );
}
