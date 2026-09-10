export type ReadErrorKind =
  | "cancelled"
  | "denied"
  | "unavailable"
  | "invalid-response";
export class ReadError extends Error {
  constructor(
    readonly kind: ReadErrorKind,
    message: string,
    readonly status?: number,
    /** Host API admission delay, not proof of history completeness or denial. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ReadError";
  }
}
export function httpReadError(status: number) {
  return new ReadError(
    status === 401 || status === 403 ? "denied" : "unavailable",
    `Relay read failed (${status})`,
    status,
  );
}
/** Shared taxonomy for broker, signed transport and query lifecycle. The exact
 * legacy fixture phrase is accepted during migration, not arbitrary status text. */
export function readErrorKind(error: unknown): ReadErrorKind {
  if (error instanceof ReadError) return error.kind;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (
    error instanceof Error &&
    /^Relay read failed \((401|403)\)$/.test(error.message)
  )
    return "denied";
  return "unavailable";
}
