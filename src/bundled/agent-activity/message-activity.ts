import { requestWork } from "../../features/agents/request-work";

/** Message and thread displays project the same request status. Pulses alone
 * cannot establish which individual message triggered work. */
export function messageActivity(...args: Parameters<typeof requestWork>) {
  return requestWork(...args).filter(
    ({ state }) => state === "working" || state === "unknown",
  );
}
