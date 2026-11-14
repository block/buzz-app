import type { RegisteredPage } from "../features/pages/service";
import type {
  NavigationScope,
  OpenTarget,
} from "../features/navigation/targets";
import { navigationOwner } from "./shell/presentation";

const channelsKey = "buzz.channels/channels";

/** The dock app a visit belongs to: Activity and conversations belong to
 * Messages. Settings, links and pages no longer registered belong to none. */
export function dockOwner(
  pages: readonly RegisteredPage[],
  target: OpenTarget,
): string | undefined {
  const key =
    target.kind === "page"
      ? `${target.pluginId}/${target.pageId}`
      : target.kind === "conversation"
        ? channelsKey
        : undefined;
  return key && pages.some((page) => page.key === key)
    ? navigationOwner(pages, key)
    : undefined;
}

/**
 * Where the dock reopens `owner`: its last visit, without the parts that act
 * once (Members, Forward, and the context it was opened with). A conversation
 * keeps its message, so its reader finds the thread again, as following the
 * link again does. A thread root keeps its thread; a reply drops its thread
 * hint and is placed by the reader alone. Nothing when that visit was in another
 * account or community, or now belongs to another app; the dock then opens
 * the app's own page.
 */
export function dockReturn(
  pages: readonly RegisteredPage[],
  owner: string,
  last: OpenTarget | undefined,
  scope: NavigationScope | null,
): OpenTarget | undefined {
  if (!last || dockOwner(pages, last) !== owner || !("scope" in last)) return;
  const was = last.scope;
  if (
    was === undefined ||
    (was === null
      ? scope !== null
      : scope === null ||
        was.viewer !== scope.viewer ||
        was.communityOrigin !== scope.communityOrigin)
  )
    return;
  if (last.kind !== "conversation") return last;
  const {
    panel: _panel,
    forward: _forward,
    context: _context,
    threadRootId,
    ...place
  } = last;
  // A reply's thread root is only a hint, and a wrong one can fold another
  // open thread away. The reply alone lets its reader find its thread.
  return threadRootId && threadRootId === place.messageId
    ? { ...place, threadRootId }
    : place;
}
