/** Ephemeral kind 20001, never a durable outbox operation.
 * Publish bare online/away content and no tags. Reads also recognize offline and
 * legacy JSON {"status":"online"|"away"|"offline"}; other values are unknown.
 * Live subject = verified author. Only HTTP snapshots use relay-signed p subjects.
 */
export type PresenceStatus = "online" | "away";
export type PresenceState = Readonly<{
  status: "idle" | "pending" | "ready" | "error";
  /** Confirmed authors when ready; desired authors otherwise. EOSE is not a seed. */
  authors: readonly string[];
  error?: string;
}>;
export type PresenceCapability = {
  update(authors: readonly string[]): void;
  /** Resolves only for matching WS OK. Failure/abort is not evidence of Offline.
   * One in flight; callers coalesce status changes. No transport heartbeat replay. */
  publish(status: PresenceStatus, signal: AbortSignal): Promise<void>;
};
export const PRESENCE_AUTHOR_CAPACITY = 256;
export function presenceAuthors(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > PRESENCE_AUTHOR_CAPACITY ||
    input.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id))
  )
    throw new Error("Invalid presence authors (maximum 256 full public keys)");
  return [...new Set(input as string[])].sort();
}
export function presenceStatus(input: unknown): PresenceStatus {
  if (input !== "online" && input !== "away")
    throw new Error("Invalid presence publication status");
  return input;
}
export function presenceState(input: unknown): PresenceState {
  if (!input || typeof input !== "object")
    throw new Error("Invalid presence state");
  const value = input as PresenceState;
  if (
    !["idle", "pending", "ready", "error"].includes(value.status) ||
    (value.error !== undefined && typeof value.error !== "string")
  )
    throw new Error("Invalid presence state");
  const authors = presenceAuthors(value.authors);
  if ((value.status === "idle") !== (authors.length === 0))
    throw new Error("Invalid presence state authors");
  return Object.freeze({
    status: value.status,
    authors: Object.freeze(authors),
    ...(value.error ? { error: value.error } : {}),
  });
}
