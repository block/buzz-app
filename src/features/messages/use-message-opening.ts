import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelQueries, ChannelWindow } from "../relay/contracts";

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
 * decides nothing; a failed read decides on what it has. Each request decides
 * once, so later arrivals do not switch it. `request` asks again for the same
 * message.
 */
export function useMessageOpening(
  channels: ChannelQueries,
  channelId: string,
  messageId: string | undefined,
  request?: number,
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
  useEffect(() => {
    if (seeking) channels.ensure(channelId);
  }, [channels, channelId, seeking]);
  const [decided, setDecided] = useState<{
    key: string;
    inTimeline: boolean;
  }>();
  const pages = useRef({ key, count: 0 });
  if (pages.current.key !== key) pages.current = { key, count: 0 };
  // Cached rows may be stale: wait for verified history or a settled failure.
  const deciding =
    !!key &&
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
  // A page or head read in flight can still change the answer.
  const busy = window.loadingOlder || !!window.refreshing;
  if (key && deciding && (found || (!busy && !seekable)))
    setDecided({ key, inTimeline: found });
  useEffect(() => {
    if (!key || !deciding || found || !seekable || busy) return;
    channels.loadOlder(channelId);
    const after = channels.window(channelId);
    if (after.loadingOlder) pages.current.count += 1;
    // Declined with no read in flight: no page will come.
    else if (!after.refreshing) setDecided({ key, inTimeline: false });
  }, [key, deciding, found, seekable, busy, channels, channelId]);
  return key && decided?.key === key ? decided.inTimeline : undefined;
}
