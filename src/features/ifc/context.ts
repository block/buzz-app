import type { RelayEvent } from "../relay/events";

/** Execution context supplied by the app harness for IFC checks. */
export type IfcContext = Readonly<{
  /** Public key of the executing agent. */
  agent: string;
  /** Signed event that caused the turn. */
  trigger: RelayEvent;
}>;
