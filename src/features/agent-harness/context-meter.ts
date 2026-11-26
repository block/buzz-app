// A harness session's context size: the tokens of its last model call, as the
// harness last reported them. Each harness only feeds in its own number, from
// whatever its protocol reports per model call; the Buzz tools stamp every
// message the session posts with it (`BuzzClient.contextTokens`).

/** A count a harness reported, or undefined for a missing, malformed or zero
 * one: a session that has made no call yet has no size. */
export const contextSize = (tokens: unknown) =>
  typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0
    ? tokens
    : undefined;

/** One session's context size. A report without a size keeps the last one. */
export class ContextMeter {
  private last: number | undefined;
  report(tokens: unknown) {
    this.last = contextSize(tokens) ?? this.last;
  }
  /** The tokens of the session's last model call; undefined until known. */
  get tokens() {
    return this.last;
  }
}

/** The context sizes of the sessions one harness process serves, by its own
 * session or thread id. */
export class ContextMeters {
  private readonly sizes = new Map<string, number>();
  report(session: string, tokens: unknown) {
    const size = contextSize(tokens);
    if (size !== undefined) this.sizes.set(session, size);
  }
  tokens(session: string | undefined) {
    return session === undefined ? undefined : this.sizes.get(session);
  }
  /** Drops a session the process no longer serves. */
  forget(session: string) {
    this.sizes.delete(session);
  }
  clear() {
    this.sizes.clear();
  }
}
