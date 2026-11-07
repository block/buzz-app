import {
  requestWork,
  type RequestWork,
} from "../../features/agents/request-work";

const live = ({ state, lifecycle, dismissed }: RequestWork) =>
  lifecycle
    ? state !== "done" &&
      state !== "superseded" &&
      state !== "stopped" &&
      !dismissed
    : state === "working" || state === "unknown" || state === "error";

/** Message and thread displays project the same request status. Pulses alone
 * cannot establish which individual message triggered work. */
export function messageActivity(...args: Parameters<typeof requestWork>) {
  return messageWork(...args).live;
}

/** Live work, and the settled local requests that stay noted under their
 * message until it is handled again: those the owner stopped, and finished
 * ones with a notice about how they ran. */
export function messageWork(...args: Parameters<typeof requestWork>) {
  const work = requestWork(...args);
  return {
    live: work.filter(live),
    stopped: work.filter(
      ({ state, notice }) =>
        state === "stopped" || (state === "done" && !!notice),
    ),
  };
}
