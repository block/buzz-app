import type { ChannelMessage } from "../relay/contracts";
import {
  readView,
  subscribeView,
  viewScopePurgeToken,
  viewRevision,
  writeView,
} from "../../shared/view-state";

const viewKey = "collapsed-media";
const limit = 500;
type PageGroups = {
  keys: string[];
  purgeToken: string | null | undefined;
  savedRevision: string | null | undefined;
};
const pageGroups = new Map<string | undefined, PageGroups>();
const pageChanges = new EventTarget();
const pageEvent = (scope: string | undefined) => JSON.stringify([scope]);

// A blocked storage read cannot establish that a saved value changed.
function changedSince(
  before: string | null | undefined,
  now: string | null | undefined,
) {
  return before !== undefined && now !== undefined && before !== now;
}

function groups(scope: string | undefined): string[] {
  const unsaved = pageGroups.get(scope);
  if (unsaved) {
    if (
      scope === undefined ||
      (!changedSince(unsaved.purgeToken, viewScopePurgeToken(scope)) &&
        !changedSince(unsaved.savedRevision, viewRevision(scope, viewKey)))
    )
      return unsaved.keys;
    pageGroups.delete(scope);
  }
  if (scope === undefined) return [];
  const saved = readView<unknown>(scope, viewKey, []);
  return Array.isArray(saved)
    ? saved.filter((key): key is string => typeof key === "string")
    : [];
}

export function mediaCollapsed(scope: string | undefined, key: string) {
  return groups(scope).includes(key);
}

export function setMediaCollapsed(
  scope: string | undefined,
  key: string,
  collapsed: boolean,
) {
  const saved = groups(scope);
  if (saved.includes(key) === collapsed) return;
  const next = collapsed
    ? [...saved.slice(1 - limit), key]
    : saved.filter((group) => group !== key);
  // A successful write notifies synchronously. Its readers must see the saved list.
  pageGroups.delete(scope);
  if (scope !== undefined && writeView(scope, viewKey, next)) return;
  pageGroups.set(scope, {
    keys: next,
    purgeToken: scope === undefined ? undefined : viewScopePurgeToken(scope),
    savedRevision:
      scope === undefined ? undefined : viewRevision(scope, viewKey),
  });
  pageChanges.dispatchEvent(new Event(pageEvent(scope)));
}

export function subscribeCollapsedMedia(
  scope: string | undefined,
  listener: () => void,
) {
  const stop =
    scope === undefined
      ? undefined
      : subscribeView(
          scope,
          (key, removed) => {
            if (
              key === viewKey ||
              removed?.some((entry) => entry.key === viewKey)
            )
              pageGroups.delete(scope);
            else if (removed) return;
            // A notification with no details can also be an empty draft clear.
            // groups() checks the scope purge token before using the fallback.
            listener();
          },
          viewKey,
        );
  pageChanges.addEventListener(pageEvent(scope), listener);
  return () => {
    stop?.();
    pageChanges.removeEventListener(pageEvent(scope), listener);
  };
}

export function mediaGroupKey(messageId: string, url: string) {
  return JSON.stringify([messageId, url]);
}

// The thread owns each request, including which groups the reader has hidden
// since selecting the timecode. A new thread can safely reuse a request number.
export function createMediaSeek(
  scope: string | undefined,
  row: ChannelMessage,
  seconds: number,
  request: number,
) {
  const keys = row.attachments.map(({ url }) => mediaGroupKey(row.id, url));
  const retiredGroups = new Set<string>();
  return {
    seconds,
    request,
    retiredGroups,
    // Another view can hide the same group while this row is unmounted.
    observeHides() {
      let previous = new Set(groups(scope));
      return subscribeCollapsedMedia(scope, () => {
        const current = new Set(groups(scope));
        for (const key of keys) {
          if (current.has(key) && !previous.has(key)) retiredGroups.add(key);
        }
        previous = current;
      });
    },
  };
}
export type MediaSeek = ReturnType<typeof createMediaSeek>;
