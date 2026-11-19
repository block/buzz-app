import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { EventData } from "../relay/events";
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
  const subscribe = useCallback(
    (listener: () => void) =>
      channelId ? store.subscribe(channelId, listener) : noSubscribe(),
    [store, channelId],
  );
  const snapshot = () => (channelId ? store.snapshot(channelId) : LOADING_PINS);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type PinnedMessages = Readonly<{
  status: "loading" | "ready" | "error";
  /** Loaded pins in list order; ids that did not load are left out. */
  rows: readonly ChannelMessage[];
}>;

/** An open panel also reloads on this period, so a message erased without a
 * list change leaves it. Jittered so open panels do not read together. */
const REFRESH_MS = 10 * 60_000;
/** Deletions in the channel reload the rows, since one may withdraw an edit
 * a row shows; edits reload the rows they name. */
const DELETION_KINDS = [5, 9005];
const EDIT_KIND = 40003;

/** Loads the rows behind `ids` when the list changes, when one of them is
 * edited or deleted, on `attempt`, and periodically. Earlier rows the list
 * still names stay shown while a reload runs or after it fails. */
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
    const wanted = new Set(key ? key.split(",") : []);
    const tagged = (event: EventData, name: string, values: Set<string>) =>
      event.tags.some(
        ([tag, value]) => tag === name && !!value && values.has(value),
      );
    const channel = new Set([channelId]);
    // Removing a reaction never changes a row's text.
    const reaction = new Set(["7"]);
    return source.subscribeLive(
      ({ events }) => {
        if (
          wanted.size &&
          events.some((event) =>
            DELETION_KINDS.includes(event.kind)
              ? tagged(event, "h", channel) && !tagged(event, "k", reaction)
              : event.kind === EDIT_KIND && tagged(event, "e", wanted),
          )
        )
          setTick((value) => value + 1);
      },
      { replay: true },
    );
  }, [source, channelId, key]);
  useEffect(() => {
    void tick;
    void attempt;
    const controller = new AbortController();
    const wanted = key ? key.split(",") : [];
    const named = new Set(wanted);
    const kept = (prior: PinnedMessages) =>
      prior.rows.filter((row) => named.has(row.id));
    setState((prior) => ({ status: "loading", rows: kept(prior) }));
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
          setState((prior) => ({ status: "error", rows: kept(prior) }));
      },
    );
    return () => controller.abort();
  }, [source, channelId, key, attempt, tick]);
  return state;
}
