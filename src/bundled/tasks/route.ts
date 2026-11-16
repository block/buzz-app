// A task's link: `buzz://plugin?id=buzz.tasks&route.task=<id>`. It opens the
// Tasks page with the task, in whichever community the link is opened, and
// grants nothing: the reader sees the task only if they already can.
import type { JsonValue } from "../../features/navigation/targets";
import { isChannelId } from "./model";

export const PLUGIN_ID = "buzz.tasks";

export const taskLink = (id: string) =>
  `buzz://plugin?id=${PLUGIN_ID}&route.task=${id}`;

/** The task route's params, as the Tasks page accepts them. */
export function taskRoute(params: JsonValue | undefined) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return undefined;
  const { task, ...rest } = params as Readonly<Record<string, JsonValue>>;
  return isChannelId(task) && !Object.keys(rest).length ? task : undefined;
}

/** The task a link names, or null when it isn't a task link. */
export function taskLinkId(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== "buzz:" || url.hostname !== "plugin") return null;
    if (url.pathname !== "" && url.pathname !== "/") return null;
    const keys = [...url.searchParams.keys()];
    if (
      url.searchParams.get("id") !== PLUGIN_ID ||
      keys.length !== 2 ||
      !keys.includes("route.task")
    )
      return null;
    return (
      taskRoute({ task: url.searchParams.get("route.task") ?? "" }) ?? null
    );
  } catch {
    return null;
  }
}
