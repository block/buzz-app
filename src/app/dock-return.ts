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
 * once (the revealed message, Members, Forward). `last` is the place that
 * visit settled on when its page recorded one, such as the thread its reader
 * verified. A thread reopens at its root, and only a verified root: a link's
 * root is a hint, so an unconfirmed thread reopens its channel. Nothing when
 * that visit was in another account or community, or now belongs to another
 * app; the dock then opens the app's own page.
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
    messageId,
    threadRootId,
    panel: _panel,
    forward: _forward,
    ...place
  } = last;
  return threadRootId && threadRootId === messageId
    ? { ...place, messageId, threadRootId }
    : place;
}
