import type { OutgoingEvent } from "../relay/outbox";

/** A refused retry cannot prove an earlier uncertain publication never landed. */
export function isDefinitiveCanvasConflict(
  operation: OutgoingEvent | undefined,
): boolean {
  return (
    operation?.event.kind === 40100 &&
    operation.delivery === "failed" &&
    operation.error?.startsWith("conflict:") === true
  );
}
