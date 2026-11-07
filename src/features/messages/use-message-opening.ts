import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelQueries, ChannelWindow } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

const idle: ChannelWindow = {
  channelId: "",
  status: "idle",
  rows: [],
  hasMore: false,
  loadingOlder: false,
  error: undefined,
};

/** Older pages read, at most, to find a message: 20 top-level rows each. */
export const SEEK_PAGES = 25;

/**
 * How a reader opens at one message: true in the channel timeline, false as
 * its thread, undefined while it decides. A top-level message opens in the
 * timeline once verified history holds it, reading older pages until it loads;
 * a reply, or a message not found, opens as its thread. Cached history alone
 * decides nothing; a failed read decides on what it has. It decides after
 * its own ensure, with no head or page read in flight. Each request decides
 * once, so later arrivals do not switch it. `request` asks again for the same
 * message.
 */
export function useMessageOpening(
  channels: ChannelQueries,
  channelId: string,
  messageId: string | undefined,
  request?: number,
  read?: RelaySession["read"],
): boolean | undefined {
  const key = messageId && JSON.stringify([channelId, messageId, request]);
  // Read the window only to open at a message, so other readers load nothing.
  const seeking = !!key;
  const subscribe = useCallback(
    (listener: () => void) =>
      seeking ? channels.subscribeWindow(channelId, listener) : () => {},
    [channels, channelId, seeking],
  );
  const snapshot = useCallback(
    () => (seeking ? channels.window(channelId) : idle),
    [channels, channelId, seeking],
  );
  const window = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Each request ensures the channel first: past its freshness lease this
  // starts a head refresh, and the window shown before it may be replaced.
  const [ensured, setEnsured] = useState<string>();
  const revalidation = useRef<AbortController | undefined>(undefined);
  const [locating, setLocating] = useState<string>();
  const pages = useRef({ key, count: 0, attached: false });
  if (pages.current.key !== key)
    pages.current = { key, count: 0, attached: false };
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    revalidation.current = controller;
    pages.current = { key, count: 0, attached: false };
    setLocating(undefined);
    channels.ensure(channelId);
    setEnsured(key);
    return () => {
      controller.abort();
      if (revalidation.current === controller) revalidation.current = undefined;
    };
  }, [channels, channelId, key]);
  const [decided, setDecided] = useState<{
    key: string;
    inTimeline: boolean;
  }>();
  // Cached rows may be stale: wait for verified history or a settled failure.
  const deciding =
    !!key &&
    ensured === key &&
    decided?.key !== key &&
    window.status !== "idle" &&
    window.status !== "loading" &&
    !(
      window.status === "ready" &&
      window.freshness === "cached" &&
      !window.error
    );
  const verified = window.status === "ready" && window.freshness !== "cached";
  const row = verified
    ? window.rows.find((row) => row.id === messageId)
    : undefined;
  const found = !!row && !row.threadRootId;
  const seekable =
    verified &&
    !row &&
    !window.error &&
    window.hasMore &&
    !window.historyLimited &&
    pages.current.count < SEEK_PAGES;
  const needsHead =
    !!key &&
    ensured === key &&
    decided?.key !== key &&
    !pages.current.attached &&
    !!channels.attach &&
    (window.hasNewer ||
      (window.status === "ready" &&
        window.freshness === "cached" &&
        !!channels.seek &&
        (!!read || window.rows.some((row) => row.id === messageId)))) &&
    !window.error &&
    (!verified || !row);
  // A page or head read in flight can still change the answer: a refreshed
  // head can drop a message the old one held.
  const busy =
    window.loadingOlder ||
    !!window.loadingNewer ||
    !!window.refreshing ||
    locating === key;
  if (key && deciding && !needsHead && !busy && (found || !seekable))
    setDecided({ key, inTimeline: found });
  useEffect(() => {
    if (!key || busy) return;
    if (needsHead) {
      pages.current.attached = true;
      const retained = window.rows.find((row) => row.id === messageId);
      const controller = revalidation.current;
      if (!verified && retained && channels.seek && controller) {
        setLocating(key);
        void channels
          .seek(channelId, retained.createdAt, controller.signal, retained.id)
          .then((validated) => {
            if (
              !controller.signal.aborted &&
              (validated !== messageId ||
                channels.window(channelId).freshness === "cached" ||
                !channels
                  .window(channelId)
                  .rows.some(
                    (row) => row.id === messageId && !row.threadRootId,
                  ))
            )
              setDecided({ key, inTimeline: false });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setDecided({ key, inTimeline: false });
          })
          .finally(() => {
            if (!controller.signal.aborted) setLocating(undefined);
          });
        return;
      }
      if (!retained && messageId && read && channels.seek && controller) {
        // Resolve the target before replacing a useful older edge with the head.
        setLocating(key);
        void read([{ ids: [messageId], "#h": [channelId], limit: 1 }], {
          signal: controller.signal,
        })
          .then(async (events) => {
            if (controller.signal.aborted) return;
            const target = events.find(
              (event) =>
                event.id === messageId &&
                event.tags.some(
                  ([name, id]) => name === "h" && id === channelId,
                ),
            );
            if (!target) {
              setDecided({ key, inTimeline: false });
              return;
            }
            const validated = await channels.seek?.(
              channelId,
              target.created_at,
              controller.signal,
              target.id,
              true,
            );
            if (
              !controller.signal.aborted &&
              (validated !== messageId ||
                channels.window(channelId).freshness === "cached" ||
                !channels
                  .window(channelId)
                  .rows.some(
                    (row) => row.id === messageId && !row.threadRootId,
                  ))
            )
              setDecided({ key, inTimeline: false });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setDecided({ key, inTimeline: false });
          })
          .finally(() => {
            if (!controller.signal.aborted) setLocating(undefined);
          });
        return;
      }
      channels.attach?.(channelId);
      if (!channels.window(channelId).refreshing)
        setDecided({ key, inTimeline: false });
      return;
    }
    if (!deciding || found || !seekable) return;
    channels.loadOlder(channelId);
    const after = channels.window(channelId);
    if (after.loadingOlder) pages.current.count += 1;
    // Declined with no read in flight: no page will come.
    else if (!after.refreshing) setDecided({ key, inTimeline: false });
  }, [
    key,
    deciding,
    found,
    seekable,
    needsHead,
    busy,
    channels,
    channelId,
    window.rows,
    verified,
    messageId,
    read,
  ]);
  return key && decided?.key === key ? decided.inTimeline : undefined;
}
