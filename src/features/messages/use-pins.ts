import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import {
  LOADING_PINS,
  pinLists,
  readPinnedMessages,
  type PinSnapshot,
  type PinSource,
} from "../relay/pins";

const noSubscribe = () => () => {};

/** The channel's pins, newest first. Without a channel it stays loading. */
export function usePinnedMessages(
  source: PinSource,
  channelId: string | undefined,
): PinSnapshot {
  const store = pinLists(source);
  const snapshot = () => (channelId ? store.snapshot(channelId) : LOADING_PINS);
  return useSyncExternalStore(
    channelId
      ? (listener) => store.subscribe(channelId, listener)
      : noSubscribe,
    snapshot,
    snapshot,
  );
}

export type PinnedMessages = Readonly<{
  status: "loading" | "ready" | "error";
  /** Loaded pins in list order; ids that did not load are left out. */
  rows: readonly ChannelMessage[];
}>;

/** An open panel also reloads on this period, so a message erased without a
 * list change leaves it. Jittered so open panels do not read together. */
const REFRESH_MS = 10 * 60_000;

/** Loads the rows behind `ids` when the list changes, on `attempt`, and
 * periodically. Earlier rows stay shown while a reload runs. */
export function usePinnedRows(
  source: PinSource,
  channelId: string,
  ids: readonly string[],
  attempt = 0,
): PinnedMessages {
  const key = ids.join(",");
  const [state, setState] = useState<PinnedMessages>({
    status: "loading",
    rows: [],
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setTick((value) => value + 1),
      REFRESH_MS + Math.random() * 60_000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void tick;
    void attempt;
    const controller = new AbortController();
    const wanted = key ? key.split(",") : [];
    setState((prior) => ({ status: "loading", rows: prior.rows }));
    readPinnedMessages(source, channelId, wanted, controller.signal).then(
      (found) => {
        if (controller.signal.aborted) return;
        setState({
          status: "ready",
          rows: wanted.flatMap((id) => {
            const row = found.get(id);
            return row ? [row] : [];
          }),
        });
      },
      () => {
        if (!controller.signal.aborted)
          setState((prior) => ({ status: "error", rows: prior.rows }));
      },
    );
    return () => controller.abort();
  }, [source, channelId, key, attempt, tick]);
  return state;
}
