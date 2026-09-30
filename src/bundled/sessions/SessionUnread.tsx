import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ReadTarget } from "../../features/relay/read-state-model";
import type { UnreadCapability } from "../../features/relay/unread";
import styles from "./SessionUnread.module.css";

type UnreadSource = Pick<UnreadCapability, "snapshot" | "subscribe">;

function useUnread(source: UnreadSource, target: ReadTarget) {
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(target, listener),
    [source, target],
  );
  const snapshot = useCallback(() => source.snapshot(target), [source, target]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Personal observed evidence only. Subscriptions never fetch or acknowledge. */
export function SessionUnread({
  unread,
  channelId,
  rootId,
}: {
  unread: UnreadSource;
  channelId: string;
  rootId: string;
}) {
  const targets = useMemo(
    () => ({
      root: { kind: "message", channelId, messageId: rootId } as const,
      thread: { kind: "thread", channelId, rootId } as const,
    }),
    [channelId, rootId],
  );
  // Thread evidence includes replies only; the original root is independent.
  // OR the positive signals rather than manufacturing a combined exact count.
  const root = useUnread(unread, targets.root);
  const thread = useUnread(unread, targets.thread);
  const states = [root, thread];
  const manual = states.some((state) => state.manual !== "none");
  const positiveObserved = states.filter(
    (state) => state.observedCount !== null && state.observedCount > 0,
  );
  const observed = positiveObserved.length > 0;
  if (!manual && !observed) return null;
  const labels: string[] = [];
  if (states.some((state) => state.manual === "local-only"))
    labels.push("Marked unread on this device only");
  if (states.some((state) => state.manual === "remote"))
    labels.push("Marked unread");
  if (observed)
    labels.push(
      positiveObserved.some((state) => state.freshness === "stale")
        ? "Observed unread messages; may be out of date. Not an exact total."
        : "Observed unread messages. Not an exact total.",
    );
  const label = labels.join(". ");
  return (
    <span
      className={styles.dot}
      data-session-unread=""
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
