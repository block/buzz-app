import { getLogger } from "../developer/logging";

const log = getLogger("relay");
/** Controlled by the development log level, alongside broker traffic. */
export function relayDebug(...parts: readonly unknown[]): void {
  log.debug(...parts);
}
